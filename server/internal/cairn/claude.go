package cairn

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"os"
	"strings"

	"github.com/anthropics/anthropic-sdk-go"
	"github.com/anthropics/anthropic-sdk-go/option"
)

// The single model call behind live guidance.
//
// Design notes worth knowing before editing:
//
//   - Effort is pinned low. This is a latency-critical, single-screenshot
//     reading task, not a reasoning task — the user is waiting with their
//     screen shared. Measured on the previous implementation: warm average
//     4936ms with thinking on versus 4851ms with it disabled, identical
//     pointing accuracy. An 85ms gap is noise, so thinking stays on, since
//     disabling it on this model can leak reasoning into the visible answer.
//
//   - Output is constrained by JSON schema rather than parsed out of prose, so
//     pointer coordinates are structurally guaranteed and the handlers never
//     have to defend against a malformed answer.
//
//   - Coordinates are normalised 0..1, so the client can downscale frames for
//     bandwidth without the annotation drifting off target.

const claudeModel = anthropic.ModelClaudeOpus5

const systemPrompt = `You are Cairn, a guide that looks at someone's screen and shows them the next thing to do.

You are given one screenshot and one question. Answer only about what is actually visible.

How to answer:
- Give one to four steps. Each step is one action the person performs.
- Point at things. For each step, set "target" to the bounding box of the exact control to interact with, in normalized coordinates where (0,0) is the top-left of the image and (1,1) is the bottom-right. Keep the box tight around the control.
- Set "target" to null only when the step genuinely has no on-screen referent (for example, "wait for the build to finish").
- If what they need is not on this screen, say so plainly in the first step and point at the control that navigates there.
- If the screenshot does not show enough to answer, say what you can see and what you need them to open. Never invent a control that is not visible.

How to write:
- Speak the steps aloud to a colleague. Short sentences, plain words, second person.
- Be brief. Skip preamble, restating the question, and closing offers of further help.
- Do not number the steps; the interface does that.
- Do not describe the screenshot back to them. They are looking at it.`

// answerSchema constrains the response. Every object sets additionalProperties
// false and lists required fields, which is what makes the structured-output
// guarantee hold.
var answerSchema = map[string]any{
	"type": "object",
	"properties": map[string]any{
		"summary": map[string]any{
			"type":        "string",
			"description": "One sentence, spoken aloud before the steps. Say what the user is about to do, not what you are doing.",
		},
		"app": map[string]any{
			"type":        "string",
			"description": "Best guess at the application visible on screen, e.g. 'Figma'. Use 'Unknown' if unclear.",
		},
		"title": map[string]any{
			"type":        "string",
			"description": "A short imperative title if this were saved for a teammate. Max 60 characters.",
		},
		"steps": map[string]any{
			"type":        "array",
			"description": "One to four steps. Each is a single concrete action.",
			"items": map[string]any{
				"type": "object",
				"properties": map[string]any{
					"say": map[string]any{
						"type":        "string",
						"description": "The instruction, spoken aloud. One action, imperative voice, no preamble.",
					},
					"label": map[string]any{
						"type":        []string{"string", "null"},
						"description": "Two or three words naming the thing being pointed at. Null if not pointing at anything.",
					},
					"target": map[string]any{
						"type":        []string{"object", "null"},
						"description": "Normalized bounding box of the element to point at, or null.",
						"properties": map[string]any{
							"x": map[string]any{"type": "number"},
							"y": map[string]any{"type": "number"},
							"w": map[string]any{"type": "number"},
							"h": map[string]any{"type": "number"},
						},
						"required":             []string{"x", "y", "w", "h"},
						"additionalProperties": false,
					},
				},
				"required":             []string{"say", "label", "target"},
				"additionalProperties": false,
			},
		},
	},
	"required":             []string{"summary", "app", "title", "steps"},
	"additionalProperties": false,
}

// upstreamError is a failure worth showing a person.
//
// The raw SDK error is a JSON blob with a request id in it — fine in a log,
// useless in a UI, and it leaks provider internals to anyone poking at a public
// endpoint. Each of these maps to a specific recovery, and every one is a state
// a user could plausibly land in.
type upstreamError struct {
	Message   string
	Status    int
	Retryable bool
	cause     error
}

func (e *upstreamError) Error() string { return e.Message }
func (e *upstreamError) Unwrap() error { return e.cause }

