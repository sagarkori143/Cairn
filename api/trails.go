package handler

import (
	"net/http"

	"github.com/sagarkori143/Cairn/internal/cairn"
)

// Trails serves GET /api/trails.
func Trails(w http.ResponseWriter, r *http.Request) {
	cairn.HandleTrails(w, r)
}
