import "./tempHome";
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildReply, type FullEmail } from "../lib/agent/gmailClient";
import { inboxDigest, sendInboxReply, morningInbox, type InboxDeps } from "../lib/agent/inbox";
import { scanExpenseEmails, type ExpenseScanDeps } from "../lib/agent/expenseEmails";
import { expenseSummary, logExpense } from "../lib/agent/financeTools";
import { scanPackages, packageTick, trackPackages, type PackageDeps, type FoundUpdate } from "../lib/agent/packages";
import { isPhysicalPlace, leaveNowCheck, savePhoneLocation, type LeaveDeps } from "../lib/agent/travel";
import { extractFromHtml, watchPrice, checkPrices, listPriceWatches, type PriceDeps } from "../lib/agent/priceWatch";
import { addHabit, markHabitDone, habitStatus, habitCheckin, streak } from "../lib/agent/habits";
import { parseBirthday, daysUntil, addBirthday, birthdayMorning, upcomingBirthdays } from "../lib/agent/birthdays";
import { setSecurityMode, recordIntruder, readSecurityPhoto, phoneAway, securityState } from "../lib/agent/security";
import { sampleEnergy, electricityUsage, type Reading } from "../lib/agent/energy";
import { IntruderTrigger } from "../lib/intruderTrigger";
import { needsConfirmation, OWNER_ONLY, TOOLS } from "../lib/agent/tools";
import { noticesAfter } from "../lib/agent/noticeLog";

const email = (id: string, fromName: string, subject: string): FullEmail => ({
  id,
  threadId: `t-${id}`,
  from: `${fromName} <${fromName.toLowerCase()}@x.com>`,
  fromName,
  replyTo: `${fromName.toLowerCase()}@x.com`,
  subject,
  date: "today",
  messageIdHeader: `<${id}@mail>`,
  body: "…",
});

test("inbox: triaged once, numbered by importance, reply sent in the thread", async () => {
  const sent: { to: string; body: string; thread: string }[] = [];
  let classifyCalls = 0;
  const deps: InboxDeps = {
    search: async () => ["m1", "m2", "m3"],
    get: async (id) => ({ m1: email("m1", "Newsletter", "Weekly digest"), m2: email("m2", "Rahul", "Dinner Friday?"), m3: email("m3", "Boss", "Report due") })[id]!,
    classify: async (emails) => {
      classifyCalls++;
      return emails.map((e) => ({
        message_id: e.id,
        summary: `about ${e.subject}`,
        importance: e.id === "m3" ? ("high" as const) : e.id === "m1" ? ("low" as const) : ("normal" as const),
        needs_reply: e.id !== "m1",
        draft_reply: e.id === "m1" ? "" : `Reply to ${e.fromName}`,
      }));
    },
    send: async (e, body) => void sent.push({ to: e.replyTo, body, thread: e.threadId }),
  };
  const out = await inboxDigest(new Date(), deps);
  assert.match(out, /^1\. Boss — "Report due"[\s\S]*Draft reply: Reply to Boss\n2\. Rahul/);
  assert.doesNotMatch(out, /Newsletter/, "low-importance mail isn't read out");
  await inboxDigest(new Date(), deps);
  assert.equal(classifyCalls, 1, "each email is triaged once");

  assert.match(await sendInboxReply("2", "Friday works!", deps), /Replied to Rahul/);
  assert.deepEqual(sent, [{ to: "rahul@x.com", body: "Friday works!", thread: "t-m2" }]);
  await assert.rejects(sendInboxReply("rahul", "again", deps), /No drafted reply/, "can't send twice");
  assert.match(await sendInboxReply("boss", "On it.", deps), /Replied to Boss/);

  const raw = buildReply({ replyTo: "a@b.com\r\nBcc: evil@x.com", subject: "Hi", messageIdHeader: "<1@m>" }, "Body");
  assert.match(raw, /^To: a@b\.com Bcc: evil@x\.com\r\nSubject: Re: Hi\r\nIn-Reply-To: <1@m>\r\nReferences: <1@m>\r\n/, "no header injection");
  assert.match(buildReply({ replyTo: "a@b.com", subject: "Re: Hi", messageIdHeader: "" }, "x"), /Subject: Re: Hi\r\nContent-Type/);

  assert.equal(needsConfirmation("send_email_reply", {}), true);
  assert.ok(OWNER_ONLY.has("send_email_reply") && OWNER_ONLY.has("inbox_digest"));
  const before = await morningInbox(new Date(2026, 8, 27, 7, 0), deps);
  assert.deepEqual(before, [], "not before 8");
});

