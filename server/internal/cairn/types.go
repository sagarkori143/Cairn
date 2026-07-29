package cairn

// Domain types.
//
// The product has two halves sharing one vocabulary: the live half (ask about
// what's on screen, get pointed at the answer) and the memory half (that answer
// becomes a Trail the team inherits). A Trail is an ordered list of Steps, and a
// Step is exactly what one live answer produces — saving a trail is a copy, not
// a transformation.

// Region is a rectangle in normalised [0,1] coordinates, relative to the
// captured frame. Normalised rather than pixels so the client can downscale a
// capture for bandwidth without the annotation drifting off its target.
type Region struct {
	X float64 `json:"x"`
	Y float64 `json:"y"`
	W float64 `json:"w"`
	H float64 `json:"h"`
}

// Step is one beat of guidance: what to say, and where to point while saying it.
//
// Target is nil when the answer is purely verbal ("you're already on the right
// screen"), so the client skips the pointer rather than jabbing at an arbitrary
// spot.
type Step struct {
	ID     string  `json:"id"`
	Say    string  `json:"say"`
	Target *Region `json:"target"`
	Label  *string `json:"label"`
	// Frame is a data-URL PNG of the capture this step was taken against.
	// Omitted on live answers — the client already holds the frame it just
	// sent, and echoing a megabyte of base64 back doubles the round trip.
	Frame *string `json:"frame"`
}

// Author is who produced a trail. Mocked identity — see README.
type Author struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	Initials string `json:"initials"`
	Color    string `json:"color"`
}

// Trail is a saved walkthrough — the unit of team memory. One person hits a
// wall, Cairn walks them through it, and the result is stored so nobody on the
// team pays that cost again.
type Trail struct {
	ID       string `json:"id"`
	Title    string `json:"title"`
	Question string `json:"question"`
	// Aliases are extra phrasings that should also match this trail, so
	// someone who words the problem differently still finds it.
	Aliases   []string `json:"aliases"`
	App       string   `json:"app"`
	Steps     []Step   `json:"steps"`
	Author    Author   `json:"author"`
	CreatedAt int64    `json:"createdAt"`
	// ReuseCount increments every time recall serves this instead of the model.
	ReuseCount int `json:"reuseCount"`
}

// AskResult is what POST /api/ask returns.
type AskResult struct {
	// Source is "trail" (recalled from team memory, no model call) or "model"
	// (a fresh vision call).
	Source string `json:"source"`
	Trail  *Trail `json:"trail,omitempty"`
	Steps  []Step `json:"steps"`
	// Summary is spoken before the steps.
	Summary string `json:"summary"`
	// Title and App are suggestions for saving this as a trail.
	Title string `json:"title"`
	App   string `json:"app"`
	// ElapsedMs is surfaced in the UI so recall's speed is legible rather than
	// merely claimed.
	ElapsedMs int64 `json:"elapsedMs"`
}

// ModelAnswer is the shape the vision model is constrained to return.
type ModelAnswer struct {
	Summary string `json:"summary"`
	App     string `json:"app"`
	Title   string `json:"title"`
	Steps   []struct {
		Say    string  `json:"say"`
		Label  *string `json:"label"`
		Target *Region `json:"target"`
	} `json:"steps"`
}

// errorResponse is the single error shape every endpoint returns, so clients
// have exactly one thing to parse on failure.
type errorResponse struct {
	Error     string `json:"error"`
	Code      string `json:"code,omitempty"`
	Retryable bool   `json:"retryable,omitempty"`
}
