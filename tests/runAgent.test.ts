import "./tempHome";
import { test } from "node:test";
import assert from "node:assert/strict";
import type Anthropic from "@anthropic-ai/sdk";
import { runAgent, resetAdvisorState, ADVISOR_MODEL, type AgentDeps, type AgentEvent, type AgentStart } from "../lib/agent/runAgent";
import type { ToolOutput } from "../lib/agent/tools";
import { fakeClient } from "./fakeClient";

async function collect(start: AgentStart, deps: AgentDeps): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const e of runAgent(start, deps)) out.push(e);
  return out;
}

const system: Anthropic.TextBlockParam[] = [{ type: "text", text: "sys", cache_control: { type: "ephemeral" } }];
const executed: string[] = [];
const execute = async (name: string, input: Record<string, unknown>): Promise<ToolOutput> => {
  executed.push(name);
  if (name === "look_at_screen") return { text: "Screenshot", image: { mediaType: "image/jpeg", data: "BASE64DATA" } };
  if (name === "get_weather") throw new Error("offline");
  return `${name} ok ${JSON.stringify(input)}`;
};
const user = (content: string): AgentStart => ({ messages: [{ role: "user", content }] });
const done = (events: AgentEvent[]) => events.find((e) => e.type === "done") as Extract<AgentEvent, { type: "done" }>;

test("streams text in pieces and caches the prompt", async () => {
  const { client, requests } = fakeClient([{ text: "Good morning, sir. All quiet." }]);
  const events = await collect(user("hi"), { client, system, execute });
  const texts = events.filter((e) => e.type === "text");
  assert.ok(texts.length > 2, "text arrives in several chunks");
  assert.equal(done(events).reply, "Good morning, sir. All quiet.");
  const req = requests[0] as { cache_control?: unknown; tools: { cache_control?: unknown; type?: string }[]; system: unknown };
  assert.deepEqual(req.cache_control, { type: "ephemeral" });
  const own = req.tools.filter((t) => t.type !== "advisor_20260301");
  assert.deepEqual(own.at(-1)?.cache_control, { type: "ephemeral" }, "tool list is cached");
  assert.equal(req.tools.filter((t) => t.cache_control).length, 1);
});

test("auto tools run and their results go back to Claude", async () => {
  const { client, requests } = fakeClient([{ text: "Checking.", tools: [["calculate_bmi", { heightCm: 180, weightKg: 75 }]] }, { text: "Done." }]);
  const events = await collect(user("bmi"), { client, system, execute });
  const d = done(events);
  assert.equal(d.reply, "Checking. Done.", "turns are joined with a space");
  assert.ok(events.some((e) => e.type === "action" && e.action.status === "done"));
  const second = requests[1] as { messages: Anthropic.MessageParam[] };
  const results = second.messages.at(-1)!.content as Anthropic.ToolResultBlockParam[];
  assert.equal(results[0].type, "tool_result");
});

test("confirm-required tools wait for approval, and tokens are single-use", async () => {
  executed.length = 0;
  const { client } = fakeClient([{ tools: [["write_file", { path: "a.txt", content: "x" }]] }, { text: "Saved." }]);
  const first = done(await collect(user("save"), { client, system, execute }));
  assert.ok(first.pending);
  assert.deepEqual(executed, [], "nothing runs before approval");

  const approved = await collect({ resolution: { token: first.pending!.token, approved: true } }, { client, system, execute });
  assert.deepEqual(executed, ["write_file"]);
  assert.equal(done(approved).reply, "Saved.");

  const replay = await collect({ resolution: { token: first.pending!.token, approved: true } }, { client, system, execute });
  assert.equal(replay[0].type, "error");
  assert.deepEqual(executed, ["write_file"], "replayed token runs nothing");
});

test("declined actions are reported to Claude as declined", async () => {
  executed.length = 0;
  const { client, requests } = fakeClient([{ tools: [["power_action", { action: "shutdown" }]] }, { text: "Understood." }]);
  const first = done(await collect(user("shut down"), { client, system, execute }));
  await collect({ resolution: { token: first.pending!.token, approved: false } }, { client, system, execute });
  assert.deepEqual(executed, []);
  assert.match(JSON.stringify(requests[1]), /declined/);
});

