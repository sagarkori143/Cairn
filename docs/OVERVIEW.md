# Cairn

A desktop assistant for Windows that answers questions about whatever is on
your screen — and answers them *on* the screen, by dimming everything else and
putting a cursor on the control you need.

Press `Ctrl+Space` in any application. Ask out loud or type. The screen dims,
a marker lands on the thing you were looking for, and each step is spoken while
it points.

Then it keeps the answer. The next person who hits the same wall gets the same
walkthrough instantly, without another model call.

---

## Why a desktop app and not a web app

The question is always about *another* application — a settings page in Figma,
a VPN client, an installer dialog, a billing screen nobody has seen before. A
browser can only see a tab you explicitly share with it, and a browser hotkey
only fires while its own tab has focus. Both are disqualifying for a tool whose
entire job is to help you inside software it does not control.

|                                        | Browser extension | Cairn |
| -------------------------------------- | ----------------- | ----- |
| See a non-browser application          | ✗                 | ✓     |
| Hotkey while you are in another app     | ✗                 | ✓     |
| Draw on the real desktop                | ✗                 | ✓     |

---

## What it does

**Sees the screen you are on.** Captures the display your pointer is on, and
excludes its own windows from that capture — otherwise the model reads Cairn
and starts explaining Cairn to you.

**Listens while you speak.** Audio streams to transcription as you talk, so
words appear as they are said rather than arriving in a block afterwards. You
see a mishearing before it becomes the question.

**Points on the real desktop.** The screen dims, a marker and a cursor land on
the target, and each step is narrated with optional captions. Multi-step answers
advance on their own; `Back` and `Next` take over if you would rather drive.

**Remembers.** Any answer can be saved as a *trail* — the steps, not the
screenshot. A question that matches an existing trail is answered from storage:
no model, no cost, no wait.

**Stays out of the way.** No window until summoned. Lives in the tray.
`Esc` stops everything from anywhere.

---

## Numbers

All measured against the deployed API, not estimated.

| | |
| --- | --- |
| Question already answered (recall) | **~0 ms** |
| New question, screenshot to answer | **~8 s** |
| Speak pressed → microphone live | **1.1 s** |
| First transcribed words | **~2.5 s into the sentence**, while still speaking |
| Screenshot | 414 ms, overlapped with speech — not added to the wait |
| Download | 85 MB, portable, no installer |

The two prefetches are the reason the numbers look like that: the transcription
credential is fetched when the panel opens rather than when Speak is clicked
(4.5 s → 1.1 s), and the screenshot is taken when you press Speak rather than
when you stop talking, so its cost overlaps with the sentence instead of
following it.

---

## How it is built

```
app/       Windows client (Electron) — capture, overlay, voice, hotkey
server/    API (Go, on Vercel) — vision, transcription tokens, recall, trails
Website/   Landing page (static)
```

**The client holds no credentials.** Anthropic and Deepgram keys live on the
server. Live transcription needs a WebSocket, which a serverless function
cannot hold, so the server mints a Deepgram token scoped to transcription alone
and expiring in 60 seconds; the client streams directly with that. Unpacking
the `.exe` yields the interface and nothing else.

**Recall before inference.** Every question checks storage first. This is the
product thesis and the cost strategy at once — the more a team uses it, the
larger the share of questions that never reach a model.

**Structured output.** The model returns steps with normalised target
coordinates against a JSON schema, so the client never parses prose to find out
where to point.

---

## Design decisions worth explaining

**The mark is a point, not a box.** A vision model's bounding box is often a
few pixels loose. An outline makes exactly that error the most conspicuous
thing on screen. Concentric rings fading outward from a centre point read as
"look here" and stay convincing when the box is imprecise. The marks are also
capped in size: a model asked to point inside a large panel often returns the
panel, and an unbounded ring pulsed out to nearly twice the width of the
screen.

