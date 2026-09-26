import "./tempHome";
import { beforeEach, test } from "node:test";
import { rmSync } from "node:fs";
import path from "node:path";
import { TEST_HOME } from "./tempHome";
import assert from "node:assert/strict";
import { checkProactive, inQuietHours, setProactive, type ProactiveSources } from "../lib/agent/proactive";
import { describeSignals, parseSignals } from "../lib/agent/signals";
import { isRepeatOf } from "../lib/voiceCommands";

// Each test starts from a fresh state file (first run, nothing announced).
beforeEach(() => rmSync(path.join(TEST_HOME, ".ultron", "proactive.json"), { force: true }));

const at = (h: number, m = 0, d = 10) => new Date(2030, 0, d, h, m);
const GB = 1024 ** 3;

function sources(over: Partial<ProactiveSources> = {}): ProactiveSources {
  return {
    upcomingEvents: async () => [],
    importantUnread: async () => [],
    disk: async () => ({ freeBytes: 200 * GB, totalBytes: 500 * GB }),
    rain: async () => null,
    ...over,
  };
}

test("meeting soon is announced once", async () => {
  const now = at(9, 50);
  const src = sources({ upcomingEvents: async () => [{ id: "e1", summary: "Standup", start: at(10, 0) }] });
  assert.deepEqual((await checkProactive(now, src)).map((n) => n.text), ["Sir, Standup starts in 10 minutes."]);
  assert.deepEqual(await checkProactive(at(9, 52), src), [], "not repeated");
});

test("email: existing backlog isn't announced, new mail is", async () => {
  let mail = [{ id: "old1", from: "Bank", subject: "Statement" }];
  const src = sources({ importantUnread: async () => mail });
  assert.deepEqual(await checkProactive(at(11, 0), src), [], "first run is the baseline");
  mail = [...mail, { id: "new1", from: "Priya", subject: "Flight details" }];
  assert.deepEqual((await checkProactive(at(11, 5), src)).map((n) => n.text), ["Sir, an important email from Priya: Flight details."]);
  mail = [...mail, { id: "n2", from: "A", subject: "x" }, { id: "n3", from: "B", subject: "y" }];
  assert.match((await checkProactive(at(11, 10), src))[0].text, /2 new important emails/);
});

test("low disk and rain are announced at most once a day", async () => {
  const src = sources({
    disk: async () => ({ freeBytes: 5 * GB, totalBytes: 500 * GB }),
    rain: async () => ({ at: at(17, 0), chance: 70 }),
  });
  const first = (await checkProactive(at(12, 0, 11), src)).map((n) => n.text).join(" | ");
  assert.match(first, /disk is nearly full — 5\.0 GB left/);
  assert.match(first, /rain is likely around 5:00 PM — 70% chance/);
  assert.deepEqual(await checkProactive(at(14, 0, 11), src), [], "same day: silent");
  assert.equal((await checkProactive(at(12, 0, 12), src)).length, 2, "next day: again");
});

test("quiet hours and switching off", async () => {
  assert.ok(inQuietHours(at(23, 30), "22:00", "07:00"));
  assert.ok(inQuietHours(at(6, 59), "22:00", "07:00"));
  assert.ok(!inQuietHours(at(7, 0), "22:00", "07:00"));
  const src = sources({ upcomingEvents: async () => [{ id: "late", summary: "Call", start: at(23, 40, 20) }] });
  assert.deepEqual(await checkProactive(at(23, 35, 20), src), [], "quiet at night");
  assert.match(await setProactive(false), /off/);
  const src2 = sources({ upcomingEvents: async () => [{ id: "e9", summary: "X", start: at(10, 5, 21) }] });
  assert.deepEqual(await checkProactive(at(10, 0, 21), src2), []);
  assert.match(await setProactive(true, "off"), /on \(no quiet hours\)/);
  await assert.rejects(setProactive(undefined, "late"), /22:00-07:00/);
});

test("speaking signals", () => {
  assert.equal(describeSignals(parseSignals({ wordsPerSecond: 2.4 })), "");
  assert.match(describeSignals(parseSignals({ wordsPerSecond: 4.2, interruptedLastReply: true })), /speaking fast \(4\.2.*cut off your previous reply/);
  assert.match(describeSignals(parseSignals({ repeatedRequest: true })), /misunderstood/);
  assert.deepEqual(parseSignals({ wordsPerSecond: 99, repeatedRequest: "yes" }), {}, "junk ignored");
  assert.ok(isRepeatOf("set a timer for ten minutes", "set a timer for 10 minutes please"));
  assert.ok(!isRepeatOf("what's the weather", "set a timer for ten minutes"));
  assert.ok(!isRepeatOf("set a timer for the pasta", "what's on my calendar for the day"));
});
