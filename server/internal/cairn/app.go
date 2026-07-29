package cairn

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"math/rand/v2"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Cairn's API. No pages, no templates.
//
// It exists so the desktop client can stay a thin, key-less binary: it captures
// pixels and audio, sends them here, and draws what comes back. Everything
// needing a secret or a decision lives in this package.
//
// The exported Handle* functions are the entry points. They're wrapped by
// api/*.go for serverless deployment and by cmd/server for a normal process, so
// the same code serves both without knowing which it's in.

const (
	maxFrameBytes = 6 << 20  // a 1600px JPEG is ~250KB; past this is a bug or a probe
	maxAudioBytes = 12 << 20 // far beyond any spoken question
	maxQuestion   = 1000
)

type app struct {
	store     TrailStore
	storeKind string
	claude    *claudeClient
	deepgram  *deepgramClient
	limiter   *rateLimiter
}

var (
	initOnce sync.Once
	instance *app
)

// get builds the app once per process.
//
// Lazily rather than in an init function because serverless invocations pay for
// startup: work done before a request arrives is latency the caller feels, and
// a cold instance that never receives a request should cost nothing at all.
func get() *app {
	initOnce.Do(func() {
		loadDotEnv(".env")

		a := &app{
			claude:   newClaudeClient(),
			deepgram: newDeepgramClient(),
			limiter:  newRateLimiter(),
		}
		a.store, a.storeKind = newStore()
		instance = a

		log.Printf("[cairn] ready  store=%s vision=%v voice=%v",
			a.storeKind, a.claude != nil, a.deepgram != nil)
	})
	return instance
}

/* ----------------------------------------------------------------- helpers */

