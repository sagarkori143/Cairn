# Website

The landing page. Three files, no build step, no dependencies — open
`index.html` and it runs.

```
index.html   the page
styles.css   the overlay, and one colour rule
site.js      scroll as the playhead
```

## The idea

The page is treated as a screen and given the product's own treatment. A real
overlay sits over the whole document — the dim, the feathered hole, the ripples,
the cursor, the captions — and **scroll is the playhead**: whichever step is
nearest the middle of the viewport is the one being explained. You set the pace
by reading, which is how a walkthrough is actually paced.

The part worth keeping: **scroll back up past something you have already been
shown and the marks turn green and the caption says "already a trail".** That is
the product's whole thesis — the second answer is free — expressed as an
interaction rather than a paragraph claiming it.

## One colour rule

Orange appears **only where Cairn is pointing**. Not headings, not links, not
decoration. So when the spotlight lands, the colour means what it means in the
product, and the page stays quiet everywhere else. Green is reserved just as
narrowly, for something already known.

Breaking this is the fastest way to make the page look like every other landing
page.

## Notes for changing it

- The hole is an **ellipse sized to the whole step**, not a circle on its
  heading. A circle dimmed the paragraph belonging to the step being explained,
  which defeated the point.
- `--x`, `--y`, `--r`, `--rx`, `--ry`, `--hx`, `--hy` are registered with
  `@property` so they can be transitioned. Without registration a custom
  property snaps, and the marks would glide while the hole jumped.
- Ripple speed is driven by scroll velocity. Motion that responds to the reader
  is doing something; motion on a fixed loop is wallpaper.
- Anything with `data-step`, `data-say` and `data-label` becomes a step. That is
  the whole authoring interface — add the attributes and it joins the
  walkthrough.

## Claims

The numbers are measured against the deployed API, not estimated: 68ms to first
paint after the hotkey, 1.1s until the microphone is live, first transcribed
words about 2.5s into a sentence, ~0ms for a question already answered.
Re-measure before editing them.

No testimonials and no pricing table. Both would have to be invented.

## Deploying

Static, so anything that serves files will do. On Vercel, a second project on
the same repository with **Root Directory** set to `Website` and the framework
preset set to **Other** — the Go API is its own project rooted at `server/`.
