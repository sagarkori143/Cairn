import type { Trail } from "./types";

/**
 * Matches an incoming question against trails the team has already recorded.
 *
 * Why lexical and not embeddings: recall sits directly in front of the model
 * call, so it has to be effectively free — an embedding round-trip would cost
 * most of the latency it is meant to save, and would need a vector store to
 * justify itself. Token overlap against the original question plus curated
 * aliases is crude, but it is instant, debuggable, and runs with no
 * infrastructure. The threshold is tuned to prefer a model call over a wrong
 * trail: showing someone a confidently irrelevant walkthrough is far more
 * damaging to trust than making them wait three seconds.
 */

const STOPWORDS = new Set([
  "a", "an", "the", "how", "do", "does", "did", "i", "you", "we", "to", "in", "on",
  "at", "of", "for", "is", "are", "was", "can", "could", "would", "should", "my",
  "me", "it", "this", "that", "with", "from", "and", "or", "but", "get", "got",
  "where", "what", "when", "why", "which", "please", "help", "need", "want",
  "there", "here", "so", "if", "then", "be", "am", "as", "by", "into", "out",
]);

function tokenize(input: string): string[] {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

/**
 * Weighted overlap of query tokens against a candidate string.
 * Returns 0..1 — the share of the query that the candidate accounts for.
 */
function overlap(queryTokens: string[], candidate: string): number {
  if (queryTokens.length === 0) return 0;
  const candidateTokens = new Set(tokenize(candidate));
  if (candidateTokens.size === 0) return 0;

  let hits = 0;
  for (const t of queryTokens) {
    if (candidateTokens.has(t)) {
      hits += 1;
      continue;
    }
    // Cheap stemming: catches export/exporting, variable/variables.
    for (const c of candidateTokens) {
      if (c.length > 4 && t.length > 4 && (c.startsWith(t) || t.startsWith(c))) {
        hits += 0.75;
        break;
      }
    }
  }
  return Math.min(1, hits / queryTokens.length);
}

export interface RecallHit {
  trail: Trail;
  score: number;
}

/**
 * Below this, we call the model instead. Set high on purpose — see the note
 * at the top of this file about the asymmetric cost of a wrong match.
 */
const THRESHOLD = 0.62;

/**
 * @param question The user's raw question.
 * @param trails   Everything the team has recorded.
 * @returns The best match above threshold, or null to fall through to the model.
 */
export function recall(question: string, trails: Trail[]): RecallHit | null {
  const q = tokenize(question);
  if (q.length === 0) return null;

  let best: RecallHit | null = null;

  for (const trail of trails) {
    // The original question is the strongest signal; aliases exist to catch
    // the phrasings that same question arrives in. Title and app are weaker
    // and only break ties.
    const score = Math.max(
      overlap(q, trail.question),
      ...trail.aliases.map((a) => overlap(q, a)),
      overlap(q, trail.title) * 0.9,
      overlap(q, trail.app) * 0.5,
    );
    if (!best || score > best.score) best = { trail, score };
  }

  return best && best.score >= THRESHOLD ? best : null;
}

/** Free-text filter for the library view. Looser than recall — the user is browsing, not asking. */
export function searchTrails(query: string, trails: Trail[]): Trail[] {
  const q = tokenize(query);
  if (q.length === 0) return trails;
  return trails
    .map((trail) => ({
      trail,
      score: Math.max(
        overlap(q, trail.title),
        overlap(q, trail.question),
        overlap(q, trail.app),
        ...trail.aliases.map((a) => overlap(q, a)),
      ),
    }))
    .filter((r) => r.score > 0.2)
    .sort((a, b) => b.score - a.score)
    .map((r) => r.trail);
}