// WithCORS lets the desktop client (origin "null", since it loads from file://)
// and any browser call this. The endpoints are public and rate limited already,
// so origin restrictions would be theatre rather than security.
func WithCORS(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		setCORS(w)
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func setCORS(w http.ResponseWriter) {
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
	w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

func writeErr(w http.ResponseWriter, status int, message, code string) {
	writeJSON(w, status, errorResponse{Error: message, Code: code})
}

// writeUpstream unwraps a provider failure into the message and status we chose,
// rather than leaking the provider's own error text to a public endpoint.
func writeUpstream(w http.ResponseWriter, err error) {
	var ue *upstreamError
	if errors.As(err, &ue) {
		writeJSON(w, ue.Status, errorResponse{Error: ue.Message, Code: "upstream", Retryable: ue.Retryable})
		return
	}
	if errors.Is(err, errNoAPIKey) {
		writeErr(w, http.StatusServiceUnavailable,
			"Cairn has no API key configured, so live answers are off.", "no_api_key")
		return
	}
	log.Printf("[cairn] unmapped failure: %v", err)
	writeErr(w, http.StatusBadGateway, "Cairn couldn't read your screen just then. Try asking again.", "")
}

func relativeTime(ms int64) string {
	d := time.Since(time.UnixMilli(ms))
	switch {
	case d < time.Hour:
		return fmt.Sprintf("%d minutes ago", int(d.Minutes()))
	case d < 24*time.Hour:
		return fmt.Sprintf("%d hours ago", int(d.Hours()))
	case d < 48*time.Hour:
		return "yesterday"
	default:
		return fmt.Sprintf("%d days ago", int(d.Hours()/24))
	}
}

// clampRegion keeps a returned box inside the frame. The model is reliable
// here, but a box running off-canvas renders as a pointer stuck to an edge,
// which looks broken in a way that's hard to attribute — cheaper to clamp.
func clampRegion(r *Region) *Region {
	if r == nil {
		return nil
	}
	clamp := func(v, lo, hi float64) float64 {
		if v < lo {
			return lo
		}
		if v > hi {
			return hi
		}
		return v
	}
	x := clamp(r.X, 0, 1)
	y := clamp(r.Y, 0, 1)
	return &Region{X: x, Y: y, W: clamp(r.W, 0.01, 1-x), H: clamp(r.H, 0.01, 1-y)}
}

/* ---------------------------------------------------------------- handlers */

// HandleHealth reports what this instance can actually do, which is the fastest
// way to tell a misconfigured deployment from a broken one.
func HandleHealth(w http.ResponseWriter, r *http.Request) {
	setCORS(w)
	a := get()
	writeJSON(w, http.StatusOK, map[string]any{
		"ok":        true,
		"store":     a.storeKind,
		"vision":    a.claude != nil,
		"voice":     a.deepgram != nil,
		"timestamp": time.Now().UTC().Format(time.RFC3339),
	})
}

type askRequest struct {
	Question  string `json:"question"`
	Frame     string `json:"frame"`
	MediaType string `json:"mediaType"`
}

// HandleAsk is the endpoint the live experience depends on.
//
// Order matters: team memory is consulted before the model, never after. That
// ordering is the product — the second person to hit a wall shouldn't pay the
// latency or the cost the first one already paid.
func HandleAsk(w http.ResponseWriter, r *http.Request) {
	setCORS(w)
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if r.Method != http.MethodPost {
		writeErr(w, http.StatusMethodNotAllowed, "Use POST.", "")
		return
	}

	started := time.Now()
	a := get()

	var body askRequest
	if err := json.NewDecoder(io.LimitReader(r.Body, maxFrameBytes+maxQuestion)).Decode(&body); err != nil {
		writeErr(w, http.StatusBadRequest, "Malformed request body.", "")
		return
	}

	question := strings.TrimSpace(body.Question)
	if question == "" {
		writeErr(w, http.StatusBadRequest, "Ask a question first.", "")
		return
	}
	if len(question) > maxQuestion {
		writeErr(w, http.StatusBadRequest, "That question is too long.", "")
		return
	}

	// --- 1. Has someone already solved this? --------------------------------
	trails, err := a.store.List()
	if err != nil {
		log.Printf("[cairn] store list failed: %v", err)
	}
	if hit := recall(question, trails); hit != nil {
		_ = a.store.RecordReuse(hit.Trail.ID)
		writeJSON(w, http.StatusOK, AskResult{
			Source:    "trail",
			Trail:     &hit.Trail,
			Steps:     hit.Trail.Steps,
			Summary:   fmt.Sprintf("%s worked this out %s. Here's the path.", hit.Trail.Author.Name, relativeTime(hit.Trail.CreatedAt)),
			Title:     hit.Trail.Title,
			App:       hit.Trail.App,
			ElapsedMs: time.Since(started).Milliseconds(),
		})
		return
	}

	// --- 2. Nobody has. Look at the screen. ---------------------------------
	if body.Frame == "" {
		writeErr(w, http.StatusBadRequest, "Share your screen so Cairn can see what you're looking at.", "")
		return
	}

	// The spend guard sits here and nowhere else: past this line the request
	// costs money, and everything before it was free.
	if v := a.limiter.consume(clientIP(r)); !v.Allowed {
		w.Header().Set("Retry-After", strconv.Itoa(v.RetryAfter))
		writeErr(w, http.StatusTooManyRequests, v.Message, "rate_limited")
		return
	}

	mediaType := body.MediaType
	if mediaType == "" {
		mediaType = "image/png"
	}

	ctx, cancel := context.WithTimeout(r.Context(), 55*time.Second)
	defer cancel()

	answer, err := a.claude.readScreen(ctx, body.Frame, mediaType, question)
	if err != nil {
		writeUpstream(w, err)
		return
	}

	steps := make([]Step, 0, len(answer.Steps))
	for i, st := range answer.Steps {
		steps = append(steps, Step{
			ID:     fmt.Sprintf("s%d", i+1),
			Say:    st.Say,
			Label:  st.Label,
			Target: clampRegion(st.Target),
		})
	}

	writeJSON(w, http.StatusOK, AskResult{
		Source:    "model",
		Steps:     steps,
		Summary:   answer.Summary,
		Title:     answer.Title,
		App:       answer.App,
		ElapsedMs: time.Since(started).Milliseconds(),
	})
}

// HandleTranscribe takes raw audio bytes and returns text.
//
// The body is the audio itself rather than JSON — base64 in an envelope would
// inflate it by a third for no benefit, since there is nothing to send
// alongside it.
func HandleTranscribe(w http.ResponseWriter, r *http.Request) {
	setCORS(w)
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if r.Method != http.MethodPost {
		writeErr(w, http.StatusMethodNotAllowed, "Use POST.", "")
		return
	}

	started := time.Now()
	a := get()

	audio, err := io.ReadAll(io.LimitReader(r.Body, maxAudioBytes))
	if err != nil {
		writeErr(w, http.StatusBadRequest, "Couldn't read that audio.", "")
		return
	}
	// Anything this small is a misfire — a stray click, not a question.
	if len(audio) < 2048 {
		writeErr(w, http.StatusBadRequest, "That recording was too short.", "")
		return
	}

	if v := a.limiter.consume(clientIP(r)); !v.Allowed {
		w.Header().Set("Retry-After", strconv.Itoa(v.RetryAfter))
		writeErr(w, http.StatusTooManyRequests, v.Message, "rate_limited")
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 40*time.Second)
	defer cancel()

	text, confidence, err := a.deepgram.transcribe(ctx, audio, r.Header.Get("Content-Type"))
	if err != nil {
		writeUpstream(w, err)
		return
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"text":       text,
		"confidence": confidence,
		"elapsedMs":  time.Since(started).Milliseconds(),
	})
}

// HandleTrails lists the library on GET, and saves on POST.
//
// Saving is refused when the store is in-process. On a host that recycles
// instances, accepting one means showing someone "Saved for the team" for
// something that disappears within minutes — a visible lie, where refusing is
// an honest limitation. With shared storage configured the whole point of the
// product works, so the endpoint follows the store rather than a hardcoded
// decision, and the response says which mode it's in.
func HandleTrails(w http.ResponseWriter, r *http.Request) {
	setCORS(w)
	switch r.Method {
	case http.MethodOptions:
		w.WriteHeader(http.StatusNoContent)
	case http.MethodGet:
		listTrails(w, r)
	case http.MethodPost:
		saveTrail(w, r)
	default:
		writeErr(w, http.StatusMethodNotAllowed, "Use GET or POST.", "")
	}
}

func listTrails(w http.ResponseWriter, r *http.Request) {
	a := get()
	trails, err := a.store.List()
	if err != nil {
		log.Printf("[cairn] store list failed: %v", err)
		writeErr(w, http.StatusInternalServerError, "Couldn't load trails.", "")
		return
	}
	if q := strings.TrimSpace(r.URL.Query().Get("q")); q != "" {
		trails = searchTrails(q, trails)
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"trails":    trails,
		"storeKind": a.storeKind,
		"readOnly":  a.storeKind != "shared",
	})
}