test("expenses: bank emails logged once in ₹, summaries by month and category", async () => {
  process.env.ULTRON_CURRENCY = "₹";
  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  const deps: ExpenseScanDeps = {
    search: async () => ["e1", "e2", "e3"],
    read: async (id) => `email ${id}`,
    extract: async () => [
      { message_id: "e1", is_spend: true, amount: 450, merchant: "Swiggy", category: "food", date: today },
      { message_id: "e2", is_spend: false, amount: 2000, merchant: "Salary", category: "other", date: today },
      { message_id: "e3", is_spend: true, amount: 1299.5, merchant: "Amazon", category: "shopping", date: today },
      { message_id: "zzz", is_spend: true, amount: 5, merchant: "made up", category: "other", date: today },
    ],
  };
  const added = await scanExpenseEmails(deps);
  assert.deepEqual(added.map((e) => [e.amount, e.note, e.source]), [[450, "Swiggy", "email"], [1299.5, "Amazon", "email"]]);
  assert.deepEqual(await scanExpenseEmails(deps), [], "same emails aren't logged again");
  assert.match(await logExpense(200, "Food", "chai"), /Logged ₹200 under "food"/);
  const month = await expenseSummary("this_month");
  assert.match(month, /This month — total ₹1,949\.50 across 3 entries/);
  assert.match(month, /shopping: ₹1,299\.50\nfood: ₹650\nBiggest: ₹1,299\.50 Amazon; ₹450 Swiggy; ₹200 chai/);
  assert.match(await expenseSummary("this_month", "food"), /This month \(food\) — total ₹650 across 2/);
  assert.match(await expenseSummary("last_month", "food"), /Last month: no expenses for "food"/);
});

test("packages: status only moves forward; out for delivery and 'arriving today' are announced", async () => {
  const now = new Date(2026, 8, 27, 10, 0);
  const u = (id: string, status: FoundUpdate["status"], expected = ""): FoundUpdate => ({
    message_id: id,
    is_order_update: true,
    store: "Amazon",
    item: "boAt earbuds",
    order_ref: "402-1",
    status,
    expected_date: expected,
  });
  let batch: FoundUpdate[] = [];
  let ids: string[] = [];
  const deps: PackageDeps = { search: async () => ids, read: async (id) => id, extract: async () => batch };
  ids = ["p1"];
  batch = [u("p1", "shipped", "2026-09-27"), { ...u("p1", "ordered"), item: "Buy now!", is_order_update: false }];
  assert.deepEqual(await scanPackages(now, deps), []);
  ids = ["p2", "p3"];
  batch = [u("p2", "out_for_delivery"), u("p3", "ordered")];
  const changed = await scanPackages(now, deps);
  assert.deepEqual(changed.map((p) => p.status), ["out_for_delivery"], "the older 'ordered' email read late changes nothing");
  assert.match(await trackPackages(now, { ...deps, search: async () => [] }), /Amazon: boAt earbuds — out for delivery, expected today/);

  ids = ["p4"];
  batch = [{ ...u("p4", "shipped", "2026-09-27"), order_ref: "999", item: "Kindle" }];
  const lines = await packageTick(new Date(2026, 8, 27, 12, 30), deps);
  assert.ok(lines.some((l) => /arriving today: Kindle from Amazon/.test(l)), lines.join("|"));
  assert.deepEqual(await packageTick(new Date(2026, 8, 27, 13, 0), deps), [], "once a day, and scans at most every 2 h");
});

