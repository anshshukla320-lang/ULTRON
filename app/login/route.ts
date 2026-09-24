import { NextResponse } from "next/server";
import { escapeHtml, safeNextPath } from "@/lib/auth/session";

export async function GET(req: Request) {
  const params = new URL(req.url).searchParams;
  const failed = params.get("error") === "1";
  const next = safeNextPath(params.get("next"));
  return new NextResponse(
    `<!DOCTYPE html><html><head><meta charset="utf-8"><title>ULTRON — sign in</title><link rel="icon" href="/icon.svg" type="image/svg+xml">
    <style>
      body{background:#000;color:#ffaa30;font-family:"Courier New",monospace;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;text-align:center;padding:24px}
      .box{border:1px solid rgba(255,170,48,.45);border-radius:6px;padding:28px;max-width:360px;width:100%;background:rgba(20,10,0,.5)}
      input{width:100%;box-sizing:border-box;background:#000;border:1px solid rgba(255,170,48,.45);color:#ffcc66;padding:10px;margin-top:12px;font-family:inherit;border-radius:4px}
      button{width:100%;margin-top:14px;padding:10px;background:rgba(255,170,48,.15);border:1px solid rgba(255,170,48,.6);color:#ffcc66;font-family:inherit;border-radius:4px;cursor:pointer}
      button:hover{background:rgba(255,170,48,.3)}
      .error{color:#ff6666;margin-top:10px}
      h1{letter-spacing:.15em;font-size:1.1rem}
    </style></head>
    <body><div class="box">
      <h1>U.L.T.R.O.N.</h1>
      <p>Enter the access password to continue.</p>
      <form method="POST" action="/api/auth/login">
        <input type="password" name="password" placeholder="Password" autofocus required />
        <input type="hidden" name="next" value="${escapeHtml(next)}" />
        <button type="submit">Sign in</button>
      </form>
      ${failed ? '<p class="error">Wrong password.</p>' : ""}
    </div></body></html>`,
    { headers: { "Content-Type": "text/html" } },
  );
}
