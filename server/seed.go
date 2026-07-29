package main

import (
	"fmt"
	"net/url"
	"strings"
	"time"
)

// Seed content for the team library.
//
// This exists so the first screen anyone sees already demonstrates the thesis —
// that a team accumulates trails — instead of an empty state asking them to
// imagine it. These are the trails a small team would plausibly have built in
// its first fortnight.
//
// Seeded frames are deliberately schematic wireframes rather than fake
// screenshots: they read honestly as placeholders while still giving the replay
// view real geometry to annotate. Trails recorded by a user carry actual
// captures.

func ptr(s string) *string { return &s }

var (
	authorPriya = Author{ID: "u_priya", Name: "Priya", Initials: "PR", Color: "#7c5cff"}
	authorMarco = Author{ID: "u_marco", Name: "Marco", Initials: "MA", Color: "#e8734a"}
	authorYuki  = Author{ID: "u_yuki", Name: "Yuki", Initials: "YU", Color: "#2f9e6e"}
)

// wireframe builds a neutral placeholder frame as an SVG data URL, so
// annotations have believable geometry to sit against without shipping any
// third party's UI.
func wireframe(kind string) string {
	var blocks strings.Builder

	switch kind {
	case "sidebar":
		blocks.WriteString(`<rect x="0" y="28" width="180" height="472" fill="#12131a"/>`)
		for i := 0; i < 6; i++ {
			fmt.Fprintf(&blocks, `<rect x="16" y="%d" width="%d" height="12" rx="6" fill="#262838"/>`,
				52+i*34, 132-(i%3)*22)
		}
		blocks.WriteString(`<rect x="212" y="60" width="300" height="16" rx="8" fill="#262838"/>`)
		blocks.WriteString(`<rect x="212" y="96" width="520" height="10" rx="5" fill="#1c1e2a"/>`)
	case "toolbar":
		blocks.WriteString(`<rect x="0" y="28" width="800" height="44" fill="#12131a"/>`)
		for i := 0; i < 7; i++ {
			fmt.Fprintf(&blocks, `<rect x="%d" y="40" width="28" height="20" rx="6" fill="#262838"/>`, 20+i*44)
		}
		blocks.WriteString(`<rect x="600" y="40" width="80" height="20" rx="10" fill="#2f3350"/>`)
		blocks.WriteString(`<rect x="120" y="120" width="560" height="320" rx="10" fill="#12131a"/>`)
	default: // panel
		blocks.WriteString(`<rect x="520" y="28" width="280" height="472" fill="#12131a"/>`)
		for i := 0; i < 4; i++ {
			fmt.Fprintf(&blocks, `<rect x="540" y="%d" width="240" height="40" rx="8" fill="#1c1e2a"/>`, 60+i*60)
		}
		blocks.WriteString(`<rect x="40" y="80" width="440" height="300" rx="10" fill="#12131a"/>`)
	}

	svg := `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="500" viewBox="0 0 800 500">` +
		`<rect width="800" height="500" fill="#0a0b10"/>` +
		`<rect width="800" height="28" fill="#161822"/>` +
		`<circle cx="18" cy="14" r="5" fill="#2c2f42"/><circle cx="36" cy="14" r="5" fill="#2c2f42"/>` +
		blocks.String() + `</svg>`

	return "data:image/svg+xml," + url.PathEscape(svg)
}

func seedTrails() []Trail {
	now := time.Now().UnixMilli()
	hour := int64(60 * 60 * 1000)

	sidebar := wireframe("sidebar")
	panel := wireframe("panel")
	toolbar := wireframe("toolbar")

	return []Trail{
		{
			ID:       "tr_figma_export",
			Title:    "Export a frame at 3x for the App Store",
			Question: "how do I export a figma frame at 3x",
			Aliases: []string{
				"export figma at 3x", "figma export scale",
				"app store screenshot export", "how to export high resolution from figma",
			},
			App:        "Figma",
			Author:     authorPriya,
			CreatedAt:  now - 26*hour,
			ReuseCount: 7,
			Steps: []Step{
				{ID: "s1", Say: "Select the frame you want to export by clicking its name in the layers panel, not the canvas.",
					Label: ptr("Layers panel"), Target: &Region{X: 0.02, Y: 0.12, W: 0.2, H: 0.5}, Frame: &sidebar},
				{ID: "s2", Say: "In the right sidebar, scroll to the bottom and press the plus next to Export.",
					Label: ptr("Export +"), Target: &Region{X: 0.67, Y: 0.62, W: 0.3, H: 0.1}, Frame: &panel},
				{ID: "s3", Say: "Change the multiplier dropdown from 1x to 3x, then click Export frame.",
					Label: ptr("Scale dropdown"), Target: &Region{X: 0.67, Y: 0.74, W: 0.18, H: 0.08}, Frame: &panel},
			},
		},
		{
			ID:       "tr_vercel_env",
			Title:    "Add an environment variable without redeploying by hand",
			Question: "where do I put env vars in vercel",
			Aliases: []string{
				"vercel environment variables", "add secret to vercel",
				"env var not showing up in production", "vercel redeploy after env change",
			},
			App:        "Vercel",
			Author:     authorMarco,
			CreatedAt:  now - 51*hour,
			ReuseCount: 12,
			Steps: []Step{
				{ID: "s1", Say: "Open the project, then Settings, then Environment Variables in the left nav.",
					Label: ptr("Environment Variables"), Target: &Region{X: 0.03, Y: 0.34, W: 0.18, H: 0.07}, Frame: &sidebar},
				{ID: "s2", Say: "Add the key and value, and make sure Production is ticked — this is the step people miss.",
					Label: ptr("Production checkbox"), Target: &Region{X: 0.3, Y: 0.46, W: 0.16, H: 0.07}, Frame: &panel},
				{ID: "s3", Say: "Saving does not rebuild. Go to Deployments and redeploy the latest one, or the variable stays invisible.",
					Label: ptr("Redeploy"), Target: &Region{X: 0.74, Y: 0.16, W: 0.14, H: 0.07}, Frame: &toolbar},
			},
		},
		{
			ID:       "tr_ga_funnel",
			Title:    "Read the drop-off between signup and activation",
			Question: "how do I see where users drop off in analytics",
			Aliases: []string{
				"funnel report", "conversion drop off",
				"activation rate analytics", "where are users churning",
			},
			App:        "Analytics",
			Author:     authorYuki,
			CreatedAt:  now - 8*hour,
			ReuseCount: 3,
			Steps: []Step{
				{ID: "s1", Say: "Open Explore and pick the Funnel exploration template rather than starting blank.",
					Label: ptr("Funnel exploration"), Target: &Region{X: 0.26, Y: 0.24, W: 0.22, H: 0.14}, Frame: &toolbar},
				{ID: "s2", Say: "Drag signup_completed and activation_completed into Steps, in that order.",
					Label: ptr("Steps well"), Target: &Region{X: 0.68, Y: 0.3, W: 0.28, H: 0.12}, Frame: &panel},
				{ID: "s3", Say: "Switch the visualisation to Trended to see whether the drop-off is getting worse over time.",
					Label: ptr("Trended toggle"), Target: &Region{X: 0.68, Y: 0.5, W: 0.28, H: 0.09}, Frame: &panel},
			},
		},
	}
}
