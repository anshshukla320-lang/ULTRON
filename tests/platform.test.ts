import "./tempHome";
import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import { TEST_HOME } from "./tempHome";
import { getSettings, updateSettings } from "../lib/agent/settings";
import { priceOf, recordUsage, usageRecords, usageReport, usageSummary } from "../lib/agent/usage";
import { rankPassages, readDocument, resolveDocumentPath, searchDocuments } from "../lib/agent/documents";
import { normalizePhone, whatsappUrl } from "../lib/agent/whatsapp";
import { controlDevice, isSecurityDevice, listDevices, serviceFor } from "../lib/agent/homeAssistant";
import { backgroundTick, lineFor, type BackgroundDeps } from "../lib/agent/background";
import { handleTelegramMessage } from "../lib/agent/telegram";
import type { AgentEvent } from "../lib/agent/runAgent";

test("settings: defaults, partial updates, junk ignored", async () => {
  assert.equal((await getSettings()).advisor, true);
  const s = await updateSettings({ advisor: false, sttEngine: "whisper", dailyBudgetUsd: -3, bogus: 1 } as never);
  assert.equal(s.advisor, false);
  assert.equal(s.sttEngine, "whisper");
  assert.equal(s.dailyBudgetUsd, 0);
  assert.ok(!("bogus" in (await getSettings())));
  await updateSettings({ advisor: true, sttEngine: "browser" });
});

test("usage: prices, advisor iterations, summary", async () => {
  // 1M Sonnet input + 100k output = $2 + $1
  assert.equal(priceOf("claude-sonnet-5", { input_tokens: 1_000_000, output_tokens: 100_000 }), 3);
  // cache reads are 10% of input price, writes 125%
  assert.equal(priceOf("claude-sonnet-5", { cache_read_input_tokens: 1_000_000 }), 0.2);
  assert.equal(priceOf("claude-sonnet-5", { cache_creation_input_tokens: 1_000_000 }), 2.5);
  const split = usageRecords("chat", "claude-sonnet-5", {
    input_tokens: 10,
    output_tokens: 10,
    iterations: [
      { type: "message", model: "claude-sonnet-5", input_tokens: 1000, output_tokens: 100 },
      { type: "advisor_message", model: "claude-opus-5", input_tokens: 2000, output_tokens: 500 },
    ],
  });
  assert.deepEqual(split.map((r) => r.model), ["claude-sonnet-5", "claude-opus-5"], "advisor billed at Opus rates");
  await recordUsage("chat", "claude-sonnet-5", { input_tokens: 500_000, output_tokens: 10_000, cache_read_input_tokens: 500_000 });
  await recordUsage("memory", "claude-haiku-4-5", { input_tokens: 1000, output_tokens: 100 });
  const sum = await usageSummary();
  assert.ok(sum.todayUsd > 1.1 && sum.todayUsd < 1.3, String(sum.todayUsd));
  assert.equal(Math.round(sum.cacheHitRate * 100), 50);
  assert.match(await usageReport(), /Today: \$1\.\d\d/);
});

