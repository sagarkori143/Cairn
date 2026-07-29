// Package handler holds Vercel's serverless entry points.
//
// Vercel's Go runtime turns each file in api/ into its own function and calls
// its exported handler, so these are deliberately one line each — all the logic
// lives in internal/cairn, which cmd/server also uses to run the same code as a
// normal long-lived process.
package handler

import (
	"net/http"

	"github.com/sagarkori143/Cairn/internal/cairn"
)

// Ask serves POST /api/ask.
func Ask(w http.ResponseWriter, r *http.Request) {
	cairn.HandleAsk(w, r)
}
