package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"math/rand"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"
)

// Cairn's server. API only — no pages, no templates.
//
// It exists so the desktop client can stay a thin, key-less binary: it captures
// pixels and audio, sends them here, and draws what comes back. Everything that
// needs a secret or a decision lives in this process.

const (
	maxFrameBytes = 6 << 20  // a 1600px JPEG is ~250KB; past this is a bug or a probe
	maxAudioBytes = 12 << 20 // ~15 minutes of opus, far beyond a spoken question
	maxQuestion   = 1000
)

type server struct {
	store     TrailStore
	storeKind string
	claude    *claudeClient
	deepgram  *deepgramClient
	limiter   *rateLimiter
}

func main() {
	loadDotEnv(".env")

	srv := &server{
		claude:   newClaudeClient(),
		deepgram: newDeepgramClient(),
		limiter:  newRateLimiter(),
	}
	srv.store, srv.storeKind = newStore()

	mux := http.NewServeMux()
	mux.HandleFunc("GET /health", srv.handleHealth)
	mux.HandleFunc("POST /api/ask", srv.handleAsk)
	mux.HandleFunc("POST /api/transcribe", srv.handleTranscribe)
	mux.HandleFunc("GET /api/trails", srv.handleListTrails)
	mux.HandleFunc("POST /api/trails", srv.handleSaveTrail)
	mux.HandleFunc("GET /api/trails/{id}", srv.handleGetTrail)

	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}

	log.Printf("[cairn] listening on :%s  store=%s  vision=%v  voice=%v",
		port, srv.storeKind, srv.claude != nil, srv.deepgram != nil)

	httpServer := &http.Server{
		Addr:    ":" + port,
		Handler: withCORS(mux),
		// A vision call runs ~5s and transcription ~1s, so these are generous
		// but bounded — a stalled client must not hold a connection forever.
		ReadTimeout:  60 * time.Second,
		WriteTimeout: 90 * time.Second,
		IdleTimeout:  120 * time.Second,
	}
	log.Fatal(httpServer.ListenAndServe())
}

