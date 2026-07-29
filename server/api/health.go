package handler

import (
	"net/http"

	"github.com/sagarkori143/Cairn/internal/cairn"
)

// Health serves GET /api/health.
func Health(w http.ResponseWriter, r *http.Request) {
	cairn.HandleHealth(w, r)
}
