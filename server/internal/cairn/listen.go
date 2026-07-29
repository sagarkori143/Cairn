package cairn

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"strings"
	"sync"
	"time"
)

// Short-lived keys for live transcription.
//
// Streaming speech-to-text needs a WebSocket held open for the length of an
// utterance, and serverless functions cannot hold one — so the server can't sit
// in the middle relaying audio. The alternative is to let the client talk to
// Deepgram directly, which normally means shipping a credential in an app that
// is a zip archive with a different extension.
//
// Deepgram resolves that with credentials that expire in under a minute. The
// long-lived key never leaves the server, and the worst case for a leaked
// temporary one is a few seconds of someone else's transcription.
//
// There are two ways to get one and they need different account permissions,
// so both are tried in turn:
//
//   - /auth/grant returns a bearer token and is the purpose-built answer.
//   - Creating a scoped, expiring key is the older route, and needs the
//     keys:write scope that only owners and admins hold.
//
// A key with neither permission can still transcribe — the scopes govern
// handing out credentials, not using them — so a read-only key fails here
// while the rest of the server keeps working. The handler says which
// permission is missing rather than reporting a generic upstream fault,
// because the fix is a one-line change in the Deepgram console.

const (
	deepgramAPI = "https://api.deepgram.com/v1"
	// Long enough to open a socket and speak a sentence, short enough that a
	// leaked credential is worthless by the time anyone could use it.
	tokenTTL = 60 * time.Second
)

// errListenScope means the configured key is valid but not allowed to issue
// short-lived credentials. Worth distinguishing: it is the one failure here
// the operator can fix, and it looks identical to a broken key otherwise.
var errListenScope = errors.New("deepgram key cannot issue temporary credentials")

type listenTokenResponse struct {
	Key string `json:"key"`
	// Which WebSocket subprotocol the client should authenticate with.
	// Grant tokens are bearer credentials; minted keys are plain API keys.
	Scheme    string `json:"scheme"`
	ExpiresAt string `json:"expiresAt"`
	Model     string `json:"model"`
}

// projectID is looked up once — it never changes for an account, and paying a
// round trip for it on every voice session would show up as lag before the orb
// even appears.
var (
	projectOnce sync.Once
	projectID   string
	projectErr  error
)

func (d *deepgramClient) project() (string, error) {
	projectOnce.Do(func() {
		req, err := http.NewRequest(http.MethodGet, deepgramAPI+"/projects", nil)
		if err != nil {
			projectErr = err
			return
		}
		req.Header.Set("Authorization", "Token "+d.key)

		res, err := d.client.Do(req)
		if err != nil {
			projectErr = err
			return
		}
		defer res.Body.Close()

		body, _ := io.ReadAll(res.Body)
		if res.StatusCode != http.StatusOK {
			projectErr = fmt.Errorf("deepgram projects %d: %s", res.StatusCode, truncate(string(body), 200))
			return
		}

		var parsed struct {
			Projects []struct {
				ProjectID string `json:"project_id"`
			} `json:"projects"`
		}
		if err := json.Unmarshal(body, &parsed); err != nil {
			projectErr = err
			return
		}
		if len(parsed.Projects) == 0 {
			projectErr = fmt.Errorf("deepgram account has no projects")
			return
		}
		projectID = parsed.Projects[0].ProjectID
	})
	return projectID, projectErr
}

// listenToken returns a credential the client can stream with, preferring the
// endpoint built for the job and falling back to the one that predates it.
func (d *deepgramClient) listenToken() (*listenTokenResponse, error) {
	token, grantErr := d.grantToken()
	if grantErr == nil {
		return token, nil
	}

	token, mintErr := d.mintKey()
	if mintErr == nil {
		return token, nil
	}

	// Both refused on permissions rather than breaking: the key works, it just
	// isn't allowed to delegate. That is worth reporting as its own condition.
	if errors.Is(grantErr, errListenScope) && errors.Is(mintErr, errListenScope) {
		return nil, fmt.Errorf("%w (grant: %v; mint: %v)", errListenScope, grantErr, mintErr)
	}
	return nil, fmt.Errorf("grant: %v; mint: %w", grantErr, mintErr)
}

