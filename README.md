# Cairn

Press `Ctrl+Alt+C` anywhere in Windows. Ask about whatever is on your screen. Cairn draws the answer **on your actual desktop** — dimming everything else, ringing the control you need, and talking you through it.

Then it keeps the answer, so the next person on your team who hits that wall gets it instantly instead of asking again.

The name is the pile of stones hikers leave to mark a path for whoever comes next.

```
app/      Windows desktop client (Electron)
server/   API (Go) — vision, transcription, recall, trails
```

## 概要

Windows 用のデスクトップアプリと、その API サーバーです。

`Ctrl+Alt+C` を押すと、どのアプリを使っている最中でも呼び出せます。画面を読み取り、**実際のデスクトップ上に**対象のボタンを囲んで指し示し、音声で手順を案内します。

解決した手順は「トレイル」として保存され、次に同じ場所で詰まった人は、モデルを待たずに同じ手順を受け取れます。チームで使うほど速くなり、コストも下がる構造です。

サーバーは Go で書かれた API のみで、画面はありません。Anthropic と Deepgram の鍵はすべてサーバー側にあり、配布する `.exe` には一切含まれません。

## Why a desktop app

A browser can only see a screen you explicitly share with it, and its hotkey only fires while its own tab has focus. Both are fatal for a tool whose entire purpose is helping you inside *another* application.

| | Browser | Desktop |
|---|---|---|
| Hotkey while you're in Figma | ✗ | ✓ global |
| Draws on your real screen | ✗ mirrored frame only | ✓ actual desktop |
| Multiple monitors | ✗ one shared surface | ✓ overlay spans all displays |
| Capture permission | every session | never |

## How it works

```
Ctrl+Alt+C  →  HUD appears on whichever screen your mouse is on
            →  captures that display (Cairn excludes itself from the shot)
            →  POST /api/ask
                  1. recall — has the team already solved this?   ~0ms, free
                  2. miss → Claude reads the screenshot           ~5s
            →  transparent click-through overlay draws on your desktop
```

Voice takes the same shape: the client records, `POST /api/transcribe` returns text, and the text lands in the input box for you to confirm before it's sent.

**The client holds no API keys.** An Electron app is a zip archive with a different extension, so anything shipped inside it is public. It captures pixels and audio, sends them somewhere trusted, and draws what comes back.

## The server

Go, API only, no pages. One binary, ~15MB.

| file | |
|---|---|
| `main.go` | routing, handlers, CORS, timeouts, body limits |
| `claude.go` | vision via the Anthropic Go SDK, schema-constrained output |
| `deepgram.go` | speech to text |
| `recall.go` | question → trail matching |
| `store.go` | `TrailStore` — in-process or Upstash |
| `ratelimit.go` | spend guard on the paid paths |
| `seed.go`, `types.go`, `env.go` | |

```
GET  /health
POST /api/ask          screenshot + question → steps with pointer coordinates
POST /api/transcribe   raw audio bytes → text
GET  /api/trails       list, or ?q= to search
POST /api/trails       save
GET  /api/trails/{id}
```

### Why recall runs before the model

Put a cache *after* the model and it only fires on an identical question. Put recall *before* it and you're asking whether the team has already solved this — which is the product. It's the first thing `/api/ask` does, and a hit costs nothing and returns in about a millisecond.

The rate limiter makes that concrete: **only calls that actually reach a paid provider are counted.** Recall hits never consume quota, so the more the team's memory grows, the more questions the same budget answers.

### Why Go

The honest version: the request profile doesn't need it — ~5ms of our own work against ~5000ms waiting on Claude, which Node handled fine. What the rewrite actually bought was the *process model*.

The previous server ran as serverless functions, where each request could land on a different instance with its own memory. Saved trails vanished within minutes, and the rate limiter's daily cap silently reset per instance. One long-running process fixes both outright, and a single static binary is a simpler thing to deploy and reason about.

## Running it

Needs Go 1.24+ and Node 20+.

```bash
# server
cd server
cp .env.example .env        # add ANTHROPIC_API_KEY and DEEPGRAM_API_KEY
go run .                    # :8080

# client
cd app
npm install
CAIRN_SERVER=http://localhost:8080 npm start
```

Cairn lives in the system tray — no window until you summon it. `Ctrl+Alt+C` from anywhere, `Esc` to dismiss.

Build a portable `.exe`:

```bash
cd app && npm run dist      # → app/dist/Cairn-0.1.0-portable.exe
```

## Two details worth knowing

**Cairn keeps itself out of its own screenshots.** Without that, the model reads the HUD as part of your screen and answers about Cairn instead of your work — it will cheerfully point its own cursor at its own window. Two independent defences: `setContentProtection(true)` excludes both windows from capture at the OS level, and the overlay is hidden outright before the grab, since a full-desktop dimming layer would ruin the frame if the first defence ever regressed.

**The overlay spans the whole virtual desktop, not one screen.** Coordinates come back normalised against a screenshot of a single display, so they're mapped into absolute desktop space and then offset by the virtual origin — which is negative when a monitor sits to the left of the primary. Getting this wrong puts the ring on the right spot of the wrong screen.

## Voice

Speech to text runs on the server via Deepgram, not on the device.

It started as local Whisper, which was appealing — audio never leaving the machine is a genuinely good property for a tool that already watches your screen. It was replaced because accuracy came first: the models small enough to ship mistranscribed accented English badly enough to be unusable, and a misheard question is worse than a slow one. It quietly produces a confident answer to something you never asked.

For the same reason, the transcription now lands in the input box and waits rather than asking immediately. One keystroke to confirm is cheap next to a wrong answer you also paid for.

## Status

Working: global hotkey, per-display capture, multi-monitor overlay, real-desktop drawing, voice input, spoken answers, step navigation, tray, self-exclusion from capture, recall, trails, rate limiting.

Not built: a trails browser inside the HUD — the tray menu opens the library instead. True hold-to-talk is also absent, because Electron's `globalShortcut` only fires on key-down; press-to-start with silence detection replaces it, and real push-to-talk would need a native input hook.

## Licence and third-party

MIT. Built on Electron (MIT) and the Anthropic Go SDK. No code was taken from any other product; Clicky's source is public under MIT and was deliberately not referenced.
