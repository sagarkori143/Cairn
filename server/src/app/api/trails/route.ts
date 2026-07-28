import { NextResponse } from "next/server";
import { getStore, storeKind } from "@/lib/store";
import { searchTrails } from "@/lib/recall";
import type { Step, Trail } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The signed-in user. Mocked — see README "Simplified scope". */
const CURRENT_USER = {
  id: "u_you",
  name: "You",
  initials: "YO",
  color: "#3b82f6",
};

export async function GET(req: Request) {
  const q = new URL(req.url).searchParams.get("q")?.trim() ?? "";
  const all = await getStore().list();
  return NextResponse.json({
    trails: q ? searchTrails(q, all) : all,
    storeKind: storeKind(),
  });
}

interface SaveBody {
  title?: string;
  question?: string;
  app?: string;
  steps?: Step[];
}

/**
 * Promotes a live answer into team memory.
 *
 * The aliases we derive here are what make the trail findable later by someone
 * who phrases the problem differently, so they are generated from the question
 * and title rather than left empty.
 */
export async function POST(req: Request) {
  let body: SaveBody;
  try {
    body = (await req.json()) as SaveBody;
  } catch {
    return NextResponse.json({ error: "Malformed request body." }, { status: 400 });
  }

  const { title, question, app, steps } = body;
  if (!title || !question || !steps?.length) {
    return NextResponse.json(
      { error: "A trail needs a title, the original question, and at least one step." },
      { status: 400 },
    );
  }

  const trail: Trail = {
    id: `tr_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`,
    title,
    question,
    aliases: deriveAliases(question, title),
    app: app || "Unknown",
    steps: steps.map((s, i) => ({ ...s, id: s.id || `s${i + 1}` })),
    author: CURRENT_USER,
    createdAt: Date.now(),
    reuseCount: 0,
  };

  await getStore().save(trail);
  return NextResponse.json({ trail });
}

/**
 * Cheap alias generation: the title is usually a cleaner phrasing of the same
 * intent than the question was, so each is an alias for the other.
 */
function deriveAliases(question: string, title: string): string[] {
  const set = new Set<string>();
  set.add(title.toLowerCase());
  set.add(question.toLowerCase());
  // Strip common interrogative framing so "how do I export a frame" also
  // matches a later "export a frame".
  const stripped = question
    .toLowerCase()
    .replace(/^(how (do|can|would) (i|you|we)|where (is|do i)|what('s| is)|why (does|is))\s+/i, "")
    .trim();
  if (stripped) set.add(stripped);
  return [...set];
}