test("leave now: travel time from the phone's location, said once at the right moment", async () => {
  assert.equal(isPhysicalPlace("https://meet.google.com/abc"), false);
  assert.equal(isPhysicalPlace("Zoom call"), false);
  assert.equal(isPhysicalPlace("Phoenix Mall, Pune"), true);
  delete process.env.GOOGLE_MAPS_API_KEY;
  let now = new Date(2026, 8, 27, 16, 0).getTime();
  await savePhoneLocation(18.52, 73.85, 20, now);
  const start = new Date(2026, 8, 27, 17, 0);
  const urls: string[] = [];
  const deps: LeaveDeps = {
    now: () => now,
    events: async () => [
      { id: "e1", summary: "Dinner with Priya", start, location: "Phoenix Mall, Pune" },
      { id: "e2", summary: "Standup", start, location: "https://zoom.us/j/1" },
    ],
    fetchJson: async (url) => {
      urls.push(url);
      if (url.includes("nominatim")) return [{ lat: "18.56", lon: "73.91" }];
      return { code: "Ok", routes: [{ duration: 30 * 60 }] }; // 30 min → 39 with the traffic allowance
    },
  };
  assert.deepEqual(await leaveNowCheck(deps), [], "16:00 is too early (leave at ~16:11)");
  assert.ok(urls.some((u) => u.includes("route/v1/driving/73.85,18.52;73.91,18.56")), "routes from the phone's spot");
  now = new Date(2026, 8, 27, 16, 8).getTime();
  const lines = await leaveNowCheck(deps);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /time to leave for Dinner with Priya at 5:00 pm: it's about 39 minutes from where your phone is/i);
  now = new Date(2026, 8, 27, 16, 12).getTime();
  assert.deepEqual(await leaveNowCheck(deps), [], "only once");
});

