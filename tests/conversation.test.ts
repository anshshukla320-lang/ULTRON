import { test } from "node:test";
import assert from "node:assert/strict";
import type Anthropic from "@anthropic-ai/sdk";
import { repairToolPairs, stripImages, trimHistory } from "../lib/agent/conversationHistory";

const tu = (id: string) => ({ type: "tool_use" as const, id, name: "run_code", input: {} });
type M = Anthropic.MessageParam;

test("an abandoned confirmation is answered as 'not run'", () => {
  const msgs: M[] = [
    { role: "user", content: "run it" },
    { role: "assistant", content: [{ type: "text", text: "Running." }, tu("a")] },
    { role: "user", content: "never mind" },
  ];
  const out = repairToolPairs(msgs);
  assert.equal(out.length, 3);
  const last = out[2].content as Anthropic.ContentBlockParam[];
  assert.equal(last[0].type, "tool_result");
  assert.equal(last[1].type, "text");
});

test("a valid history is left unchanged", () => {
  const msgs: M[] = [{ role: "user", content: "hi" }, { role: "assistant", content: "hello" }, { role: "user", content: "again" }];
  assert.deepEqual(repairToolPairs(msgs), msgs);
});

test("trimming never starts on a tool_result", () => {
  const msgs: M[] = [];
  for (let i = 0; i < 10; i++) {
    msgs.push(
      { role: "user", content: `q${i}` },
      { role: "assistant", content: [tu(`t${i}`)] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: `t${i}`, content: "r" }] },
      { role: "assistant", content: "a" },
    );
  }
  const t = trimHistory(msgs, 10);
  assert.ok(t.length <= 10);
  assert.equal(typeof t[0].content, "string");
});

test("screenshots are dropped from history sent back to the browser", () => {
  const msgs: M[] = [
    {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "x",
          content: [
            { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "AAAA" } },
            { type: "text", text: "Screenshot" },
          ],
        },
      ],
    },
  ];
  const out = JSON.stringify(stripImages(msgs));
  assert.ok(!out.includes("AAAA"));
  assert.ok(out.includes("[screenshot no longer attached]"));
});