// grantToken asks Deepgram for a bearer token good for one short session.
func (d *deepgramClient) grantToken() (*listenTokenResponse, error) {
	payload, _ := json.Marshal(map[string]any{
		"ttl_seconds": int(tokenTTL / time.Second),
	})

	req, err := http.NewRequest(http.MethodPost, deepgramAPI+"/auth/grant", bytes.NewReader(payload))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Token "+d.key)
	req.Header.Set("Content-Type", "application/json")

	res, err := d.client.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()

	body, _ := io.ReadAll(res.Body)
	if res.StatusCode != http.StatusOK && res.StatusCode != http.StatusCreated {
		if isPermissionDenied(res.StatusCode) {
			return nil, fmt.Errorf("%w: auth/grant %d", errListenScope, res.StatusCode)
		}
		return nil, fmt.Errorf("deepgram auth/grant %d: %s", res.StatusCode, truncate(string(body), 300))
	}

	var parsed struct {
		AccessToken string `json:"access_token"`
		ExpiresIn   int    `json:"expires_in"`
	}
	if err := json.Unmarshal(body, &parsed); err != nil || parsed.AccessToken == "" {
		return nil, fmt.Errorf("deepgram returned no access token")
	}

	// Trust the server's own expiry over the one that was asked for.
	ttl := tokenTTL
	if parsed.ExpiresIn > 0 {
		ttl = time.Duration(parsed.ExpiresIn) * time.Second
	}

	return &listenTokenResponse{
		Key:       parsed.AccessToken,
		Scheme:    "bearer",
		ExpiresAt: time.Now().UTC().Add(ttl).Format(time.RFC3339),
		Model:     d.model,
	}, nil
}

// isPermissionDenied separates "this key may not do that" from a real fault.
func isPermissionDenied(status int) bool {
	return status == http.StatusForbidden || status == http.StatusUnauthorized
}

// mintKey creates a transcription-only key that expires shortly.
func (d *deepgramClient) mintKey() (*listenTokenResponse, error) {
	pid, err := d.project()
	if err != nil {
		return nil, err
	}

	expires := time.Now().UTC().Add(tokenTTL)
	payload, _ := json.Marshal(map[string]any{
		"comment": "cairn live transcription",
		// usage:write is what streaming needs and nothing more — this key
		// cannot read usage, manage members, or create further keys.
		"scopes":          []string{"usage:write"},
		"expiration_date": expires.Format(time.RFC3339),
	})

	req, err := http.NewRequest(http.MethodPost, deepgramAPI+"/projects/"+pid+"/keys", bytes.NewReader(payload))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Token "+d.key)
	req.Header.Set("Content-Type", "application/json")

	res, err := d.client.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()

	body, _ := io.ReadAll(res.Body)
	if res.StatusCode != http.StatusOK && res.StatusCode != http.StatusCreated {
		if isPermissionDenied(res.StatusCode) || strings.Contains(string(body), "INSUFFICIENT_PERMISSIONS") {
			return nil, fmt.Errorf("%w: keys %d", errListenScope, res.StatusCode)
		}
		return nil, fmt.Errorf("deepgram key %d: %s", res.StatusCode, truncate(string(body), 300))
	}

	var parsed struct {
		Key string `json:"key"`
	}
	if err := json.Unmarshal(body, &parsed); err != nil || parsed.Key == "" {
		return nil, fmt.Errorf("deepgram returned no key")
	}

	return &listenTokenResponse{
		Key:       parsed.Key,
		Scheme:    "token",
		ExpiresAt: expires.Format(time.RFC3339),
		Model:     d.model,
	}, nil
}

// HandleListenToken issues a browser-usable key for a single voice session.
func HandleListenToken(w http.ResponseWriter, r *http.Request) {
	setCORS(w)
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}

	a := get()
	if a.deepgram == nil {
		writeErr(w, http.StatusServiceUnavailable,
			"Voice input isn't configured on this server. Type your question instead.", "no_voice")
		return
	}

	// Minting counts against the same budget as a transcription, because it is
	// what one is about to happen.
	if v := a.limiter.consume(clientIP(r)); !v.Allowed {
		w.Header().Set("Retry-After", fmt.Sprint(v.RetryAfter))
		writeErr(w, http.StatusTooManyRequests, v.Message, "rate_limited")
		return
	}

	token, err := a.deepgram.listenToken()
	if err != nil {
		log.Printf("[cairn] issuing listen credential failed: %v", err)
		if errors.Is(err, errListenScope) {
			// Nothing the user can do, and nothing retrying will fix, so say
			// what is actually wrong where the operator will read it.
			writeErr(w, http.StatusServiceUnavailable,
				"Live transcription is switched off: this server's Deepgram key isn't allowed to "+
					"issue session tokens. An owner-scoped key fixes it. Type your question instead.",
				"listen_scope")
			return
		}
		writeErr(w, http.StatusBadGateway,
			"Couldn't start live transcription. Type your question instead.", "upstream")
		return
	}
	writeJSON(w, http.StatusOK, token)
}
