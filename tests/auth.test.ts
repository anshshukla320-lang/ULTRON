import "./tempHome";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createSessionToken, escapeHtml, isValidSessionToken, safeNextPath } from "../lib/auth/session";
import { isLockedOut, recordLoginFailure, recordLoginSuccess } from "../lib/auth/rateLimit";

test("session tokens verify and reject tampering", async () => {
  const token = await createSessionToken();
  assert.ok(await isValidSessionToken(token));
  const [exp, sig] = token.split(".");
  assert.ok(!(await isValidSessionToken(`${Number(exp) + 1}.${sig}`)), "changed expiry");
  assert.ok(!(await isValidSessionToken(`${exp}.${"0".repeat(sig.length)}`)), "forged signature");
  assert.ok(!(await isValidSessionToken(`${Date.now() - 1}.${sig}`)), "expired");
  assert.ok(!(await isValidSessionToken(undefined)));
});

test("post-login redirects stay on this site", () => {
  assert.equal(safeNextPath("/api/spotify/callback?code=1"), "/api/spotify/callback?code=1");
  for (const bad of ["//evil.com", "/\\evil.com", "https://evil.com", "", null]) assert.equal(safeNextPath(bad), "/");
});

test("HTML escaping", () => {
  assert.equal(escapeHtml(`<script>alert("x")</script>&'`), "&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;&amp;&#39;");
});

test("login lockout after 5 failures, cleared by success", () => {
  const key = `test-${Math.random()}`;
  for (let i = 0; i < 4; i++) recordLoginFailure(key);
  assert.equal(isLockedOut(key).locked, false);
  recordLoginFailure(key);
  assert.equal(isLockedOut(key).locked, true);
  recordLoginSuccess(key);
  assert.equal(isLockedOut(key).locked, false);
});
