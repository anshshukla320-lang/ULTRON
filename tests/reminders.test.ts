import "./tempHome";
import { test } from "node:test";
import assert from "node:assert/strict";
import { setTimer, setReminder, listReminders, cancelReminder, setDailyBriefing, takeDue } from "../lib/agent/reminders";

const MIN = 60_000;

test("timers and reminders come due once, in order", async () => {
  await cancelReminder("all");
  assert.match(await setTimer(300), /5 minutes/);
  assert.match(await setTimer(90, "pasta"), /pasta/);
  assert.match(await setReminder("call mum", undefined, 30), /call mum/);
  assert.match(await listReminders(), /timer: pasta/);

  assert.deepEqual(await takeDue(new Date(Date.now() + 10_000)), []);
  const at2 = await takeDue(new Date(Date.now() + 2 * MIN));
  assert.deepEqual(at2.map((d) => d.text), ["pasta"]);
  const at6 = await takeDue(new Date(Date.now() + 6 * MIN));
  assert.deepEqual(at6.map((d) => [d.kind, d.text]), [["timer", "5 minute"]]);
  // Picked up long after it was due (app closed): says when it was for.
  const late = await takeDue(new Date(Date.now() + 90 * MIN));
  assert.equal(late.length, 1);
  assert.match(late[0].text, /^call mum \(this was due/);
  assert.deepEqual(await takeDue(new Date(Date.now() + 200 * MIN)), [], "each item fires only once");
});

test("reminder validation", async () => {
  await assert.rejects(setReminder("", undefined, 5), /What should I remind/);
  await assert.rejects(setReminder("x", "not a date"), /Couldn't understand/);
  await assert.rejects(setReminder("x", "2001-01-01T10:00"), /in the past/);
  await assert.rejects(setReminder("x"), /Give either/);
  await assert.rejects(setTimer(-5), /positive/);
});

test("cancel by text, kind, or all", async () => {
  await cancelReminder("all");
  await setTimer(60, "tea");
  await setReminder("stretch", undefined, 10);
  assert.match(await cancelReminder("tea"), /Cancelled 1 item/);
  assert.match(await cancelReminder("nothing-matches"), /Nothing matching/);
  assert.match(await cancelReminder("all"), /Cancelled 1 item/);
});

test("daily briefing fires once a day, within the grace window", async () => {
  await cancelReminder("all");
  assert.match(await setDailyBriefing("7:30"), /07:30/);
  const day = (h: number, m: number, d = 10) => new Date(2030, 0, d, h, m);
  assert.deepEqual(await takeDue(day(7, 0)), [], "not before the time");
  assert.deepEqual((await takeDue(day(7, 31))).map((x) => x.kind), ["briefing"]);
  assert.deepEqual(await takeDue(day(8, 0)), [], "only once per day");
  assert.deepEqual(await takeDue(day(13, 0, 11)), [], "too late next day — skipped");
  assert.deepEqual((await takeDue(day(9, 0, 12))).map((x) => x.kind), ["briefing"], "late but within 4h");
  await assert.rejects(setDailyBriefing("25:00"), /24-hour/);
  assert.match(await setDailyBriefing("off"), /off/);
  assert.deepEqual(await takeDue(day(7, 31, 13)), []);
});

test("concurrent writes don't lose items", async () => {
  await cancelReminder("all");
  await Promise.all(Array.from({ length: 10 }, (_, i) => setTimer(600 + i, `t${i}`)));
  assert.equal((await listReminders()).split("\n").length, 10);
  await cancelReminder("all");
});
