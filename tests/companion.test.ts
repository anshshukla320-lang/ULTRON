import "./tempHome";
import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { lineFor, logNotices, noticesAfter } from "../lib/agent/noticeLog";
import { healthSummary, healthForBriefing, saveHealth } from "../lib/agent/health";
import { addJournalEntry, eveningRecapDue, parseDay, readJournal, resolveDay, searchJournal, writeRecap } from "../lib/agent/journal";
import { addMeetingChunk, activeMeeting, renderNotes, startMeeting, stopMeeting } from "../lib/agent/meetings";
import { profileKey } from "../lib/agent/voiceId";
import { runAgent, type AgentEvent } from "../lib/agent/runAgent";
import { backgroundTick, type BackgroundDeps } from "../lib/agent/background";
import { fakeClient } from "./fakeClient";

test("notice log: numbered, fetched after a cursor, same words as spoken", async () => {
  assert.equal(lineFor({ kind: "timer", text: "pasta" }), "Sir, your pasta timer is done.");
  assert.equal(lineFor({ kind: "briefing", text: "morning briefing" }), "Your morning briefing is ready, sir.");
  const before = (await noticesAfter(0)).latest;
  await logNotices([{ kind: "reminder", text: "Sir, a reminder: call Mum." }, { kind: "notice", text: "Sir, rain soon." }]);
  const { items, latest } = await noticesAfter(before);
  assert.deepEqual(items.map((i) => [i.seq - before, i.title, i.text]), [[1, "Reminder", "Sir, a reminder: call Mum."], [2, "ULTRON", "Sir, rain soon."]]);
  assert.equal(latest, before + 2);
  assert.deepEqual((await noticesAfter(latest)).items, []);
});

test("background delivery is logged for the phone", async () => {
  const logged: string[] = [];
  const deps: BackgroundDeps = {
    pageIsOpen: async () => false,
    takeDue: async () => [{ id: "1", kind: "timer", text: "tea" }],
    checkProactive: async () => [],
    notify: async () => {},
    speak: async () => {},
    phone: async () => {},
    briefing: async () => "",
    settings: async () => ({ backgroundSpeech: false, backgroundNotifications: false }),
    log: async (items) => void logged.push(...items.map((i) => i.text)),
  };
  await backgroundTick(deps);
  assert.deepEqual(logged, ["Sir, your tea timer is done."]);
});

test("health from the phone: validated, merged, summarised", async () => {
  assert.equal(await saveHealth([{ date: "2026-09-25", steps: 8123, sleepMinutes: 412 }, { date: "bad", steps: 5 }, { date: "2026-09-26", steps: -4, restingHeartRate: 61 }]), 2);
  await saveHealth([{ date: "2026-09-26", steps: 10500 }]);
  const s = await healthSummary(7);
  assert.match(s, /2026-09-25: slept 6 h 52 min, 8,123 steps/);
  assert.match(s, /2026-09-26: 10,500 steps, resting heart rate 61/, "newer upload merged, bad values dropped");
  assert.match(s, /Averages: 9,312 steps, 6 h 52 min sleep/);
  assert.match(await healthForBriefing(new Date(2026, 8, 26, 8)), /2026-09-25[\s\S]*2026-09-26/);
});

