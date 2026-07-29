package cairn

import (
	"net"
	"net/http"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Spend protection for the endpoints that cost money.
//
// The server is public and unauthenticated, so /api/ask and /api/transcribe are
// reachable by anyone who finds the URL, and both spend real money per call.
// Three limits apply and a request must clear all of them:
//
//	per-IP burst   stops one client hammering it — a runaway loop, a stuck retry
//	per-IP hourly  stops one client grinding steadily all afternoon
//	global daily   the wallet guard, and the only one that helps against a crowd
//
// Only calls that actually reach a paid provider are counted. Recall hits are
// free and never consume quota, which means the team-memory layer isn't just a
// latency win — it takes real pressure off this budget.
//
// Unlike the serverless version this replaces, these counters live in one
// process, so the limits genuinely hold rather than resetting per instance.

type rateLimits struct {
	perIPPerMinute int
	perIPPerHour   int
	globalPerDay   int
}

func loadRateLimits() rateLimits {
	// Sized against a demo budget rather than production traffic: at roughly
	// three cents a vision call, 100/day caps exposure near $3/day — enough for
	// a reviewer to explore properly, low enough that a scraper can't drain the
	// account overnight.
	return rateLimits{
		perIPPerMinute: envInt("RATE_LIMIT_PER_IP_PER_MINUTE", 6),
		perIPPerHour:   envInt("RATE_LIMIT_PER_IP_PER_HOUR", 30),
		globalPerDay:   envInt("RATE_LIMIT_GLOBAL_PER_DAY", 100),
	}
}

func envInt(name string, fallback int) int {
	if raw := os.Getenv(name); raw != "" {
		if n, err := strconv.Atoi(raw); err == nil && n > 0 {
			return n
		}
	}
	return fallback
}

type counter struct {
	count     int
	expiresAt time.Time
}

type rateLimiter struct {
	mu       sync.Mutex
	counters map[string]*counter
	limits   rateLimits
}

func newRateLimiter() *rateLimiter {
	rl := &rateLimiter{
		counters: make(map[string]*counter),
		limits:   loadRateLimits(),
	}
	go rl.sweep()
	return rl
}

// sweep drops expired counters. Without it, one entry per IP per window
// accumulates forever — a slow leak in a long-running process.
func (rl *rateLimiter) sweep() {
	for range time.Tick(5 * time.Minute) {
		now := time.Now()
		rl.mu.Lock()
		for k, c := range rl.counters {
			if now.After(c.expiresAt) {
				delete(rl.counters, k)
			}
		}
		rl.mu.Unlock()
	}
}

func (rl *rateLimiter) bump(key string, window time.Duration) int {
	now := time.Now()
	c, ok := rl.counters[key]
	if !ok || now.After(c.expiresAt) {
		rl.counters[key] = &counter{count: 1, expiresAt: now.Add(window)}
		return 1
	}
	c.count++
	return c.count
}

type limitVerdict struct {
	Allowed    bool
	Message    string
	RetryAfter int
}

// consume charges one unit against every limit. Call this only when a paid call
// is actually about to happen — never on a recall hit.
//
// Counters increment even when a later limit rejects the request. That's
// deliberate: a client retrying through a 429 should stay blocked rather than
// being handed a fresh allowance, and rolling back would be racy for no gain.
func (rl *rateLimiter) consume(ip string) limitVerdict {
	now := time.Now()
	rl.mu.Lock()
	defer rl.mu.Unlock()

	minute := rl.bump("m:"+ip+":"+strconv.FormatInt(now.Unix()/60, 10), time.Minute)
	hour := rl.bump("h:"+ip+":"+strconv.FormatInt(now.Unix()/3600, 10), time.Hour)
	day := rl.bump("d:"+now.UTC().Format("2006-01-02"), 24*time.Hour)

	switch {
	case minute > rl.limits.perIPPerMinute:
		return limitVerdict{Message: "Slow down a moment — that's a lot of questions at once. Try again in a minute.", RetryAfter: 60}
	case hour > rl.limits.perIPPerHour:
		return limitVerdict{Message: "You've hit the hourly limit for live answers. Saved trails still work.", RetryAfter: 900}
	case day > rl.limits.globalPerDay:
		return limitVerdict{Message: "Cairn has reached its daily budget for live answers. Browsing and replaying trails still works.", RetryAfter: 3600}
	}
	return limitVerdict{Allowed: true}
}

// clientIP is best-effort. Proxies populate X-Forwarded-For and the first entry
// is the original client. Falls back to a shared bucket, which means unknown
// clients throttle each other — acceptable, since the global daily cap is what
// actually protects the budget.
func clientIP(r *http.Request) string {
	if fwd := r.Header.Get("X-Forwarded-For"); fwd != "" {
		return strings.TrimSpace(strings.Split(fwd, ",")[0])
	}
	if real := r.Header.Get("X-Real-IP"); real != "" {
		return strings.TrimSpace(real)
	}
	if host, _, err := net.SplitHostPort(r.RemoteAddr); err == nil {
		return host
	}
	return "unknown"
}