type saveTrailRequest struct {
	Title    string `json:"title"`
	Question string `json:"question"`
	App      string `json:"app"`
	Steps    []Step `json:"steps"`
}

// currentUser is mocked — see README.
var currentUser = Author{ID: "u_you", Name: "You", Initials: "YO", Color: "#3b82f6"}

func saveTrail(w http.ResponseWriter, r *http.Request) {
	a := get()

	if a.storeKind != "shared" {
		writeErr(w, http.StatusServiceUnavailable,
			"This deployment has no persistent storage, so trails can't be saved. Browsing and replaying still works.",
			"read_only")
		return
	}

	var body saveTrailRequest
	if err := json.NewDecoder(io.LimitReader(r.Body, maxFrameBytes)).Decode(&body); err != nil {
		writeErr(w, http.StatusBadRequest, "Malformed request body.", "")
		return
	}
	if body.Title == "" || body.Question == "" || len(body.Steps) == 0 {
		writeErr(w, http.StatusBadRequest,
			"A trail needs a title, the original question, and at least one step.", "")
		return
	}

	app := body.App
	if app == "" {
		app = "Unknown"
	}
	for i := range body.Steps {
		if body.Steps[i].ID == "" {
			body.Steps[i].ID = fmt.Sprintf("s%d", i+1)
		}
	}

	trail := Trail{
		ID:        newID("tr_"),
		Title:     body.Title,
		Question:  body.Question,
		Aliases:   deriveAliases(body.Question, body.Title),
		App:       app,
		Steps:     body.Steps,
		Author:    currentUser,
		CreatedAt: time.Now().UnixMilli(),
	}

	if err := a.store.Save(trail); err != nil {
		log.Printf("[cairn] store save failed: %v", err)
		writeErr(w, http.StatusInternalServerError, "Couldn't save that trail.", "")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"trail": trail})
}

// newID is time-ordered with a random tail, so ids sort roughly by age without
// needing a counter shared between instances.
func newID(prefix string) string {
	const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789"
	b := make([]byte, 7)
	for i := range b {
		b[i] = alphabet[rand.IntN(len(alphabet))]
	}
	return prefix + strconv.FormatInt(time.Now().UnixMilli(), 36) + string(b)
}

// deriveAliases makes a saved trail findable by someone who phrases the problem
// differently. The title is usually a cleaner statement of the same intent than
// the question was, so each becomes an alias for the other.
func deriveAliases(question, title string) []string {
	seen := map[string]bool{}
	out := []string{}
	add := func(s string) {
		s = strings.ToLower(strings.TrimSpace(s))
		if s != "" && !seen[s] {
			seen[s] = true
			out = append(out, s)
		}
	}

	add(title)
	add(question)

	// Strip interrogative framing so "how do I export a frame" also matches a
	// later "export a frame".
	lower := strings.ToLower(question)
	for _, prefix := range []string{
		"how do i ", "how can i ", "how would i ", "how do you ",
		"where is ", "where do i ", "what is ", "what's ", "why does ", "why is ",
	} {
		if strings.HasPrefix(lower, prefix) {
			add(strings.TrimPrefix(lower, prefix))
			break
		}
	}
	return out
}

// Mux wires the handlers for a normal long-running process. Serverless
// deployments route to the Handle* functions directly instead.
func Mux() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/health", HandleHealth)
	mux.HandleFunc("/api/ask", HandleAsk)
	mux.HandleFunc("/api/transcribe", HandleTranscribe)
	mux.HandleFunc("/api/trails", HandleTrails)
	return WithCORS(mux)
}