test("journal: notes, days by name, search, and the evening recap", async () => {
  const now = new Date(2026, 8, 26, 20, 15); // Saturday
  assert.equal(resolveDay("yesterday", now).getDate(), 25);
  assert.equal(resolveDay("last tuesday", now).getDate(), 22);
  assert.equal(resolveDay("saturday", now).getDate(), 19, "the same weekday means last week's");
  assert.equal(resolveDay("2026-09-01", now).getDate(), 1);
  assert.equal(resolveDay("22 sept", now).getDate(), 22);
  assert.equal(resolveDay("December 3rd", now).getFullYear(), 2025, "a future date means last year's");
  assert.throws(() => resolveDay("the day after never", now), /Couldn't tell/);

  await addJournalEntry("Went to the gym with Rahul", now);
  await addJournalEntry("Finished the tax form", new Date(2026, 8, 26, 21, 0));
  const text = await readJournal("today", now);
  assert.match(text, /# Saturday, 26 September 2026/);
  assert.deepEqual(parseDay(text).notes.map((n) => n.replace(/^.* — /, "")), ["Went to the gym with Rahul", "Finished the tax form"]);
  assert.match(await searchJournal("gym rahul"), /2026-09-26: .*gym with Rahul/);
  assert.match(await searchJournal("skydiving"), /Nothing in the journal/);

  let material = "";
  const recap = await writeRecap("today", now, async (m) => {
    material = m;
    return "You went to the gym and finished your tax form.";
  });
  assert.equal(recap, "You went to the gym and finished your tax form.");
  assert.match(material, /journal notes:[\s\S]*gym with Rahul/);
  const after = parseDay(await readJournal("today", now));
  assert.equal(after.recap, recap);
  assert.equal(after.notes.length, 2, "notes kept when the recap is written");

  assert.equal(await eveningRecapDue("21:30", new Date(2026, 8, 27, 21, 0)), false, "not yet");
  assert.equal(await eveningRecapDue("21:30", new Date(2026, 8, 27, 21, 40)), true);
  assert.equal(await eveningRecapDue("21:30", new Date(2026, 8, 27, 21, 50)), false, "once a day");
  assert.equal(await eveningRecapDue("21:30", new Date(2026, 8, 26, 22, 0)), false, "already written that day");
});

test("meetings: chunks transcribed in order, notes written and saved", async () => {
  await fs.rm(path.join(os.homedir(), ".ultron", "meetings"), { recursive: true, force: true });
  const m = await startMeeting("Budget review");
  assert.equal((await startMeeting("another")).id, m.id, "starting again keeps the running one");
  const wav = Buffer.from("RIFF....WAVEfmt ");
  const words = ["We agreed to cut the travel budget by ten percent this quarter and hire one designer.", "Priya will send the revised numbers by Friday and Arjun checks the vendor contracts."];
  let i = 0;
  await addMeetingChunk(m.id, wav, async () => words[i++]);
  await addMeetingChunk(m.id, wav, async () => words[i++], true);
  await assert.rejects(addMeetingChunk("nope", wav, async () => "x"), /isn't being recorded/);
  assert.equal((await activeMeeting())?.title, "Budget review");

  let seen = "";
  const { spoken, file } = await stopMeeting({
    addTasks: false,
    writer: async (_t, transcript) => {
      seen = transcript;
      return {
        summary: "Travel budget cut by 10%; one designer to hire.",
        decisions: ["Cut travel by 10%"],
        action_items: [{ task: "Send revised numbers", owner: "Priya", due: "2026-10-02" }],
        spoken: "Budget review done: travel cut ten percent, one action for Priya.",
      };
    },
  });
  assert.equal(seen, words.join("\n"));
  assert.match(spoken, /one action for Priya/);
  const md = await fs.readFile(file, "utf-8");
  assert.match(md, /^# Budget review/);
  assert.match(md, /- \[ \] Send revised numbers — Priya \(due 2026-10-02\)/);
  assert.match(md, /## Transcript\nWe agreed/);
  assert.equal(await activeMeeting(), null);
  await assert.rejects(stopMeeting(), /No meeting/);
  assert.match(renderNotes("X", new Date(), { summary: "s", decisions: [], action_items: [], spoken: "" }, "t"), /## Decisions\n- None recorded/);
});

test("family mode: owner-only tools are refused for someone else", async () => {
  assert.equal(profileKey("Priya Sharma"), "priya-sharma");
  assert.equal(profileKey("  अनु "), "अनु");
  assert.throws(() => profileKey("!!"), /name/);

  const { client } = fakeClient([{ tools: [["send_email", { to: "boss@x.com", subject: "hi", body: "x" }], ["get_weather", {}]] }, { text: "Sorry Priya." }]);
  const ran: string[] = [];
  const events: AgentEvent[] = [];
  for await (const e of runAgent(
    { messages: [{ role: "user", content: "email my boss" }] },
    { client, system: [], advisor: false, guest: "Priya", execute: async (n) => (ran.push(n), "ok") },
  )) {
    events.push(e);
  }
  assert.deepEqual(ran, ["get_weather"], "the email was never even offered for confirmation");
  assert.ok(events.some((e) => e.type === "action" && /Priya isn't the owner/.test(String(e.action.output))));
  assert.equal((events.at(-1) as Extract<AgentEvent, { type: "done" }>).pending, null);
});