var errNoAPIKey = errors.New("ANTHROPIC_API_KEY is not set")

type claudeClient struct {
	client anthropic.Client
	effort anthropic.OutputConfigEffort
}

func newClaudeClient() *claudeClient {
	key := os.Getenv("ANTHROPIC_API_KEY")
	if key == "" {
		return nil
	}

	effort := anthropic.OutputConfigEffortLow
	switch strings.ToLower(os.Getenv("CAIRN_EFFORT")) {
	case "medium":
		effort = anthropic.OutputConfigEffortMedium
	case "high":
		effort = anthropic.OutputConfigEffortHigh
	}

	return &claudeClient{
		client: anthropic.NewClient(option.WithAPIKey(key)),
		effort: effort,
	}
}

// readScreen reads a capture and returns pointed, spoken guidance.
func (c *claudeClient) readScreen(ctx context.Context, frameBase64, mediaType, question string) (*ModelAnswer, error) {
	if c == nil {
		return nil, errNoAPIKey
	}

	resp, err := c.client.Messages.New(ctx, anthropic.MessageNewParams{
		Model:     claudeModel,
		MaxTokens: 2048,
		System: []anthropic.TextBlockParam{
			{Text: systemPrompt},
		},
		Thinking: anthropic.ThinkingConfigParamUnion{
			OfAdaptive: &anthropic.ThinkingConfigAdaptiveParam{},
		},
		OutputConfig: anthropic.OutputConfigParam{
			Effort: c.effort,
			Format: anthropic.JSONOutputFormatParam{Schema: answerSchema},
		},
		Messages: []anthropic.MessageParam{
			anthropic.NewUserMessage(
				anthropic.NewImageBlockBase64(mediaType, frameBase64),
				anthropic.NewTextBlock(question),
			),
		},
	})
	if err != nil {
		log.Printf("[cairn] vision call failed: %v", err)
		return nil, toUpstreamError(err)
	}

	// Safety classifiers can decline with a normal 200 — check before reading
	// content, or this indexes into an empty slice.
	if resp.StopReason == anthropic.StopReasonRefusal {
		return nil, &upstreamError{
			Message: "Cairn couldn't answer that one. Try rephrasing, or ask about a different part of the screen.",
			Status:  422,
		}
	}

	for _, block := range resp.Content {
		if text := block.AsText(); text.Text != "" {
			var answer ModelAnswer
			if err := json.Unmarshal([]byte(text.Text), &answer); err != nil {
				return nil, &upstreamError{
					Message: "Cairn couldn't read your screen just then. Try asking again.",
					Status:  502, Retryable: true, cause: err,
				}
			}
			return &answer, nil
		}
	}

	return nil, &upstreamError{Message: "The model returned no answer.", Status: 502, Retryable: true}
}

// toUpstreamError translates provider failures into things worth reading.
func toUpstreamError(err error) error {
	var apiErr *anthropic.Error
	if !errors.As(err, &apiErr) {
		return &upstreamError{
			Message:   "Couldn't reach the model. Check your connection and try again.",
			Status:    504,
			Retryable: true,
			cause:     err,
		}
	}

	// An exhausted balance arrives as a 400 rather than a 402, so the status
	// alone can't distinguish it from a genuinely malformed request.
	if apiErr.StatusCode == 400 && strings.Contains(strings.ToLower(apiErr.Error()), "credit balance is too low") {
		return &upstreamError{
			Message: "Cairn's API credit has run out, so live answers are paused. Saved trails still work.",
			Status:  503,
			cause:   err,
		}
	}

	switch {
	case apiErr.StatusCode == 401:
		return &upstreamError{
			Message: "Cairn's API key was rejected, so live answers are off. Browsing trails still works.",
			Status:  503, cause: err,
		}
	case apiErr.StatusCode == 429:
		return &upstreamError{
			Message: "Too many questions reaching the model right now. Give it a few seconds.",
			Status:  429, Retryable: true, cause: err,
		}
	case apiErr.StatusCode >= 500:
		return &upstreamError{
			Message: "The model is busy. Try that again in a moment.",
			Status:  503, Retryable: true, cause: err,
		}
	}

	return &upstreamError{
		Message:   "Cairn couldn't read your screen just then. Try asking again.",
		Status:    502,
		Retryable: true,
		cause:     err,
	}
}
