// Command server runs Cairn's API as a normal long-lived process.
//
// This is what `go run ./cmd/server` uses locally, and what you'd deploy to
// anything that runs a container rather than serverless functions. It shares
// every handler with the Vercel entry points in api/ — the only difference is
// who owns the listener.
package main

import (
	"log"
	"net/http"
	"os"
	"time"

	"github.com/sagarkori143/Cairn/internal/cairn"
)

func main() {
	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}

	server := &http.Server{
		Addr:    ":" + port,
		Handler: cairn.Mux(),
		// A vision call runs ~5s and transcription ~1s, so these are generous
		// but bounded: a stalled client must not hold a connection open forever.
		ReadTimeout:  60 * time.Second,
		WriteTimeout: 90 * time.Second,
		IdleTimeout:  120 * time.Second,
	}

	log.Printf("[cairn] listening on :%s", port)
	log.Fatal(server.ListenAndServe())
}
