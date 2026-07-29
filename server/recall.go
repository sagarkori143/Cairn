package main

import (
	"regexp"
	"strings"
)

// Matching an incoming question against trails the team has already recorded.
//
// Why lexical rather than embeddings: recall sits directly in front of the
// model call, so it has to be effectively free. An embedding round-trip would
// cost most of the latency it exists to save, and would need a vector store to
// justify itself. Token overlap against the original question plus curated
// aliases is crude, but it is instant, debuggable, and needs no infrastructure.
//
// The threshold is tuned to prefer a model call over a wrong trail. Showing
// someone a confidently irrelevant walkthrough damages trust far more than
// making them wait three seconds, so the costs are asymmetric and the threshold
// is too.

var stopwords = map[string]bool{
	"a": true, "an": true, "the": true, "how": true, "do": true, "does": true,
	"did": true, "i": true, "you": true, "we": true, "to": true, "in": true,
	"on": true, "at": true, "of": true, "for": true, "is": true, "are": true,
	"was": true, "can": true, "could": true, "would": true, "should": true,
	"my": true, "me": true, "it": true, "this": true, "that": true, "with": true,
	"from": true, "and": true, "or": true, "but": true, "get": true, "got": true,
	"where": true, "what": true, "when": true, "why": true, "which": true,
	"please": true, "help": true, "need": true, "want": true, "there": true,
	"here": true, "so": true, "if": true, "then": true, "be": true, "am": true,
	"as": true, "by": true, "into": true, "out": true,
}

var nonAlphanum = regexp.MustCompile(`[^a-z0-9\s]`)

func tokenize(input string) []string {
	cleaned := nonAlphanum.ReplaceAllString(strings.ToLower(input), " ")
	out := make([]string, 0, 8)
	for _, tok := range strings.Fields(cleaned) {
		if len(tok) > 1 && !stopwords[tok] {
			out = append(out, tok)
		}
	}
	return out
}

// overlap returns the share of the query that a candidate string accounts for,
// in [0,1].
func overlap(queryTokens []string, candidate string) float64 {
	if len(queryTokens) == 0 {
		return 0
	}
	candidateTokens := make(map[string]bool)
	for _, t := range tokenize(candidate) {
		candidateTokens[t] = true
	}
	if len(candidateTokens) == 0 {
		return 0
	}

	hits := 0.0
	for _, t := range queryTokens {
		if candidateTokens[t] {
			hits++
			continue
		}
		// Cheap stemming: catches export/exporting, variable/variables.
		for c := range candidateTokens {
			if len(c) > 4 && len(t) > 4 && (strings.HasPrefix(c, t) || strings.HasPrefix(t, c)) {
				hits += 0.75
				break
			}
		}
	}

	score := hits / float64(len(queryTokens))
	if score > 1 {
		return 1
	}
	return score
}

// RecallHit is a matched trail and the score that matched it.
type RecallHit struct {
	Trail Trail
	Score float64
}

// recallThreshold is set high on purpose — see the note at the top of this file.
const recallThreshold = 0.62

// recall returns the best match above threshold, or nil to fall through to the
// model.
func recall(question string, trails []Trail) *RecallHit {
	q := tokenize(question)
	if len(q) == 0 {
		return nil
	}

	var best *RecallHit
	for i := range trails {
		t := trails[i]

		// The original question is the strongest signal; aliases exist to catch
		// the phrasings that same question arrives in. Title and app are weaker
		// and only break ties.
		score := overlap(q, t.Question)
		for _, alias := range t.Aliases {
			if s := overlap(q, alias); s > score {
				score = s
			}
		}
		if s := overlap(q, t.Title) * 0.9; s > score {
			score = s
		}
		if s := overlap(q, t.App) * 0.5; s > score {
			score = s
		}

		if best == nil || score > best.Score {
			best = &RecallHit{Trail: t, Score: score}
		}
	}

	if best != nil && best.Score >= recallThreshold {
		return best
	}
	return nil
}

// searchTrails is the free-text filter for browsing. Looser than recall,
// because the user is looking rather than asking.
func searchTrails(query string, trails []Trail) []Trail {
	q := tokenize(query)
	if len(q) == 0 {
		return trails
	}

	type scored struct {
		trail Trail
		score float64
	}
	matches := make([]scored, 0, len(trails))

	for _, t := range trails {
		score := overlap(q, t.Title)
		for _, c := range append([]string{t.Question, t.App}, t.Aliases...) {
			if s := overlap(q, c); s > score {
				score = s
			}
		}
		if score > 0.2 {
			matches = append(matches, scored{t, score})
		}
	}

	// Simple insertion sort by score — the list is a team's trails, not a corpus.
	for i := 1; i < len(matches); i++ {
		for j := i; j > 0 && matches[j].score > matches[j-1].score; j-- {
			matches[j], matches[j-1] = matches[j-1], matches[j]
		}
	}

	out := make([]Trail, len(matches))
	for i, m := range matches {
		out[i] = m.trail
	}
	return out
}
