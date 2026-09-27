import "./tempHome";
import { test } from "node:test";
import assert from "node:assert/strict";
import type Anthropic from "@anthropic-ai/sdk";
import { runAgent, type AgentEvent } from "../lib/agent/runAgent";
import { parseClientTools } from "../lib/agent/clientTools";
import { fakeClient } from "./fakeClient";

const PHONE_TOOLS = parseClientTools([
  { name: "phone_send_sms", description: "Send a text", input_schema: { type: "object", properties: { to: { type: "string" } } } },
  { name: "phone_torch", description: "Torch on/off", input_schema: { type: "object", properties: {} } },
  { name: "open_app", description: "shadowing a PC tool", input_schema: { type: "object" } },
  { name: "phone_bad", description: 42, input_schema: { type: "object" } },
  { name: "phone_noschema", description: "x" },
  { name: "phone_torch", description: "duplicate", input_schema: { type: "object" } },
]);

async function collect(gen: AsyncGenerator<AgentEvent>) {
  const out: AgentEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

test("client tools: only well-formed phone_* tools are accepted", () => {
  assert.deepEqual(PHONE_TOOLS.map((t) => t.name), ["phone_send_sms", "phone_torch"]);
  assert.deepEqual(parseClientTools("nope"), []);
});

test("client tools: phone calls are handed back, server tools in the same turn still run", async () => {
  const { client, requests } = fakeClient([
    { text: "Texting her and checking the weather.", tools: [["phone_send_sms", { to: "Priya" }], ["get_system_info", {}]] },
    { text: "Done." },
  ]);
  const ran: string[] = [];
  const execute = async (name: string) => {
    ran.push(name);
    return `${name} ok`;
  };
  const events = await collect(runAgent({ messages: [{ role: "user", content: "text priya" }] }, { client, system: [], execute, advisor: false, clientTools: PHONE_TOOLS }));
  const done = events.at(-1) as Extract<AgentEvent, { type: "done" }>;
  assert.equal(done.type, "done");
  assert.deepEqual(ran, ["get_system_info"], "the SMS was not run on the PC");
  assert.deepEqual(done.clientCalls?.map((c) => [c.name, c.input]), [["phone_send_sms", { to: "Priya" }]]);
  assert.equal(done.serverResults?.length, 1);
  assert.equal(done.serverResults?.[0].content, "get_system_info ok");
  const sentTools = (requests[0].tools as { name: string }[]).map((t) => t.name);
  assert.ok(sentTools.includes("phone_send_sms") && sentTools.includes("get_system_info"));

  // The phone resumes with the server's results plus its own.
  const resumed: Anthropic.MessageParam[] = [
    ...done.messages,
    { role: "user", content: [...done.serverResults!, { type: "tool_result", tool_use_id: done.clientCalls![0].id, content: "Sent." }] },
  ];
  const events2 = await collect(runAgent({ messages: resumed }, { client, system: [], execute, advisor: false, clientTools: PHONE_TOOLS }));
  const done2 = events2.at(-1) as Extract<AgentEvent, { type: "done" }>;
  assert.equal(done2.reply, "Done.");
  assert.equal(done2.clientCalls, undefined);
  const lastUser = (requests[1].messages as Anthropic.MessageParam[]).at(-1)!;
  assert.equal((lastUser.content as { tool_use_id: string }[]).length, 2, "both results reached Claude");
});

test("client tools: a confirm-needing PC tool in the same turn is deferred, not silently run", async () => {
  const { client } = fakeClient([{ tools: [["phone_torch", {}], ["power_action", { action: "sleep" }]] }]);
  const ran: string[] = [];
  const events = await collect(
    runAgent({ messages: [{ role: "user", content: "torch on and sleep the pc" }] }, { client, system: [], execute: async (n) => (ran.push(n), "x"), advisor: false, clientTools: PHONE_TOOLS }),
  );
  const done = events.at(-1) as Extract<AgentEvent, { type: "done" }>;
  assert.deepEqual(ran, []);
  assert.equal(done.pending, null);
  assert.match(String(done.serverResults?.[0].content), /needs the user's confirmation/);
  assert.equal(done.clientCalls?.[0].name, "phone_torch");
});

test("without client tools, a made-up phone tool is just an unknown tool", async () => {
  const { client } = fakeClient([{ tools: [["phone_send_sms", { to: "x" }]] }, { text: "Sorry." }]);
  const events = await collect(runAgent({ messages: [{ role: "user", content: "text" }] }, { client, system: [], execute: async () => "x", advisor: false }));
  assert.ok(events.some((e) => e.type === "action" && e.action.status === "error" && /no tool named/.test(String(e.action.output))));
});
