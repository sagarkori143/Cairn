# Website

The landing page. Three files, no build step, no dependencies — open
`index.html` in a browser and it runs.

```
index.html   the page
styles.css   the app's palette and glass, reused
demo.js      drives the overlay recreation in the hero
```

## Deploying

It is static, so anything that serves files will do. On Vercel, add a second
project pointing at the same repository with **Root Directory** set to
`Website` and the framework preset set to **Other** — the Go API is a separate
project rooted at `server/`, and they deploy independently.

## The hero demo

The hero is not a video. It is the overlay rebuilt in HTML and CSS, pointing at
elements that genuinely exist in the page, walking the same three-step shape
the real walkthrough does.

That was a deliberate choice over a screen recording: a video is a file to
host, goes stale the moment the overlay changes, and cannot reflow on a phone.
This stays correct at any width, and stops animating when scrolled out of view.

## Claims

The numbers on the page are measured against the deployed API, not estimated:
68ms to first paint after the hotkey, 1.1s until the microphone is live, first
transcribed words about 2.5s into a sentence, and ~0ms for a question that is
already a trail. If the app changes, re-measure before editing them.

There are no testimonials and no pricing table. Both would have to be invented.
