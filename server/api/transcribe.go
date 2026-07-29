package handler

import (
	"net/http"

	"github.com/sagarkori143/Cairn/internal/cairn"
)

// Transcribe serves POST /api/transcribe.
func Transcribe(w http.ResponseWriter, r *http.Request) {
	cairn.HandleTranscribe(w, r)
}
