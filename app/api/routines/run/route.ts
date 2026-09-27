import { NextResponse } from "next/server";
import { findRoutine, routineNeedsConfirmation, runRoutine } from "@/lib/agent/routines";
import { executeTool, TOOL_POLICY, type ToolName } from "@/lib/agent/tools";

export const runtime = "nodejs";

/** One-tap / location-triggered routines from the phone. Only routines that
 *  need no confirmation run this way; the rest must go through ULTRON. */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as { name?: string } | null;
  const name = String(body?.name ?? "").trim();
  if (!findRoutine(name)) return NextResponse.json({ error: `No routine called "${name}".` }, { status: 404 });
  if (routineNeedsConfirmation(name, TOOL_POLICY)) {
    return NextResponse.json({ error: `"${name}" has a step that needs confirming — ask ULTRON to run it instead.` }, { status: 409 });
  }
  const result = await runRoutine(name, (tool, input) => executeTool(tool as ToolName, input));
  return NextResponse.json({ result });
}