// A minimal valid one-page PDF containing `text`.
function makePdf(text: string): Buffer {
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    null,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  const stream = `BT /F1 12 Tf 72 700 Td (${text}) Tj ET`;
  objs[3] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

test("documents: search PDFs and text files, read PDFs natively, stay inside allowed folders", async () => {
  const ws = path.join(TEST_HOME, "ULTRON-Agent-Files");
  await fs.mkdir(path.join(ws, "docs"), { recursive: true });
  await fs.writeFile(path.join(ws, "docs", "lease.pdf"), makePdf("The tenant must give sixty days notice before moving out."));
  await fs.writeFile(path.join(ws, "docs", "recipes.md"), "# Dal\nLentils, turmeric, cumin. Simmer for thirty minutes.");
  const hits = await searchDocuments("how much notice must the tenant give");
  assert.match(hits, /lease\.pdf/);
  assert.match(hits, /sixty days notice/);
  assert.doesNotMatch(hits.split("###")[1], /Lentils/, "the lease ranks first");
  assert.match(await searchDocuments("turmeric"), /recipes\.md/);
  assert.match(await searchDocuments("quantum chromodynamics"), /Nothing in 2 document/);

  const pdf = await readDocument("docs/lease.pdf");
  assert.ok(typeof pdf !== "string" && "document" in pdf, "PDF is sent as a document block");
  assert.equal(await readDocument("docs/recipes.md"), "# Dal\nLentils, turmeric, cumin. Simmer for thirty minutes.");
  assert.throws(() => resolveDocumentPath("/etc/passwd"), /outside the folders/);
  assert.throws(() => resolveDocumentPath("../../secret.txt"), /outside the folders/);
  assert.deepEqual(rankPassages(new Map([["a", ["x y z"]]]), "  ", 3), []);
});

test("WhatsApp numbers and links", () => {
  assert.equal(normalizePhone("+91 98765 43210"), "919876543210");
  assert.equal(normalizePhone("098765 43210"), "919876543210", "local number gets the default country code");
  assert.equal(normalizePhone("0044 20 7946 0958"), "442079460958");
  assert.equal(normalizePhone("Priya"), null);
  assert.equal(whatsappUrl("919876543210", "Running late & sorry!"), "whatsapp://send?phone=919876543210&text=Running%20late%20%26%20sorry!");
});

test("Home Assistant: services, security gating, device listing", async (t) => {
  process.env.HOME_ASSISTANT_URL = "http://ha.local:8123/";
  process.env.HOME_ASSISTANT_TOKEN = "tok";
  assert.deepEqual(serviceFor("light.bedroom", "off"), { domain: "light", service: "turn_off" });
  assert.deepEqual(serviceFor("cover.blinds", "close"), { domain: "cover", service: "close_cover" });
  assert.deepEqual(serviceFor("lock.front", "unlock"), { domain: "lock", service: "unlock" });
  assert.throws(() => serviceFor("light.x", "explode"), /Don't know how/);
  assert.ok(isSecurityDevice("lock.front"));
  assert.ok(isSecurityDevice("cover.garage", "garage"));
  assert.ok(!isSecurityDevice("cover.blinds", "blind"));

  const calls: { url: string; body?: string }[] = [];
  t.mock.method(globalThis, "fetch", async (url: string, init?: RequestInit) => {
    calls.push({ url, body: init?.body as string | undefined });
    if (url.endsWith("/api/states")) {
      return Response.json([
        { entity_id: "light.bedroom", state: "on", attributes: { friendly_name: "Bedroom Light", brightness: 128 } },
        { entity_id: "sensor.temp", state: "21", attributes: {} },
        { entity_id: "lock.front_door", state: "locked", attributes: { friendly_name: "Front Door" } },
      ]);
    }
    if (url.includes("/api/states/lock.front_door")) return Response.json({ entity_id: "lock.front_door", state: "locked", attributes: {} });
    if (url.includes("/api/states/light.bedroom")) return Response.json({ entity_id: "light.bedroom", state: "on", attributes: { friendly_name: "Bedroom Light", brightness: 255 } });
    return Response.json([]);
  });
  const list = await listDevices("bedroom");
  assert.equal(list, "light.bedroom — Bedroom Light — on (brightness 50%)");
  assert.match(await controlDevice("light.bedroom", "on", 100), /brightness 100%/);
  const service = calls.find((c) => c.url.includes("/api/services/light/turn_on"));
  assert.deepEqual(JSON.parse(service!.body!), { entity_id: "light.bedroom", brightness_pct: 100 });
  await assert.rejects(controlDevice("lock.front_door", "unlock"), /smart_home_security/);
  assert.ok(!calls.some((c) => c.url.includes("/api/services/lock")), "the lock was never touched");
});

test("background mode: announces only when no page is open", async () => {
  const said: string[] = [];
  const notified: string[] = [];
  const phoned: string[] = [];
  let open = true;
  const deps: BackgroundDeps = {
    pageIsOpen: async () => open,
    takeDue: async () => [{ id: "1", kind: "timer", text: "pasta" }],
    checkProactive: async () => [{ id: "2", kind: "notice", text: "Sir, Standup starts in 5 minutes." }],
    notify: async (_t, b) => void notified.push(b),
    speak: async (t) => void said.push(t),
    phone: async (t) => void phoned.push(t),
    briefing: async () => "Good morning.",
    settings: async () => ({ backgroundSpeech: true, backgroundNotifications: false }),
  };
  assert.deepEqual(await backgroundTick(deps), [], "page open: it announces instead");
  open = false;
  assert.equal((await backgroundTick(deps)).length, 2);
  assert.deepEqual(said, ["Sir, your pasta timer is done.", "Sir, Standup starts in 5 minutes."]);
  assert.deepEqual(notified, [], "notifications switched off");
  assert.equal(phoned.length, 2);
  assert.equal(lineFor({ id: "x", kind: "reminder", text: "call mum" }), "Sir, a reminder: call mum.");
});

test("Telegram: only the owner, and YES/NO confirmations", async () => {
  process.env.TELEGRAM_ALLOWED_CHAT_IDS = "111";
  const sent: [string, string][] = [];
  const starts: unknown[] = [];
  let reply: AgentEvent[] = [];
  const deps = {
    send: async (chat: string, text: string) => void sent.push([chat, text]),
    run: async function* (start: unknown) {
      starts.push(start);
      yield* reply;
    },
  };
  await handleTelegramMessage("999", "turn off the lights", deps);
  assert.match(sent[0][1], /TELEGRAM_ALLOWED_CHAT_IDS=999/);
  assert.equal(starts.length, 0, "strangers never reach the agent");

  reply = [{ type: "done", messages: [{ role: "user", content: "x" }], reply: "Shall I?", pending: { token: "tok1", toolUse: [{ id: "a", name: "power_action", input: { action: "shutdown" } }] } }];
  await handleTelegramMessage("111", "shut down the pc", deps);
  assert.match(sent.at(-1)![1], /Reply YES to go ahead/);
  reply = [{ type: "done", messages: [], reply: "Shutting down in 60 seconds.", pending: null }];
  await handleTelegramMessage("111", "yes", deps);
  assert.deepEqual(starts.at(-1), { resolution: { token: "tok1", approved: true } });
  assert.equal(sent.at(-1)![1], "Shutting down in 60 seconds.");
});