**The overlay covers one screen, and that is a DPI decision.** It used to span
the whole virtual desktop as one window. A window gets a single DPI context, so
covering a 1.25-scale laptop and a 1.0-scale external monitor at once meant its
pixels could line up with one or the other, never both — correct on one screen,
offset on the other. It is now fitted to the display the question was asked on.

**Escape is the only way out.** The panel used to hide when it lost focus, on
the reasoning that you had moved on. That is backwards here: a walkthrough tells
you to click something, and clicking it moves focus to the app being explained
— so following the instruction cancelled the instructions. Focus is a bad proxy
for intent in a tool designed to sit over other software while you use it.

**It is capturable, except for one instant.** Content protection used to be
permanent, which kept Cairn out of the model's screenshots and out of screen
recordings simultaneously — a recording showed a walkthrough happening to an
empty desktop. Those are different needs. It is off by default and switched on
only around the grab.

**The hotkey falls through.** `Ctrl+Space` is also the IME toggle for Japanese,
Chinese and Korean input. If it is taken, Cairn takes `Ctrl+Shift+Space`, then
`Alt+Space`, then `Ctrl+Alt+C`, and reports which one it got in the panel and
the tray.

**One material, two inks.** The panel samples what is behind it and switches
the lettering between light and dark. Tinting the glass itself to suit the
background produced two different cards rather than one piece of glass.

---

## Limits, stated plainly

- **The binary is unsigned.** Windows shows "can't verify the publisher" and
  the user has to choose *More info → Run anyway*. A certificate is a few
  hundred dollars a year.
- **Coordinates come from a vision model** and are sometimes loose. The visual
  design absorbs this rather than hiding it, but a badly wrong answer is still
  a badly wrong answer.
- **One server, one set of keys.** Fine for a team, not for public
  distribution — every user's questions are billed to the same account. Rate
  limiting is per-IP.
- **No true push-to-talk.** Electron's global shortcut fires on key-down only,
  so press-to-start with silence detection replaces hold-to-talk. Real
  push-to-talk needs a native input hook.
- **~390 MB idle**, across six processes. That is Electron holding two renderer
  windows ready so the panel opens instantly.

---

## Where this goes next: from answering to doing

Everything above answers *where is it*. The next version answers *do it*.

The pieces are already in place. Cairn can see the screen, locate a control on
it, and describe a sequence of steps. What it cannot do is press anything. Add
that, and "where is the export button" becomes "export this at 3x".

**What that looks like**

> "Open my LinkedIn profile in Chrome"
> "Solve this LeetCode problem"
> "Change the billing address on this invoice to the Osaka office"

**How it would be built, in order of risk**

1. **Deterministic actions first** — launching an application, opening a URL,
   focusing a window. No vision involved, nothing to get wrong, and it covers a
   surprising share of what people actually ask for.
2. **Single UI actions** — click and type at a located target. This reuses the
   targeting that already exists; the only new capability is synthesising
   input.
3. **Multi-step tasks with verification** — after each action, capture again
   and confirm the screen changed as expected before continuing. Without this
   an agent that mis-clicks once carries on confidently into nonsense.
4. **Trails become procedures.** A saved trail is already an ordered list of
   targets and instructions. The same structure, executed rather than narrated,
   is a recorded automation — and one a colleague can replay.

**The safety model has to come with it, not after**

An assistant that clicks on your behalf is a different proposition from one
that points.

- **Show intent before acting.** The existing overlay already narrates each
  step; an agent should point at what it is about to click, then click it, at a
  pace a person can follow and interrupt.
- **Escape aborts mid-task**, and the abort must be trustworthy — the
  cancellation work already done for in-flight questions is the foundation.
- **Confirm anything irreversible.** Sending, purchasing, deleting, posting.
- **Never type credentials**, and refuse to act on a password field.
- **Verify, do not assume.** Every action is followed by a capture that either
  confirms the expected change or stops.

The honest risk is that step 3 is where most agentic demos quietly fail: they
show a task that works once, on a screen the model has effectively memorised.
The verification loop is what separates a demo from a tool, and it is the part
worth building carefully.
