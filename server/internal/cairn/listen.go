package cairn

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
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
// Deepgram's key API resolves that: this mints a key scoped to transcription
// alone and expiring in under a minute, and hands that to the client. The
// long-lived key never leaves the server, and the worst case for a leaked
// temporary one is a few seconds of someone else's transcription.
//
// Deepgram caps temporary keys at 250/day, which is one per voice session and
// far beyond demo volume.

const (
	deepgramAPI = "https://api.deepgram.com/v1"
	// Long enough to open a socket and speak a sentence, short enough that a
	// leaked key is worthless by the time anyone could use it.
	tokenTTL = 60 * time.Second
)

type listenTokenResponse struct {
	Key       string `json:"key"`
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

	token, err := a.deepgram.mintKey()
	if err != nil {
		log.Printf("[cairn] minting listen key failed: %v", err)
		writeErr(w, http.StatusBadGateway,
			"Couldn't start live transcription. Type your question instead.", "upstream")
		return
	}
	writeJSON(w, http.StatusOK, token)
}