test("price watch: prices read from shop pages; told once at the target, again only on a further drop", async () => {
  const jsonLd = `<html><head><meta property="og:title" content="Pixel 10 &amp; case"><script type="application/ld+json">{"@type":"Product","offers":{"@type":"Offer","price":"21999.00","priceCurrency":"INR"}}</script></head></html>`;
  assert.deepEqual(extractFromHtml(jsonLd), { title: "Pixel 10 & case", price: 21999 });
  assert.equal(extractFromHtml(`<title>X</title><meta itemprop="price" content="1,499">`).price, 1499);
  assert.equal(extractFromHtml(`<title>Y</title><span class="a-price-whole">18,490</span>`).price, 18490);
  assert.equal(extractFromHtml(`<title>Z</title>`).price, undefined);

  let price = 21999;
  let now = Date.now();
  const deps: PriceDeps = {
    fetchHtml: async () => `<title>Pixel 10</title><meta itemprop="price" content="${price}">`,
    readPrice: async () => undefined,
    now: () => now,
  };
  await assert.rejects(watchPrice("http://192.168.1.5/admin", 100, deps), /isn't a shop's page/);
  await assert.rejects(watchPrice("not a link", 100, deps), /product's link/);
  assert.match(await watchPrice("https://shop.example/pixel", 20000, deps), /Watching Pixel 10: now ₹21,999/);
  const hour = 3_600_000;
  price = 19999;
  now += hour;
  assert.deepEqual(await checkPrices(deps), [], "not due yet");
  now += 6 * hour;
  assert.match((await checkPrices(deps))[0], /Pixel 10 is down to ₹19,999 — at or below your ₹20,000/);
  price = 19500;
  now += 6 * hour;
  assert.deepEqual(await checkPrices(deps), [], "a small further drop isn't worth another message");
  price = 18000;
  now += 6 * hour;
  assert.match((await checkPrices(deps))[0], /even lower/);
  assert.match(await listPriceWatches(), /Pixel 10: ₹18,000 \(target ₹20,000, lowest seen ₹18,000\)/);
});

test("habits: streaks, the evening check-in and Sunday's review", async () => {
  const sat = new Date(2026, 8, 26, 21, 0);
  assert.match(await addHabit("reading", "read for 20 minutes", sat), /Tracking "reading"/);
  await addHabit("walk", "walk 5,000 steps", sat);
  for (const d of ["2026-09-21", "2026-09-22", "2026-09-23", "2026-09-25"]) await markHabitDone("reading", d, sat);
  assert.match(await markHabitDone("read", "today", sat), /Streak: 2 days/);
  assert.match(await habitStatus(sat), /reading \(read for 20 minutes\): done today, streak 2, 5 days this week, best streak 3/);
  assert.match(await habitStatus(sat), /walk \(walk 5,000 steps\): not yet today, streak 0/);
  await assert.rejects(markHabitDone("yoga", "today", sat), /No habit called "yoga"/);

  const lines = await habitCheckin("20:30", sat);
  assert.deepEqual(lines, ["Sir, a quick check-in: did you walk 5,000 steps today? Tell me and I'll tick it off."]);
  assert.deepEqual(await habitCheckin("20:30", new Date(2026, 8, 26, 22, 0)), [], "once a day");
  const sun = new Date(2026, 8, 27, 20, 45);
  await markHabitDone("reading", "today", sun);
  const sunday = await habitCheckin("20:30", sun);
  assert.match(sunday.at(-1)!, /Your week, sir: reading 6 of 7, walk 0 of 7\./);
  assert.equal(streak({ name: "x", goal: "x", createdAt: "", done: ["2026-09-26"] }, sun), 1, "today not done yet still counts yesterday's streak");
});

test("birthdays: dates parsed, contacts merged, morning notices with age", async () => {
  assert.deepEqual(parseBirthday("12 March"), { day: "03-12" });
  assert.deepEqual(parseBirthday("March 3rd 1995"), { day: "03-03", year: 1995 });
  assert.deepEqual(parseBirthday("05/11"), { day: "11-05" }, "day first");
  assert.deepEqual(parseBirthday("1990-02-29"), { day: "02-29", year: 1990 });
  assert.throws(() => parseBirthday("someday"), /Couldn't read/);
  const now = new Date(2026, 8, 27, 9, 30);
  assert.equal(daysUntil("09-27", now), 0);
  assert.equal(daysUntil("09-26", now), 364);
  assert.equal(daysUntil("02-29", new Date(2027, 1, 20)), 8, "29 Feb falls on the 28th in a normal year");

  await addBirthday("Priya", "27 September 1996");
  const deps = { contacts: async () => [{ name: "Rahul", day: "09-28", source: "contacts" as const }, { name: "Priya", day: "01-01", source: "contacts" as const }] };
  const lines = await birthdayMorning(now, deps);
  assert.deepEqual(lines, ["Sir, it's Priya's birthday today (turning 30). Shall I send a WhatsApp wish?", "Sir, tomorrow is Rahul's birthday."]);
  assert.deepEqual(await birthdayMorning(new Date(2026, 8, 27, 12), deps), [], "once a day");
  assert.match(await upcomingBirthdays(3, now, deps), /^Priya: today \(turning 30\)\nRahul: tomorrow$/);
});

test("security mode: photo to the phone only while on, rate-limited; the phone's away switch", async () => {
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(200, 1)]);
  const sent: { text: string; image: string }[] = [];
  const deps = { phoneNotice: async (text: string, image: string) => void sent.push({ text, image }), telegram: async () => {} };
  await setSecurityMode(false);
  assert.equal(await recordIntruder(jpeg, Date.now(), deps), false, "off: ignored");
  assert.match(await setSecurityMode(true), /no ULTRON page is open/);
  const t = Date.now();
  assert.equal(await recordIntruder(jpeg, t, deps), true);
  assert.equal(await recordIntruder(jpeg, t + 30_000, deps), false, "not again within 2 minutes");
  assert.match(sent[0].text, /Someone is at your PC/);
  assert.deepEqual(await readSecurityPhoto(sent[0].image), jpeg);
  assert.equal(await readSecurityPhoto("../../etc/passwd"), null);
  await assert.rejects(recordIntruder(Buffer.from("not a jpeg at all, just some text padding it out to a hundred bytes or so........................"), t + 999_999, deps), /JPEG/);

  // The real notice log carries the photo id for the phone app.
  const before = (await noticesAfter(0)).latest;
  await setSecurityMode(false);
  await setSecurityMode(true);
  await recordIntruder(jpeg, t + 10 * 60_000);
  const logged = (await noticesAfter(before)).items.at(-1)!;
  assert.equal(logged.title, "Security alert");
  assert.match(logged.image ?? "", /^\d+-[0-9a-f]{6}$/);

  await setSecurityMode(false);
  assert.match(await phoneAway(true, true), /Security mode is on/);
  assert.equal((await securityState()).by, "phone");
  assert.match(await phoneAway(false, true), /off/);
  await setSecurityMode(true, "voice");
  assert.equal(await phoneAway(false, true), "No change.", "coming home doesn't undo what the user switched on");
  await setSecurityMode(false);
  assert.ok(OWNER_ONLY.has("security_mode"));
});