test("made-up tools and failing tools become errors, not confirm prompts", async () => {
  const { client } = fakeClient([{ tools: [["delete_everything", {}], ["get_weather", {}]] }, { text: "Sorry." }]);
  const events = await collect(user("x"), { client, system, execute });
  assert.equal(done(events).pending, null);
  const statuses = events.filter((e) => e.type === "action").map((e) => (e as { action: { status: string } }).action.status);
  assert.deepEqual(statuses, ["error", "error"]);
});

test("runs out of steps with a spoken explanation", async () => {
  const { client } = fakeClient([{ tools: [["calculate_bmi", { heightCm: 180, weightKg: 75 }]] }]);
  const d = done(await collect(user("loop"), { client, system, execute }));
  assert.match(d.reply, /more steps than I'm allowed/);
});

test("a tool call cut off by max_tokens is never run", async () => {
  executed.length = 0;
  const { client } = fakeClient([{ text: "Writing", tools: [["calculate_bmi", {}]], stop: "max_tokens" }]);
  await collect(user("x"), { client, system, execute });
  assert.deepEqual(executed, []);
});

test("a refusal still gets a spoken answer", async () => {
  const { client } = fakeClient([{ stop: "refusal" }]);
  assert.match(done(await collect(user("x"), { client, system, execute })).reply, /can't help/);
});

test("screenshots reach Claude but not the history sent back", async () => {
  const { client, requests } = fakeClient([{ tools: [["look_at_screen", {}]] }, { text: "I see an error." }]);
  const d = done(await collect(user("what's on screen"), { client, system, execute }));
  assert.match(JSON.stringify(requests[1]), /BASE64DATA/);
  assert.doesNotMatch(JSON.stringify(d.messages), /BASE64DATA/);
});

test("stopping mid-reply ends quietly", async () => {
  const controller = new AbortController();
  const { client } = fakeClient([{ text: "one two three four five six seven" }]);
  const events: AgentEvent[] = [];
  for await (const e of runAgent(user("talk"), { client, system, execute, signal: controller.signal })) {
    events.push(e);
    if (events.length === 2) controller.abort();
  }
  assert.ok(!events.some((e) => e.type === "error" || e.type === "done"));
});

test("the advisor is offered on every request and reported when used", async () => {
  resetAdvisorState();
  const { client, requests } = fakeClient([{ advisor: true, text: "Let me think that through, sir. Here's the plan." }]);
  const events = await collect(user("plan my week"), { client, system, execute });
  const req = requests[0] as { tools: { type?: string; model?: string }[]; betas?: string[] };
  const advisor = req.tools.find((t) => t.type === "advisor_20260301");
  assert.equal(advisor?.model, ADVISOR_MODEL);
  assert.deepEqual(req.betas, ["advisor-tool-2026-03-01"]);
  assert.ok(events.some((e) => e.type === "action" && e.action.name === "deep_thinking"));
  assert.match(JSON.stringify(done(events).messages), /advisor_tool_result/, "advisor result kept in history");
});

test("if the advisor isn't available, it falls back to plain Sonnet and stays off", async () => {
  resetAdvisorState();
  const { client, requests } = fakeClient([
    { fail: { status: 400, message: "advisor tool is not enabled for this organization" } },
    { text: "Hello, sir." },
    { text: "Again." },
  ]);
  const first = await collect(user("hi"), { client, system, execute });
  assert.equal(done(first).reply, "Hello, sir.");
  assert.equal(requests.length, 2, "retried once");
  assert.ok(!JSON.stringify(requests[1]).includes("advisor_20260301"));
  await collect(user("hi again"), { client, system, execute });
  assert.ok(!JSON.stringify(requests[2]).includes("advisor_20260301"), "stays off afterwards");
  resetAdvisorState();
});

test("a paused turn is continued, not treated as finished", async () => {
  resetAdvisorState();
  const { client, requests } = fakeClient([{ advisor: true, stop: "pause_turn" }, { text: "Considered answer." }]);
  const d = done(await collect(user("hard question"), { client, system, execute }));
  assert.equal(requests.length, 2);
  assert.equal(d.reply, "Considered answer.");
  const second = requests[1] as { messages: { role: string }[] };
  assert.equal(second.messages.at(-1)!.role, "assistant", "resent as-is so it can carry on");
});
