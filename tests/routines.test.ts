import "./tempHome";
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  describeSchedule,
  parseSchedule,
  runRoutine,
  saveRoutine,
  scheduledTime,
  takeDueRoutines,
  listRoutinesRaw,
} from "../lib/agent/routines";
import { TOOL_POLICY, confirmationInput, executeTool, needsConfirmation } from "../lib/agent/tools";
import { runAgent, type AgentEvent } from "../lib/agent/runAgent";
import { sunTimes } from "../lib/agent/sun";
import { runScheduledRoutines } from "../lib/agent/background";
import { fakeClient } from "./fakeClient";

beforeEach(async () => {
  await fs.rm(path.join(os.homedir(), ".ultron", "routines.json"), { force: true });
});

test("sunrise/sunset match published times", () => {
  // Pune, 26 Sep 2026: sunrise 06:22, sunset 18:28 IST (UTC+5:30).
  const t = sunTimes(new Date(2026, 8, 26, 12), 18.52, 73.86)!;
  const ist = (d: Date) => (d.getUTCHours() * 60 + d.getUTCMinutes() + 330) % 1440;
  assert.ok(Math.abs(ist(t.sunrise) - (6 * 60 + 22)) <= 4, `sunrise ${ist(t.sunrise)}`);
  assert.ok(Math.abs(ist(t.sunset) - (18 * 60 + 28)) <= 4, `sunset ${ist(t.sunset)}`);
  assert.equal(sunTimes(new Date(2026, 5, 21), 78.2, 15.6), null, "midnight sun in Svalbard");
});

test("schedules: parsing and describing", () => {
  assert.deepEqual(parseSchedule({ at: "11:30 pm" }), { at: "23:30" });
  assert.deepEqual(parseSchedule({ at: "7" , days: ["weekdays"] }), { at: "07:00", days: [1, 2, 3, 4, 5] });
  assert.deepEqual(parseSchedule({ at: "sunset-30" }), { at: "sunset", offsetMinutes: -30 });
  assert.deepEqual(parseSchedule({ at: "12 am" }), { at: "00:00" });
  assert.deepEqual(parseSchedule({ at: "08:00", days: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] }), { at: "08:00" }, "all 7 days = every day");
  assert.throws(() => parseSchedule({ at: "tea time" }), /should look like/);
  assert.throws(() => parseSchedule({ at: "25:00" }), /isn't a valid time/);
  assert.throws(() => parseSchedule({ at: "08:00", days: ["funday"] }), /Unknown day/);
  assert.equal(describeSchedule({ at: "sunset", offsetMinutes: -30, days: [0, 6] }), "30 min before sunset, weekends");
});