test("electricity: readings add up to kWh; warnings when on while out or for hours", async () => {
  let now = new Date(2026, 8, 27, 8, 0).getTime();
  let readings: Reading[] = [];
  let away = false;
  const deps = { readings: async () => readings, away: async () => away, now: () => now };
  const step = async (minutes: number, r: Reading[]) => {
    now += minutes * 60_000;
    readings = r;
    return sampleEnergy(deps);
  };
  const ac = (w: number): Reading => ({ id: "ac", name: "Bedroom AC", watts: w });
  const fridge = (w: number): Reading => ({ id: "fr", name: "Fridge plug", watts: w });
  await step(0, [ac(1000), fridge(100)]);
  for (let i = 0; i < 12; i++) await step(5, [ac(1000), fridge(100)]); // an hour
  const out = await electricityUsage("today", "", new Date(now), deps);
  assert.match(out, /Bedroom AC: 1\.00 kWh \(~₹8\)/);
  assert.match(out, /Fridge plug: 0\.10 kWh/);
  assert.match(out, /Right now: Bedroom AC 1000 W, Fridge plug 100 W/);
  away = true;
  const w = await step(5, [ac(1000), fridge(100)]);
  assert.deepEqual(w, ["Sir, the Bedroom AC is still on (1000 W) while you're out. Shall I switch it off?"], "the fridge is meant to be on");
  assert.deepEqual(await step(5, [ac(1000), fridge(100)]), [], "once per run");
  away = false;
  await step(5, [ac(0), fridge(100)]);
  const gap = await step(120, [ac(1000), fridge(100)]);
  assert.deepEqual(gap, [], "a 2-hour gap (PC asleep) isn't counted or warned about");
  let long: string[] = [];
  for (let i = 0; i < 100 && !long.length; i++) long = await step(5, [ac(900), fridge(100)]);
  assert.match(long[0], /Bedroom AC has been running for 8 hours/);
});

test("security trigger: needs a face in most recent frames, then cools down", () => {
  const t = new IntruderTrigger(4, 3, 60_000);
  assert.equal(t.update(true, 0), false);
  assert.equal(t.update(false, 500), false);
  assert.equal(t.update(true, 1000), false);
  assert.equal(t.update(true, 1500), true);
  assert.equal(t.update(true, 2000), false);
  for (let i = 0; i < 5; i++) t.update(true, 3000 + i * 500);
  assert.equal(t.update(true, 62_000), true);
});

test("every new tool is declared once", () => {
  const names = TOOLS.map((x) => x.name);
  for (const n of ["inbox_digest", "send_email_reply", "scan_expenses", "track_packages", "travel_time", "watch_price", "habit_add", "habit_done", "upcoming_birthdays", "add_birthday", "security_mode", "electricity_usage"]) {
    assert.equal(names.filter((x) => x === n).length, 1, n);
  }
});
