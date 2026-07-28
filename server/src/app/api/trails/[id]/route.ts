import { NextResponse } from "next/server";
import { getStore } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const trail = await getStore().get(id);
  if (!trail) {
    return NextResponse.json({ error: "No such trail." }, { status: 404 });
  }
  return NextResponse.json({ trail });
}
