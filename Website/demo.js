/**
 * Drives the overlay recreation in the hero.
 *
 * The page shows what Cairn does rather than describing it, and a video would
 * have been the easy way — but a video is a file to host, goes stale the moment
 * the overlay changes, and cannot follow the layout on a phone. This walks the
 * same three-step shape the real walkthrough does, pointing at elements that
 * are genuinely in the page, so it stays correct wherever it is laid out.
 */
(() => {
  const demo = document.getElementById("demo");
  if (!demo) return;

  const cap = document.getElementById("cap");
  const desk = demo.querySelector(".desk");

  const STEPS = [
    { target: 0, say: "Open the account menu in the top right." },
    { target: 1, say: "Choose Billing from the sidebar." },
    { target: 2, say: "Then update the payment method here." },
  ];

  const HOLD = 3200;

  /**
   * Words arrive one at a time, the way the captions do in the app — a whole
   * sentence appearing at once reads as a subtitle rather than as something
   * being said to you.
   */
  function speak(text) {
    cap.textContent = "";
    text.split(/\s+/).forEach((word, i) => {
      const span = document.createElement("span");
      span.className = "w";
      span.textContent = word;
      span.style.animationDelay = `${i * 52}ms`;
      cap.appendChild(span);
    });
  }

  /** Point at an element, in the desk's own coordinates. */
  function aim(el) {
    const box = el.getBoundingClientRect();
    const frame = desk.getBoundingClientRect();
    const x = box.left - frame.left + box.width / 2;
    const y = box.top - frame.top + box.height / 2;
    demo.style.setProperty("--x", `${x}px`);
    demo.style.setProperty("--y", `${y}px`);
  }

  let at = 0;
  let timer = null;

  function play() {
    const step = STEPS[at % STEPS.length];
    const target = demo.querySelector(`[data-target="${step.target}"]`);
    if (target) aim(target);
    speak(step.say);
    at += 1;
  }

  function start() {
    if (timer) return;
    demo.classList.add("on");
    play();
    timer = setInterval(play, HOLD);
  }

  function stop() {
    clearInterval(timer);
    timer = null;
    demo.classList.remove("on");
  }

  // Nothing runs until it is actually on screen: an animation looping behind
  // three sections of scroll is just a battery drain.
  const seen = new IntersectionObserver(
    (entries) => entries.forEach((e) => (e.isIntersecting ? start() : stop())),
    { threshold: 0.35 },
  );
  seen.observe(demo);

  // Re-aim on resize, since the targets move with the layout.
  let settle = null;
  addEventListener("resize", () => {
    clearTimeout(settle);
    settle = setTimeout(() => {
      const step = STEPS[(at - 1 + STEPS.length) % STEPS.length];
      const target = demo.querySelector(`[data-target="${step.target}"]`);
      if (target) aim(target);
    }, 120);
  });
})();
