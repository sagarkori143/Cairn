/**
 * The page walks you through itself.
 *
 * Everything here exists to make one point without stating it: Cairn takes over
 * a screen, dims what does not matter, and puts a mark on what does. So the
 * page is treated as a screen and given the same treatment, with scroll as the
 * playhead rather than a timeline — whichever step is nearest the middle of the
 * viewport is the one being explained, and you control the pace by scrolling,
 * the way you would control a walkthrough by reading at your own speed.
 *
 * The part worth stealing: scrolling back up to something you have already been
 * shown turns the marks green and labels them "already a trail". That is the
 * product's whole thesis — the second answer is free — expressed as an
 * interaction rather than a paragraph claiming it.
 */
(() => {
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;

  const cairn = document.getElementById("cairn");
  const capText = document.getElementById("capText");
  const capBadge = document.getElementById("capBadge");
  const steps = [...document.querySelectorAll("[data-step]")];
  const stones = [...document.querySelectorAll(".stone")];
  const navHint = document.getElementById("navHint");

  /* --------------------------------------------------------- word by word */

  function say(el, text) {
    el.textContent = "";
    text.split(/\s+/).forEach((word, i) => {
      const span = document.createElement("span");
      span.className = "w";
      span.textContent = word;
      span.style.animationDelay = `${i * 46}ms`;
      el.appendChild(span);
    });
  }

  // The headline is transcribed rather than typed: same treatment the app gives
  // a spoken sentence, applied to the first thing anyone reads.
  document.querySelectorAll("#headline .line, .scroll-cue").forEach((line, li) => {
    const text = line.textContent.trim();
    line.textContent = "";
    text.split(/\s+/).forEach((word, i) => {
      const span = document.createElement("span");
      span.className = "w";
      span.textContent = word;
      span.style.animationDelay = `${li * 340 + i * 55}ms`;
      line.appendChild(span);
    });
  });

  /* ------------------------------------------------------- the walkthrough */

  const seen = new Set();
  let current = null;

  function focus(step) {
    if (step === current) return;
    current = step;

    if (!step) {
      cairn.classList.remove("on");
      return;
    }

    // Revisiting is the interesting case: it is what the product is for.
    const already = seen.has(step);
    seen.add(step);

    cairn.classList.toggle("recalled", already);
    cairn.classList.add("on");

    capBadge.textContent = already ? "already a trail" : step.dataset.label || "step";
    say(capText, already ? "You have been here — this one is free." : step.dataset.say);
  }

  function aim(step) {
    const box = step.getBoundingClientRect();

    // The ring marks the heading, because that is where reading starts. The
    // hole clears the whole block, because the paragraph under that heading is
    // the thing being explained and dimming it defeats the point.
    const head = step.querySelector("h2, h3") ?? step;
    const hb = head.getBoundingClientRect();

    cairn.style.setProperty("--x", `${hb.left + Math.min(hb.width, 240) / 2}px`);
    cairn.style.setProperty("--y", `${hb.top + hb.height / 2}px`);
    cairn.style.setProperty("--r", `${Math.max(64, Math.min(hb.height * 1.2, 120))}px`);

    // Generous, and measured from the block's centre rather than the heading's,
    // so a wide row is cleared end to end instead of fading out mid-sentence.
    const cx = box.left + box.width / 2;
    const cy = box.top + box.height / 2;
    cairn.style.setProperty("--rx", `${Math.min(box.width * 0.78 + 150, innerWidth * 0.62)}px`);
    cairn.style.setProperty("--ry", `${box.height * 0.72 + 110}px`);

    // Nudge the hole toward the block so a tall step is not lit from its top
    // edge, while the marks stay on the heading.
    cairn.style.setProperty("--hx", `${cx}px`);
    cairn.style.setProperty("--hy", `${cy}px`);

    return box;
  }

  /* ----------------------------------------------- scroll speed and stones */

  let lastY = scrollY;
  let velocity = 0;

  function onFrame() {
    const dy = Math.abs(scrollY - lastY);
    lastY = scrollY;
    velocity += (dy - velocity) * 0.2;

    // Fast scrolling makes the marks pulse harder. Motion that responds to the
    // reader is doing something; motion on a fixed loop is wallpaper.
    const pulse = Math.max(0.9, 2.6 - velocity * 0.05);
    cairn.style.setProperty("--pulse", `${pulse}s`);

    // Which step owns the middle of the screen.
    const mid = innerHeight * 0.46;
    let best = null;
    let bestGap = Infinity;

    for (const step of steps) {
      const box = step.getBoundingClientRect();
      const centre = box.top + box.height / 2;
      const gap = Math.abs(centre - mid);
      if (gap < bestGap && box.bottom > 40 && box.top < innerHeight - 40) {
        bestGap = gap;
        best = step;
      }
    }

    // Only take over when something is genuinely central, so the page is
    // readable in between rather than permanently dimmed.
    if (best && bestGap < innerHeight * 0.3) {
      aim(best);
      focus(best);
    } else {
      focus(null);
    }

    const progress = scrollY / Math.max(1, document.body.scrollHeight - innerHeight);
    stones.forEach((stone, i) => stone.classList.toggle("set", progress > i / stones.length));

    if (navHint) navHint.classList.toggle("gone", scrollY > 260);

    requestAnimationFrame(onFrame);
  }

  if (!reduced) requestAnimationFrame(onFrame);

  /* ------------------------------------------- counters and the two meters */

  const reveal = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const el = entry.target;

        if (el.classList.contains("meter")) {
          el.classList.add("shown");
        } else if (el.dataset.count !== undefined) {
          countTo(el, parseFloat(el.dataset.count), el.dataset.unit);
        }
        reveal.unobserve(el);
      }
    },
    { threshold: 0.4 },
  );

  document.querySelectorAll(".meter, [data-count]").forEach((el) => reveal.observe(el));

  function countTo(el, target, unit) {
    if (reduced || target === 0) {
      el.innerHTML = `${target}<small>${unit}</small>`;
      return;
    }
    const decimals = String(target).includes(".") ? 1 : 0;
    const started = performance.now();
    const run = (now) => {
      const t = Math.min(1, (now - started) / 900);
      const eased = 1 - Math.pow(1 - t, 3);
      el.innerHTML = `${(target * eased).toFixed(decimals)}<small>${unit}</small>`;
      if (t < 1) requestAnimationFrame(run);
    };
    requestAnimationFrame(run);
  }

  /* ----------------------------------------------------- point at anything */

  const win = document.querySelector(".win");
  const winRing = document.getElementById("winRing");
  const winTip = document.getElementById("winTip");

  if (win && winRing && winTip) {
    const hots = [...win.querySelectorAll(".hot")];

    win.addEventListener("pointermove", (e) => {
      const frame = win.getBoundingClientRect();

      // Snap to the nearest control rather than trailing the pointer exactly.
      // Cairn points at things, not at coordinates, and a ring that lands
      // squarely on a row reads as intent where a floating one reads as a cursor.
      let nearest = null;
      let bestGap = Infinity;

      for (const hot of hots) {
        const box = hot.getBoundingClientRect();
        const cx = box.left + box.width / 2;
        const cy = box.top + box.height / 2;
        const gap = Math.hypot(e.clientX - cx, e.clientY - cy);
        if (gap < bestGap) {
          bestGap = gap;
          nearest = { hot, x: cx - frame.left, y: cy - frame.top };
        }
      }

      if (!nearest) return;
      hots.forEach((h) => h.classList.toggle("lit", h === nearest.hot));
      win.classList.add("live");
      winRing.style.left = `${nearest.x}px`;
      winRing.style.top = `${nearest.y}px`;
      winTip.style.left = `${nearest.x}px`;
      winTip.style.top = `${nearest.y}px`;
      winTip.textContent = nearest.hot.dataset.hot;
    });

    win.addEventListener("pointerleave", () => {
      win.classList.remove("live");
      hots.forEach((h) => h.classList.remove("lit"));
    });
  }
})();
