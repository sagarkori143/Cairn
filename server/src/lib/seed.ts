import type { Author, Trail } from "./types";

/**
 * Seed content for the team library.
 *
 * This exists so the very first screen a new user sees already demonstrates the
 * thesis — that a team accumulates trails — instead of an empty state that asks
 * them to imagine it. These are the trails a small team would plausibly have
 * built in its first couple of weeks.
 *
 * Seeded frames are deliberately schematic wireframes, not fake screenshots:
 * they read honestly as placeholders while still giving the replay view
 * something real to annotate. Trails you record yourself carry actual captures.
 */

const AUTHORS: Record<string, Author> = {
  priya: { id: "u_priya", name: "Priya", initials: "PR", color: "#7c5cff" },
  marco: { id: "u_marco", name: "Marco", initials: "MA", color: "#e8734a" },
  yuki: { id: "u_yuki", name: "Yuki", initials: "YU", color: "#2f9e6e" },
};

/**
 * Builds a neutral wireframe frame. Renders a chrome bar plus a few content
 * blocks so annotations have believable geometry to sit against.
 */
function wireframe(kind: "sidebar" | "toolbar" | "panel"): string {
  const blocks =
    kind === "sidebar"
      ? `<rect x="0" y="28" width="180" height="472" fill="#12131a"/>
         ${[0, 1, 2, 3, 4, 5]
           .map((i) => `<rect x="16" y="${52 + i * 34}" width="${132 - (i % 3) * 22}" height="12" rx="6" fill="#262838"/>`)
           .join("")}
         <rect x="212" y="60" width="300" height="16" rx="8" fill="#262838"/>
         <rect x="212" y="96" width="520" height="10" rx="5" fill="#1c1e2a"/>
         <rect x="212" y="116" width="470" height="10" rx="5" fill="#1c1e2a"/>`
      : kind === "toolbar"
        ? `<rect x="0" y="28" width="800" height="44" fill="#12131a"/>
         ${[0, 1, 2, 3, 4, 5, 6]
           .map((i) => `<rect x="${20 + i * 44}" y="40" width="28" height="20" rx="6" fill="#262838"/>`)
           .join("")}
         <rect x="600" y="40" width="80" height="20" rx="10" fill="#2f3350"/>
         <rect x="120" y="120" width="560" height="320" rx="10" fill="#12131a"/>`
        : `<rect x="520" y="28" width="280" height="472" fill="#12131a"/>
         ${[0, 1, 2, 3]
           .map((i) => `<rect x="540" y="${60 + i * 60}" width="240" height="40" rx="8" fill="#1c1e2a"/>`)
           .join("")}
         <rect x="40" y="80" width="440" height="300" rx="10" fill="#12131a"/>`;

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="500" viewBox="0 0 800 500">
    <rect width="800" height="500" fill="#0a0b10"/>
    <rect width="800" height="28" fill="#161822"/>
    <circle cx="18" cy="14" r="5" fill="#2c2f42"/><circle cx="36" cy="14" r="5" fill="#2c2f42"/><circle cx="54" cy="14" r="5" fill="#2c2f42"/>
    ${blocks}
  </svg>`;
  // encodeURIComponent keeps this a valid data URL without pulling in a base64
  // dependency, and stays readable in devtools.
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

export const SEED_TRAILS: Trail[] = [
  {
    id: "tr_figma_export",
    title: "Export a frame at 3x for the App Store",
    question: "how do I export a figma frame at 3x",
    aliases: [
      "export figma at 3x",
      "figma export scale",
      "app store screenshot export",
      "how to export high resolution from figma",
    ],
    app: "Figma",
    author: AUTHORS.priya,
    createdAt: Date.now() - 1000 * 60 * 60 * 26,
    reuseCount: 7,
    steps: [
      {
        id: "s1",
        say: "Select the frame you want to export by clicking its name in the layers panel, not the canvas.",
        label: "Layers panel",
        target: { x: 0.02, y: 0.12, w: 0.2, h: 0.5 },
        frame: wireframe("sidebar"),
      },
      {
        id: "s2",
        say: "In the right sidebar, scroll to the bottom and press the plus next to Export.",
        label: "Export +",
        target: { x: 0.67, y: 0.62, w: 0.3, h: 0.1 },
        frame: wireframe("panel"),
      },
      {
        id: "s3",
        say: "Change the multiplier dropdown from 1x to 3x, then click Export frame.",
        label: "Scale dropdown",
        target: { x: 0.67, y: 0.74, w: 0.18, h: 0.08 },
        frame: wireframe("panel"),
      },
    ],
  },
  {
    id: "tr_vercel_env",
    title: "Add an environment variable without redeploying by hand",
    question: "where do I put env vars in vercel",
    aliases: [
      "vercel environment variables",
      "add secret to vercel",
      "env var not showing up in production",
      "vercel redeploy after env change",
    ],
    app: "Vercel",
    author: AUTHORS.marco,
    createdAt: Date.now() - 1000 * 60 * 60 * 51,
    reuseCount: 12,
    steps: [
      {
        id: "s1",
        say: "Open the project, then Settings, then Environment Variables in the left nav.",
        label: "Environment Variables",
        target: { x: 0.03, y: 0.34, w: 0.18, h: 0.07 },
        frame: wireframe("sidebar"),
      },
      {
        id: "s2",
        say: "Add the key and value, and make sure Production is ticked — this is the step people miss.",
        label: "Production checkbox",
        target: { x: 0.3, y: 0.46, w: 0.16, h: 0.07 },
        frame: wireframe("panel"),
      },
      {
        id: "s3",
        say: "Saving does not rebuild. Go to Deployments and redeploy the latest one, or the variable stays invisible.",
        label: "Redeploy",
        target: { x: 0.74, y: 0.16, w: 0.14, h: 0.07 },
        frame: wireframe("toolbar"),
      },
    ],
  },
  {
    id: "tr_ga_funnel",
    title: "Read the drop-off between signup and activation",
    question: "how do I see where users drop off in analytics",
    aliases: [
      "funnel report",
      "conversion drop off",
      "activation rate analytics",
      "where are users churning",
    ],
    app: "Analytics",
    author: AUTHORS.yuki,
    createdAt: Date.now() - 1000 * 60 * 60 * 8,
    reuseCount: 3,
    steps: [
      {
        id: "s1",
        say: "Open Explore and pick the Funnel exploration template rather than starting blank.",
        label: "Funnel exploration",
        target: { x: 0.26, y: 0.24, w: 0.22, h: 0.14 },
        frame: wireframe("toolbar"),
      },
      {
        id: "s2",
        say: "Drag signup_completed and activation_completed into Steps, in that order.",
        label: "Steps well",
        target: { x: 0.68, y: 0.3, w: 0.28, h: 0.12 },
        frame: wireframe("panel"),
      },
      {
        id: "s3",
        say: "Switch the visualisation to Trended to see whether the drop-off is getting worse over time.",
        label: "Trended toggle",
        target: { x: 0.68, y: 0.5, w: 0.28, h: 0.09 },
        frame: wireframe("panel"),
      },
    ],
  },
];
