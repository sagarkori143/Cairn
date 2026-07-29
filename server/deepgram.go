package main

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log"
	"net/http"
	"os"
	"strings"
	"time"
)

// Speech to text, via Deepgram.
//
// This lives on the server rather than in the desktop client for the same
// reason the Anthropic key does: an Electron app is a zip archive with a
// different extension, so anything shipped inside it is public. The client
// records audio and posts the bytes here; the key never leaves this process.
//
// Raw HTTP rather than Deepgram's SDK — it is one POST with a bearer token and
// a JSON response, and a dependency would cost more than it saves.

const deepgramEndpoint = "https://api.deepgram.com/v1/listen"

type deepgramClient struct {
	key    string
	model  string
	client *http.Client
}

func newDeepgramClient() *deepgramClient {
	key := os.Getenv("DEEPGRAM_API_KEY")
	if key == "" {
		return nil
	}

	// nova-3 is the current general model and noticeably better on accented
	// English than the local Whisper it replaced, which is the whole reason
	// transcription moved off the device.
	model := os.Getenv("DEEPGRAM_MODEL")
	if model == "" {
		model = "nova-3"
	}

	return &deepgramClient{
		key:   key,
		model: model,
		// Generous, but bounded: a hung upstream request must not pin a
		// connection open indefinitely.
		client: &http.Client{Timeout: 45 * time.Second},
	}
}

type deepgramResponse struct {
	Results struct {
		Channels []struct {
			Alternatives []struct {
				Transcript string  `json:"transcript"`
				Confidence float64 `json:"confidence"`
			} `json:"alternatives"`
		} `json:"channels"`
	} `json:"results"`
}

// transcribe sends raw audio bytes and returns the best transcript.
//
// contentType is passed straight through from the client — Deepgram sniffs the
// container itself, so webm/opus from a browser MediaRecorder works without any
// transcoding on our side.
func (d *deepgramClient) transcribe(ctx context.Context, audio []byte, contentType string) (string, float64, error) {
	if d == nil {
		return "", 0, &upstreamError{
			Message: "Voice input isn't configured on this server. Type your question instead.",
			Status:  503,
		}
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, deepgramEndpoint, bytes.NewReader(audio))
	if err != nil {
		return "", 0, err
	}

	q := req.URL.Query()
	q.Set("model", d.model)
	// smart_format handles punctuation and casing, so the transcript is
	// presentable in the input box without post-processing.
	q.Set("smart_format", "true")
	q.Set("punctuate", "true")
	// The questions here are always spoken by one person at a microphone.
	q.Set("channels", "1")
	req.URL.RawQuery = q.Encode()

	req.Header.Set("Authorization", "Token "+d.key)
	if contentType == "" {
		contentType = "audio/webm"
	}
	req.Header.Set("Content-Type", contentType)

	res, err := d.client.Do(req)
	if err != nil {
		log.Printf("[cairn] deepgram request failed: %v", err)
		return "", 0, &upstreamError{
			Message:   "Couldn't reach the transcription service. Type your question instead.",
			Status:    504,
			Retryable: true,
			cause:     err,
		}
	}
	defer res.Body.Close()

	body, err := io.ReadAll(res.Body)
	if err != nil {
		return "", 0, err
	}

	if res.StatusCode != http.StatusOK {
		log.Printf("[cairn] deepgram %d: %s", res.StatusCode, truncate(string(body), 400))
		switch {
		case res.StatusCode == 401 || res.StatusCode == 403:
			return "", 0, &upstreamError{
				Message: "Transcription is misconfigured on this server. Type your question instead.",
				Status:  503,
			}
		case res.StatusCode == 429:
			return "", 0, &upstreamError{
				Message:   "Transcription is rate limited right now. Try again in a moment.",
				Status:    429,
				Retryable: true,
			}
		default:
			return "", 0, &upstreamError{
				Message:   "Couldn't transcribe that audio. Try again, or type it.",
				Status:    502,
				Retryable: true,
			}
		}
	}

	var parsed deepgramResponse
	if err := json.Unmarshal(body, &parsed); err != nil {
		return "", 0, &upstreamError{
			Message: "Couldn't read the transcription. Type your question instead.",
			Status:  502, Retryable: true, cause: err,
		}
	}

	if len(parsed.Results.Channels) == 0 || len(parsed.Results.Channels[0].Alternatives) == 0 {
		return "", 0, nil
	}
	best := parsed.Results.Channels[0].Alternatives[0]
	return strings.TrimSpace(best.Transcript), best.Confidence, nil
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "…"
}
