import { readSecurityPhoto } from "@/lib/agent/security";

export const runtime = "nodejs";

/** ?id=… — a security snapshot, for the phone's notification. */
export async function GET(req: Request) {
  const photo = await readSecurityPhoto(new URL(req.url).searchParams.get("id") ?? "");
  if (!photo) return new Response("Not found.", { status: 404 });
  return new Response(new Uint8Array(photo), { headers: { "Content-Type": "image/jpeg", "Cache-Control": "private, max-age=86400" } });
}
