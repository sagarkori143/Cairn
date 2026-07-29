package handler

import (
	"net/http"

	"github.com/sagarkori143/Cairn/internal/cairn"
)

// ListenToken serves GET /api/listen-token.
func ListenToken(w http.ResponseWriter, r *http.Request) {
	cairn.HandleListenToken(w, r)
}
