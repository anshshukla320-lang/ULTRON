import { NextResponse } from "next/server";
import { escapeHtml } from "@/lib/auth/session";
import { exchangeCodeForToken } from "@/lib/agent/googleAuth";

function page(title: string, body: string) {
  return new NextResponse(
    `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${title}</title>
    <style>
      body{background:#000;color:#ffaa30;font-family:"Courier New",monospace;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;text-align:center;padding:24px}
      .box{border:1px solid rgba(255,170,48,.45);border-radius:6px;padding:28px;max-width:420px;background:rgba(20,10,0,.5)}
      a{color:#ffcc66}
    </style></head>
    <body><div class="box">${body}</div></body></html>`,
    { headers: { "Content-Type": "text/html" } },
  );
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const error = url.searchParams.get("error");

  if (error) {
    return page("Gmail — declined", `<p>Google sign-in was cancelled or declined (${escapeHtml(error)}).</p><p><a href="/api/gmail/auth">Try again</a></p>`);
  }
  if (!code) {
    return page("Gmail — error", `<p>No authorization code received.</p><p><a href="/api/gmail/auth">Try again</a></p>`);
  }

  try {
    await exchangeCodeForToken(code);
    return page(
      "Google — connected",
      `<p>Google connected. ULTRON can now read/send Gmail, and read YouTube likes, Calendar, Drive, Contacts, Tasks, and Photos.</p><p><a href="/">Back to ULTRON</a></p>`,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return page("Gmail — error", `<p>${escapeHtml(msg)}</p><p><a href="/api/gmail/auth">Try again</a></p>`);
  }
}
