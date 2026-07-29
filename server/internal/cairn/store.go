package cairn

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"sort"
	"sync"
	"time"
)

// Persistence for team memory.
//
// Two adapters ship:
//
//   - memoryStore   zero config, seeded, held in this process.
//   - upstashStore  shared storage over Upstash's REST API.
//
// Worth noting what changed by moving off serverless: this server is one
// long-running process, so the in-memory store actually holds. On Vercel the
// same code was effectively broken — each request could land on a different
// instance with its own memory, so a saved trail would vanish minutes later.
// Here, memory is a legitimate choice for a single-instance deployment, and
// Upstash is what you add when you run more than one.

// TrailStore is the boundary everything above it is written against, so
// promoting a demo to genuinely shared memory is a deployment concern rather
// than a code change.
type TrailStore interface {
	List() ([]Trail, error)
	Get(id string) (*Trail, error)
	Save(t Trail) error
	// RecordReuse bumps the counter when recall serves this trail instead of
	// calling the model.
	RecordReuse(id string) error
}

/* ------------------------------------------------------------------ memory */

type memoryStore struct {
	mu     sync.RWMutex
	trails map[string]Trail
}

func newMemoryStore() *memoryStore {
	m := &memoryStore{trails: make(map[string]Trail)}
	for _, t := range seedTrails() {
		m.trails[t.ID] = t
	}
	return m
}

func (m *memoryStore) List() ([]Trail, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()

	out := make([]Trail, 0, len(m.trails))
	for _, t := range m.trails {
		out = append(out, t)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].CreatedAt > out[j].CreatedAt })
	return out, nil
}

func (m *memoryStore) Get(id string) (*Trail, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	if t, ok := m.trails[id]; ok {
		return &t, nil
	}
	return nil, nil
}

func (m *memoryStore) Save(t Trail) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.trails[t.ID] = t
	return nil
}

func (m *memoryStore) RecordReuse(id string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if t, ok := m.trails[id]; ok {
		t.ReuseCount++
		m.trails[id] = t
	}
	return nil
}

/* ----------------------------------------------------------------- upstash */

const upstashKey = "cairn:trails"

type upstashStore struct {
	url    string
	token  string
	client *http.Client

	seedOnce sync.Once
}

func newUpstashStore(url, token string) *upstashStore {
	return &upstashStore{
		url:    url,
		token:  token,
		client: &http.Client{Timeout: 10 * time.Second},
	}
}

// cmd sends one Redis command over Upstash's REST API, which keeps this
// adapter dependency-free — no connection pool to manage, and it works
// identically whether this runs as one process or twenty.
func (u *upstashStore) cmd(args ...string) (json.RawMessage, error) {
	body, err := json.Marshal(args)
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequest(http.MethodPost, u.url, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+u.token)
	req.Header.Set("Content-Type", "application/json")

	res, err := u.client.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()

	raw, err := io.ReadAll(res.Body)
	if err != nil {
		return nil, err
	}
	if res.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("upstash %d: %s", res.StatusCode, string(raw))
	}

	var wrapper struct {
		Result json.RawMessage `json:"result"`
	}
	if err := json.Unmarshal(raw, &wrapper); err != nil {
		return nil, err
	}
	return wrapper.Result, nil
}

// ensureSeeded populates a fresh database once, so a new deployment still
// demonstrates the team-memory idea rather than showing an empty library.
func (u *upstashStore) ensureSeeded() {
	u.seedOnce.Do(func() {
		raw, err := u.cmd("HLEN", upstashKey)
		if err != nil {
			return
		}
		var n int
		if json.Unmarshal(raw, &n) == nil && n > 0 {
			return
		}
		for _, t := range seedTrails() {
			if encoded, err := json.Marshal(t); err == nil {
				_, _ = u.cmd("HSET", upstashKey, t.ID, string(encoded))
			}
		}
	})
}

func (u *upstashStore) List() ([]Trail, error) {
	u.ensureSeeded()
	raw, err := u.cmd("HVALS", upstashKey)
	if err != nil {
		return nil, err
	}
	var values []string
	if err := json.Unmarshal(raw, &values); err != nil {
		return nil, err
	}

	out := make([]Trail, 0, len(values))
	for _, v := range values {
		var t Trail
		if json.Unmarshal([]byte(v), &t) == nil {
			out = append(out, t)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].CreatedAt > out[j].CreatedAt })
	return out, nil
}

func (u *upstashStore) Get(id string) (*Trail, error) {
	raw, err := u.cmd("HGET", upstashKey, id)
	if err != nil {
		return nil, err
	}
	var value *string
	if err := json.Unmarshal(raw, &value); err != nil || value == nil {
		return nil, nil
	}
	var t Trail
	if err := json.Unmarshal([]byte(*value), &t); err != nil {
		return nil, err
	}
	return &t, nil
}

func (u *upstashStore) Save(t Trail) error {
	encoded, err := json.Marshal(t)
	if err != nil {
		return err
	}
	_, err = u.cmd("HSET", upstashKey, t.ID, string(encoded))
	return err
}

func (u *upstashStore) RecordReuse(id string) error {
	t, err := u.Get(id)
	if err != nil || t == nil {
		return err
	}
	t.ReuseCount++
	return u.Save(*t)
}

/* ------------------------------------------------------------------ picker */

func newStore() (TrailStore, string) {
	url := os.Getenv("UPSTASH_REDIS_REST_URL")
	token := os.Getenv("UPSTASH_REDIS_REST_TOKEN")
	if url != "" && token != "" {
		return newUpstashStore(url, token), "shared"
	}
	// Honest label: on a single long-running instance this persists for the
	// life of the process, which is not the same as durable.
	return newMemoryStore(), "in-process"
}