test("routines: validation", async () => {
  await assert.rejects(saveRoutine({ name: "x", steps: [{ tool: "make_coffee", input: {} }] }, TOOL_POLICY), /no tool called "make_coffee"/);
  await assert.rejects(saveRoutine({ name: "x", steps: [{ tool: "run_routine", input: { name: "x" } }] }, TOOL_POLICY), /can't be part of a routine/);
  await assert.rejects(saveRoutine({ name: "x", steps: [] }, TOOL_POLICY), /at least one step/);
  await assert.rejects(
    saveRoutine({ name: "x", steps: [{ tool: "power_action", input: { action: "sleep" } }], schedule: { at: "23:00" } }, TOOL_POLICY),
    /nobody there to confirm, so it can't include power_action/,
  );
  assert.equal(listRoutinesRaw().length, 0);
});

test("routines: run, confirmation only when a step needs it, snapshot can't be swapped", async () => {
  assert.match(
    await saveRoutine({ name: "Movie mode", steps: [{ tool: "set_volume", input: { action: "set", amount: 30 } }, { tool: "tv_control", input: { action: "open_app", app: "Netflix" } }] }, TOOL_POLICY),
    /Saved "Movie mode" — 2 steps\./,
  );
  assert.match(
    await saveRoutine({ name: "Good night", steps: [{ tool: "smart_home_control", input: { entity_id: "bedroom light", action: "off" } }, { tool: "power_action", input: { action: "sleep" } }] }, TOOL_POLICY),
    /ask before running/,
  );
  assert.equal(needsConfirmation("run_routine", { name: "movie mode" }), false);
  assert.equal(needsConfirmation("run_routine", { name: "good night routine" }), true);
  assert.equal(needsConfirmation("run_routine", { name: "nonexistent" }), false, "unknown routine fails fast instead of asking");

  // Steps run in order; a failing one doesn't stop the rest.
  const ran: string[] = [];
  const out = await runRoutine("movie", async (tool) => {
    ran.push(tool);
    if (tool === "set_volume") throw new Error("no audio device");
    return "ok";
  });
  assert.deepEqual(ran, ["set_volume", "tv_control"]);
  assert.match(out, /1 of 2 steps failed[\s\S]*✗ set_volume: no audio device[\s\S]*✓ tv_control: ok/);

  // Calling it directly without the confirm box is refused.
  await assert.rejects(executeTool("run_routine", { name: "good night" }), /needs the user's confirmation/);
  // A model can't smuggle its own steps in either.
  await assert.rejects(executeTool("run_routine", { name: "good night", confirmed_steps: [{ tool: "focus_status", input: {} }] }), /needs the user's confirmation/);

  // What the confirm box shows is what runs — even if the routine is edited in between.
  const shown = confirmationInput("run_routine", { name: "good night" });
  assert.deepEqual((shown.confirmed_steps as { tool: string }[]).map((s) => s.tool), ["smart_home_control", "power_action"]);
  await saveRoutine({ name: "Good night", steps: [{ tool: "focus_status", input: {} }, { tool: "write_file", input: { path: "x", content: "y" } }] }, TOOL_POLICY);
  const snapshot = { name: "Good night", confirmed_steps: [{ tool: "focus_status", input: {} }] };
  assert.match(String(await executeTool("run_routine", snapshot, { confirmed: true })), /✓ focus_status: Focus mode is off/);
});

test("routines through the agent loop: confirm box lists the steps, approval runs them", async () => {
  await saveRoutine({ name: "Good night", steps: [{ tool: "focus_status", input: {} }, { tool: "power_action", input: { action: "sleep" } }] }, TOOL_POLICY);
  const { client } = fakeClient([{ tools: [["run_routine", { name: "good night" }]] }, { text: "Done, sir." }]);
  const calls: { name: string; input: Record<string, unknown>; confirmed?: boolean }[] = [];
  const execute = async (name: string, input: Record<string, unknown>, ctx?: { confirmed?: boolean }) => {
    calls.push({ name, input, confirmed: ctx?.confirmed });
    return "ran";
  };
  const events: AgentEvent[] = [];
  for await (const e of runAgent({ messages: [{ role: "user", content: "good night" }] }, { client, system: [], execute, advisor: false })) events.push(e);
  const done = events.find((e) => e.type === "done") as Extract<AgentEvent, { type: "done" }>;
  assert.equal(calls.length, 0, "nothing ran before approval");
  assert.equal(done.pending?.toolUse[0].name, "run_routine");
  assert.deepEqual((done.pending!.toolUse[0].input.confirmed_steps as { tool: string }[]).map((s) => s.tool), ["focus_status", "power_action"]);

  for await (const e of runAgent({ resolution: { token: done.pending!.token, approved: true } }, { client, system: [], execute, advisor: false })) events.push(e);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].confirmed, true);
  assert.equal((calls[0].input.confirmed_steps as unknown[]).length, 2);
});

test("scheduled routines: once a day, within the grace window, on the right days", async () => {
  await saveRoutine({ name: "Fan off", steps: [{ tool: "focus_status", input: {} }], schedule: { at: "02:00" } }, TOOL_POLICY);
  await saveRoutine({ name: "Porch light", steps: [{ tool: "focus_status", input: {} }], schedule: { at: "sunset" }, announce: true }, TOOL_POLICY);
  await saveRoutine({ name: "Weekday alarm", steps: [{ tool: "focus_status", input: {} }], schedule: { at: "07:00", days: ["weekdays"] } }, TOOL_POLICY);
  const pune = { latitude: 18.52, longitude: 73.86 };

  const at = (h: number, m: number, day = 26) => new Date(2026, 8, day, h, m); // 26 Sep 2026 is a Saturday
  assert.deepEqual(await takeDueRoutines(at(1, 59), pune), []);
  assert.deepEqual((await takeDueRoutines(at(2, 5), pune)).map((r) => r.name), ["Fan off"]);
  assert.deepEqual(await takeDueRoutines(at(2, 6), pune), [], "only once a day");
  assert.deepEqual(await takeDueRoutines(at(7, 1), pune), [], "weekday routine skipped on Saturday");
  assert.deepEqual(await takeDueRoutines(at(9, 0, 27), pune), [], "missed by hours (PC was off) — not run late");
  assert.deepEqual((await takeDueRoutines(at(7, 2, 28), pune)).map((r) => r.name), ["Weekday alarm"], "Monday");

  const sunset = scheduledTime({ at: "sunset" }, at(12, 0), pune)!;
  assert.deepEqual(await takeDueRoutines(new Date(sunset.getTime() - 60_000), null), [], "no location → sunset routines wait");
  assert.deepEqual((await takeDueRoutines(new Date(sunset.getTime() + 60_000), pune)).map((r) => r.name), ["Porch light"]);
});

test("background: scheduled routine runs with nobody there and says so if asked to", async () => {
  await saveRoutine({ name: "Check", steps: [{ tool: "focus_status", input: {} }], schedule: { at: "10:00" }, announce: true }, TOOL_POLICY);
  const ran = await runScheduledRoutines(new Date(2026, 8, 26, 10, 3));
  assert.deepEqual(ran, ["Check"]);
  const { takeDue } = await import("../lib/agent/reminders");
  const due = await takeDue(new Date(Date.now() + 1000));
  assert.ok(due.some((d) => d.kind === "notice" && /run your Check routine/.test(d.text)));
});
