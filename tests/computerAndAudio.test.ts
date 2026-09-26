import "./tempHome";
import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import type Anthropic from "@anthropic-ai/sdk";
import { comboToVks, geometryFor, keyToVk, operateComputer, opsFor, type Executor } from "../lib/agent/computerUse";
import { Vad, downsample, encodeWav } from "../lib/audio";
import { cleanTranscript } from "../lib/agent/whisperStt";
import { detectWake, leadingWakeCommand } from "../lib/voiceCommands";

test("keys map to Windows virtual-key codes", () => {
  assert.equal(keyToVk("Return"), 0x0d);
  assert.equal(keyToVk("a"), 0x41);
  assert.equal(keyToVk("F5"), 0x74);
  assert.deepEqual(comboToVks("ctrl+shift+n"), [0x11, 0x10, 0x4e]);
  assert.deepEqual(comboToVks("alt+Tab"), [0x12, 0x09]);
  assert.deepEqual(comboToVks("ctrl++"), [0x11, 0xbb]);
  assert.throws(() => keyToVk("Hyper"), /Unknown key/);
});

test("screenshot scaling and coordinate mapping", () => {
  const g = geometryFor(0, 0, 1920, 1080);
  assert.ok(g.scale < 1 && Math.round(1920 * g.scale) <= 1568);
  const ops = opsFor("left_click", { coordinate: [100, 50], text: "shift" }, g, () => "f");
  assert.deepEqual(ops[0], { op: "move", x: Math.round(100 / g.scale), y: Math.round(50 / g.scale) });
  assert.deepEqual(ops[1], { op: "keys", vks: [0x10], up: false }, "modifier held around the click");
  assert.throws(() => opsFor("left_click", { coordinate: [5000, 10] }, g, () => "f"), /outside the screenshot/);
  const scroll = opsFor("scroll", { scroll_direction: "down", scroll_amount: 3 }, g, () => "f");
  assert.deepEqual(scroll, [{ op: "scroll", dx: 0, dy: -3 }]);
  assert.equal(opsFor("key", { text: "Tab", repeat: 4 }, g, () => "f").filter((o) => o.op === "keys").length, 8);
  const zoom = opsFor("zoom", { region: [0, 0, 100, 100] }, g, () => "z.jpg")[0];
  assert.equal(zoom.op, "shot");
});

test("operate_computer: runs batches, echoes toolset_name, halts on failure, reports", async () => {
  const requests: Record<string, unknown>[] = [];
  const replies = [
    {
      stop_reason: "tool_use",
      content: [
        { type: "tool_use", id: "t1", name: "screenshot", toolset_name: "computer", input: {} },
        { type: "tool_use", id: "t2", name: "left_click", toolset_name: "computer", input: { coordinate: [10, 10] } },
      ],
    },
    {
      stop_reason: "tool_use",
      content: [
        { type: "tool_use", id: "t3", name: "key", toolset_name: "computer", input: { text: "NoSuchKey" } },
        { type: "tool_use", id: "t4", name: "type", toolset_name: "computer", input: { text: "hi" } },
      ],
    },
    { stop_reason: "end_turn", content: [{ type: "text", text: "Opened the file, sir." }] },
  ];
  const client = {
    beta: {
      messages: {
        create: async (body: Record<string, unknown>) => {
          requests.push(structuredClone(body));
          return { model: "claude-opus-5", usage: { input_tokens: 1, output_tokens: 1 }, ...replies[requests.length - 1] };
        },
      },
    },
  } as unknown as Pick<Anthropic, "beta">;
  const ran: string[] = [];
  const executor: Executor = {
    geometry: async () => geometryFor(0, 0, 1280, 720),
    run: async (ops) => {
      for (const o of ops) {
        ran.push(o.op);
        if (o.op === "shot") await fs.writeFile(o.file, Buffer.from([0xff, 0xd8, 0xff]));
      }
      return { failsafe: false, cursor: [] };
    },
  };
  const summary = await operateComputer("open my notes", { client, executor });
  assert.equal(summary, "Opened the file, sir.");
  const first = requests[0] as { tools: { type: string }[]; model: string };
  assert.deepEqual(first.tools, [{ type: "computer_toolset_20260801" }]);
  const second = requests[1] as { messages: { role: string; content: { toolset_name?: string; content: unknown; is_error?: boolean }[] }[] };
  const results = second.messages.at(-1)!.content;
  assert.ok(results.every((r) => r.toolset_name === "computer"));
  assert.equal((results[0].content as { type: string }[])[0].type, "image");
  const third = requests[2] as typeof second;
  const [bad, skipped] = third.messages.at(-1)!.content;
  assert.ok(bad.is_error);
  assert.equal(skipped.content, "Not executed: an earlier computer action in this turn failed.");
  assert.ok(!ran.includes("type"), "nothing after the failure ran");
});

test("operate_computer: emergency stop in the corner", async () => {
  const client = {
    beta: { messages: { create: async () => ({ model: "m", usage: {}, stop_reason: "tool_use", content: [{ type: "tool_use", id: "a", name: "left_click", toolset_name: "computer", input: { coordinate: [5, 5] } }] }) } },
  } as unknown as Pick<Anthropic, "beta">;
  const executor: Executor = { geometry: async () => geometryFor(0, 0, 800, 600), run: async () => ({ failsafe: true, cursor: [] }) };
  assert.match(await operateComputer("anything", { client, executor }), /moved the mouse to the corner/);
});

test("voice activity detection finds an utterance", () => {
  const frame = (amp: number) => Float32Array.from({ length: 480 }, (_, i) => amp * Math.sin(i / 3));
  const vad = new Vad(30);
  const events: string[] = [];
  let audio: Float32Array | null = null;
  const feed = (amp: number, n: number) => {
    for (let i = 0; i < n; i++) {
      const e = vad.push(frame(amp));
      if (e) events.push(e.type);
      if (e?.type === "end") audio = e.audio;
    }
  };
  feed(0.001, 20); // quiet room
  feed(0.2, 30); // ~0.9 s of speech
  feed(0.001, 30); // silence ends it
  assert.deepEqual(events, ["start", "end"]);
  assert.ok(audio && (audio as Float32Array).length > 480 * 30, "includes the whole utterance plus pre-roll");
});

test("WAV encoding and resampling", () => {
  const wav = encodeWav(new Float32Array([0, 1, -1]), 16000);
  const v = new DataView(wav.buffer);
  assert.equal(String.fromCharCode(...wav.slice(0, 4)), "RIFF");
  assert.equal(v.getUint32(24, true), 16000);
  assert.equal(v.getInt16(46, true), 32767);
  assert.equal(v.getInt16(48, true), -32768);
  assert.equal(downsample(new Float32Array(48000), 48000).length, 16000);
});

test("Whisper output cleanup and Hindi wake words", () => {
  assert.equal(cleanTranscript("[BLANK_AUDIO]"), "");
  assert.equal(cleanTranscript(" Thank you.\n"), "");
  assert.equal(cleanTranscript("[00:00:00.000 --> 00:00:02.000]  Hey Ultron, what's the weather?"), "Hey Ultron, what's the weather?");
  assert.equal(detectWake("हे अल्ट्रॉन मौसम कैसा है"), "मौसम कैसा है");
  assert.equal(leadingWakeCommand("अल्ट्रॉन, लाइट बंद करो"), "लाइट बंद करो");
  assert.equal(leadingWakeCommand("hey ultron what's up"), "what's up");
});
