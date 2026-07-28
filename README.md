# Cairn — Windows desktop client

Hold `Ctrl+Alt+C` anywhere in Windows. Ask about whatever is on your screen. Cairn draws the answer **on your actual desktop** — dimming everything else, ringing the control you need, and talking you through it.

Then it keeps the answer, so the next person on your team who hits that wall gets it instantly instead of asking again.

The name is the pile of stones hikers leave to mark a path for whoever comes next.

> **Web version and backend:** [Torutesu/hacklikey](https://github.com/Torutesu/hacklikey) — that repo holds the server this client talks to, plus a browser version that runs anywhere.

## 概要

Windows 用のデスクトップクライアントです。`Ctrl+Alt+C` を押すと、どのアプリを使っている最中でも呼び出せます。画面を読み取り、**実際のデスクトップ上に**対象のボタンを丸で囲んで指し示し、音声で手順を案内します。

解決した手順は「トレイル」として保存され、次に同じ場所で詰まった人はモデルを待たずに同じ手順を受け取れます。

サーバーとブラウザ版は [Torutesu/hacklikey](https://github.com/Torutesu/hacklikey) にあります。

## Why a desktop app

The browser version can only see a screen you explicitly share with it, and its hotkey only works while its own tab has focus. Both are fatal for a tool whose whole point is helping you inside *another* application.

This client fixes exactly that, and nothing else:

| | Browser | Desktop |
|---|---|---|
| Hotkey while you're in Figma | ✗ | ✓ global |
| Draws on your real screen | ✗ mirrored frame only | ✓ actual desktop |
| Multiple monitors | ✗ one shared surface | ✓ overlay spans all displays |
| Capture permission | every session | never |

The answers, recall, and trails are identical — it's the same backend. What changes is presence.

## How it works

```
Ctrl+Alt+C  →  HUD appears on the screen your mouse is on
            →  captures that display (Cairn excludes itself from the shot)
            →  POST /api/ask  on the server
            →  server checks team memory first, then the vision model
            →  transparent click-through overlay draws the pointer on your desktop
```

The client holds **no API keys**. An Electron app is a zip archive with a different extension, so anything shipped inside it is public. It captures pixels, sends them somewhere trusted, and draws what comes back.

```
app/
  main.js              windows, global hotkey, capture, IPC, tray
  preload.js           the only bridge between renderers and the OS
  renderer/
    hud.html           ask bar, answer, step navigation
    overlay.html       draws on the real desktop
```

## Running it

Needs Node 20+ and the [server](https://github.com/Torutesu/hacklikey) running.

```bash
cd app
npm install
CAIRN_SERVER=http://localhost:3000 npm start
```

Cairn lives in the system tray — no window until you summon it. `Ctrl+Alt+C` from anywhere, `Esc` to dismiss.

To build a portable `.exe`:

```bash
npm run dist        # → app/dist/Cairn-0.1.0-portable.exe
```

## Two details worth knowing

**Cairn keeps itself out of its own screenshots.** Without that, the model reads the HUD as part of your screen and answers about Cairn instead of your work — it will cheerfully point its own cursor at its own window. Two independent defences: `setContentProtection(true)` excludes both windows from capture at the OS level, and the overlay is hidden outright before the grab, since a full-desktop dimming layer would ruin the frame if the first defence ever regressed.

**The overlay spans the whole virtual desktop, not one screen.** Coordinates come back normalised against a screenshot of a single display, so they're mapped into absolute desktop space and then offset by the virtual origin — which is negative when a monitor sits to the left of the primary. Getting this wrong puts the ring on the right spot of the wrong screen.

## Status

Built and working: global hotkey, per-display capture, multi-monitor overlay, real-desktop drawing, spoken steps, step navigation, tray, self-exclusion from capture.

Not yet: voice input (local Whisper, in progress), a trails browser inside the HUD — the tray menu opens the library in a browser for now.

## Licence and third-party

MIT. Built on Electron (MIT). No code was taken from any other product; Clicky's source is public under MIT and was deliberately not referenced — see the hacklikey README for the reasoning.
