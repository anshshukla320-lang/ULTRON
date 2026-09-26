import "./tempHome";
import { test } from "node:test";
import assert from "node:assert/strict";
import type Anthropic from "@anthropic-ai/sdk";
import { consolidateConversation, recentEpisodesForPrompt, searchEpisodes, transcriptOf } from "../lib/agent/episodes";
import { recallMemoryForPrompt, rememberFact, rememberNewFacts } from "../lib/agent/memory";

function fakeSummarizer(result: object) {
  const requests: Record<string, unknown>[] = [];
  const client = {
    messages: {
      create: async (body: Record<string, unknown>) => {
        requests.push(body);
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
      },
    },
  } as unknown as Pick<Anthropic, "messages">;
  return { client, requests };
}

const chat: Anthropic.MessageParam[] = [
  { role: "user", content: "I've got a job interview at Infosys on Friday and I'm nervous" },
  { role: "assistant", content: "Good luck, sir. Want me to set a reminder?" },
  { role: "user", content: "yes remind me thursday night to prepare" },
  { role: "assistant", content: "(done: set_reminder)" },
];

test("a finished conversation becomes an episode plus new long-term facts", async () => {
  await rememberFact("User has a job interview at Infosys on Friday");
  const { client, requests } = fakeSummarizer({
    summary: "User has an Infosys job interview on Friday and asked for a Thursday-night prep reminder.",
    mood: "nervous",
    facts: ["User has a job interview at Infosys on Friday.", "User prefers reminders the night before."],
  });
  const { episode, factsAdded } = await consolidateConversation(client, chat, new Date());
  assert.ok(episode);
  assert.equal(factsAdded, 1, "the near-duplicate interview fact is not saved twice");
  assert.match(await recallMemoryForPrompt(), /reminders the night before/);
  const req = requests[0] as { model: string; output_config: { format: { type: string } } };
  assert.equal(req.model, "claude-haiku-4-5");
  assert.equal(req.output_config.format.type, "json_schema");

  assert.match(await recentEpisodesForPrompt(), /today .*Infosys.*\(user seemed nervous\)/);
  assert.match(await searchEpisodes("interview infosys"), /Infosys/);
  assert.match(await searchEpisodes("holiday"), /No past conversations/);
});

test("trivial exchanges aren't summarized", async () => {
  const { client, requests } = fakeSummarizer({ summary: "x", mood: "", facts: [] });
  const r = await consolidateConversation(client, [{ role: "user", content: "open notepad" }]);
  assert.equal(r.episode, null);
  assert.equal(requests.length, 0, "no API call for a two-word command");
});

test("an empty summary saves facts but no episode", async () => {
  const { client } = fakeSummarizer({ summary: "", mood: "", facts: ["User's sister is called Priya."] });
  const r = await consolidateConversation(client, [{ role: "user", content: "my sister Priya is visiting next month from Delhi" }]);
  assert.equal(r.episode, null);
  assert.equal(r.factsAdded, 1);
});

test("fact dedupe and transcripts", async () => {
  assert.equal(await rememberNewFacts(["User's sister is called Priya", "  "]), 0);
  const t = transcriptOf([
    { role: "user", content: "hi" },
    { role: "assistant", content: [{ type: "text", text: "Hello" }, { type: "tool_use", id: "1", name: "get_weather", input: {} }] },
  ]);
  assert.equal(t, "User: hi\nULTRON: Hello\n(ULTRON used get_weather)");
});