// withCORS lets the desktop client (origin file://, which sends "null") and any
// browser client call this. The endpoints are already public and rate limited,
// so origin restrictions would be theatre rather than security.
func withCORS(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

/* ----------------------------------------------------------------- helpers */

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

func writeError(w http.ResponseWriter, status int, message, code string) {
	writeJSON(w, status, errorResponse{Error: message, Code: code})
}

// writeUpstream unwraps a provider failure into the message and status we
// decided on, rather than leaking the provider's own error text.
func writeUpstream(w http.ResponseWriter, err error) {
	var ue *upstreamError
	if errors.As(err, &ue) {
		writeJSON(w, ue.Status, errorResponse{Error: ue.Message, Code: "upstream", Retryable: ue.Retryable})
		return
	}
	if errors.Is(err, errNoAPIKey) {
		writeError(w, http.StatusServiceUnavailable,
			"Cairn has no API key configured, so live answers are off. Browsing and replaying trails still works.",
			"no_api_key")
		return
	}
	log.Printf("[cairn] unmapped failure: %v", err)
	writeError(w, http.StatusBadGateway, "Cairn couldn't read your screen just then. Try asking again.", "")
}

func newID(prefix string) string {
	const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789"
	b := make([]byte, 7)
	for i := range b {
		b[i] = alphabet[rand.Intn(len(alphabet))]
	}
	return prefix + strconv.FormatInt(time.Now().UnixMilli(), 36) + string(b)
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

func (s *server) handleHealth(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{
		"ok":        true,
		"store":     s.storeKind,
		"vision":    s.claude != nil,
		"voice":     s.deepgram != nil,
		"timestamp": time.Now().UTC().Format(time.RFC3339),
	})
}

type askRequest struct {
	Question  string `json:"question"`
	Frame     string `json:"frame"`
	MediaType string `json:"mediaType"`
}

// handleAsk is the one endpoint the live experience depends on.
//
// Order matters: team memory is consulted before the model, never after. That
// ordering is the product — the second person to hit a wall shouldn't pay the
// latency or the cost the first one already paid.
func (s *server) handleAsk(w http.ResponseWriter, r *http.Request) {
	started := time.Now()

	var body askRequest
	if err := json.NewDecoder(io.LimitReader(r.Body, maxFrameBytes+maxQuestion)).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "Malformed request body.", "")
		return
	}

	question := strings.TrimSpace(body.Question)
	if question == "" {
		writeError(w, http.StatusBadRequest, "Ask a question first.", "")
		return
	}
	if len(question) > maxQuestion {
		writeError(w, http.StatusBadRequest, "That question is too long.", "")
		return
	}

	// --- 1. Has someone already solved this? ---------------------------------
	trails, err := s.store.List()
	if err != nil {
		log.Printf("[cairn] store list failed: %v", err)
		trails = nil
	}

	if hit := recall(question, trails); hit != nil {
		_ = s.store.RecordReuse(hit.Trail.ID)
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

	// --- 2. Nobody has. Look at the screen. ----------------------------------
	if body.Frame == "" {
		writeError(w, http.StatusBadRequest, "Share your screen so Cairn can see what you're looking at.", "")
		return
	}

	// The spend guard sits here and nowhere else: past this line the request
	// costs money, and everything before it was free.
	if v := s.limiter.consume(clientIP(r)); !v.Allowed {
		w.Header().Set("Retry-After", strconv.Itoa(v.RetryAfter))
		writeError(w, http.StatusTooManyRequests, v.Message, "rate_limited")
		return
	}

	mediaType := body.MediaType
	if mediaType == "" {
		mediaType = "image/png"
	}

	ctx, cancel := context.WithTimeout(r.Context(), 60*time.Second)
	defer cancel()

	answer, err := s.claude.readScreen(ctx, body.Frame, mediaType, question)
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

// handleTranscribe takes raw audio bytes and returns text.
//
// The body is the audio itself rather than JSON — base64 in a JSON envelope
// would inflate it by a third for no benefit, since there's nothing else to
// send alongside it.
func (s *server) handleTranscribe(w http.ResponseWriter, r *http.Request) {
	started := time.Now()

	audio, err := io.ReadAll(io.LimitReader(r.Body, maxAudioBytes))
	if err != nil {
		writeError(w, http.StatusBadRequest, "Couldn't read that audio.", "")
		return
	}
	// Under ~2KB is a misfire — a stray click, not a question.
	if len(audio) < 2048 {
		writeError(w, http.StatusBadRequest, "That recording was too short.", "")
		return
	}

	if v := s.limiter.consume(clientIP(r)); !v.Allowed {
		w.Header().Set("Retry-After", strconv.Itoa(v.RetryAfter))
		writeError(w, http.StatusTooManyRequests, v.Message, "rate_limited")
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 45*time.Second)
	defer cancel()

	text, confidence, err := s.deepgram.transcribe(ctx, audio, r.Header.Get("Content-Type"))
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

func (s *server) handleListTrails(w http.ResponseWriter, r *http.Request) {
	trails, err := s.store.List()
	if err != nil {
		log.Printf("[cairn] store list failed: %v", err)
		writeError(w, http.StatusInternalServerError, "Couldn't load trails.", "")
		return
	}
	if q := strings.TrimSpace(r.URL.Query().Get("q")); q != "" {
		trails = searchTrails(q, trails)
	}
	writeJSON(w, http.StatusOK, map[string]any{"trails": trails, "storeKind": s.storeKind})
}

type saveTrailRequest struct {
	Title    string `json:"title"`
	Question string `json:"question"`
	App      string `json:"app"`
	Steps    []Step `json:"steps"`
}

// currentUser is mocked — see README.
var currentUser = Author{ID: "u_you", Name: "You", Initials: "YO", Color: "#3b82f6"}

func (s *server) handleSaveTrail(w http.ResponseWriter, r *http.Request) {
	var body saveTrailRequest
	if err := json.NewDecoder(io.LimitReader(r.Body, maxFrameBytes)).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "Malformed request body.", "")
		return
	}
	if body.Title == "" || body.Question == "" || len(body.Steps) == 0 {
		writeError(w, http.StatusBadRequest,
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
		ID:         newID("tr_"),
		Title:      body.Title,
		Question:   body.Question,
		Aliases:    deriveAliases(body.Question, body.Title),
		App:        app,
		Steps:      body.Steps,
		Author:     currentUser,
		CreatedAt:  time.Now().UnixMilli(),
		ReuseCount: 0,
	}

	if err := s.store.Save(trail); err != nil {
		log.Printf("[cairn] store save failed: %v", err)
		writeError(w, http.StatusInternalServerError, "Couldn't save that trail.", "")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"trail": trail})
}

func (s *server) handleGetTrail(w http.ResponseWriter, r *http.Request) {
	trail, err := s.store.Get(r.PathValue("id"))
	if err != nil || trail == nil {
		writeError(w, http.StatusNotFound, "No such trail.", "")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"trail": trail})
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
