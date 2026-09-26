import "./tempHome";
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  buildTuyaCommands,
  controlTuya,
  describeTuya,
  findTuyaDevice,
  parseColor,
  resetTuyaState,
  scalePercent,
  tuyaSign,
  type TuyaDevice,
} from "../lib/agent/tuya";
import { controlTv, magicPacket, pickPackage, setAdbRunner, shQuote } from "../lib/agent/androidTv";
import { controlSmartHome, listSmartHome } from "../lib/agent/smartHome";

const BULB: TuyaDevice = {
  id: "bulb1",
  name: "Bedroom Light",
  category: "dj",
  online: true,
  status: [
    { code: "switch_led", value: true },
    { code: "work_mode", value: "white" },
    { code: "bright_value_v2", value: 500 },
    { code: "temp_value_v2", value: 0 },
    { code: "colour_data_v2", value: { h: 0, s: 0, v: 0 } },
  ],
};
const PLUG: TuyaDevice = { id: "plug1", name: "Fan", category: "cz", online: true, status: [{ code: "switch_1", value: false }] };
const LOCK: TuyaDevice = { id: "lock1", name: "Front Door", category: "ms", online: true, status: [{ code: "switch_1", value: false }] };

test("Tuya request signature matches Tuya's own SDK", () => {
  // Expected values produced by tuya-iot-py-sdk's _calculate_sign with the
  // same inputs (t = 1700000000123).
  const base = { clientId: "myclientid", secret: "mysecret0123456789", t: "1700000000123" };
  assert.equal(
    tuyaSign({ ...base, accessToken: "", method: "GET", path: "/v1.0/token", query: { grant_type: "1" } }).sign,
    "50542CC7C84D7C0241320FDCEFF96A99991312288F3575975AA970EC957FB244",
  );
  assert.equal(
    tuyaSign({
      ...base,
      accessToken: "tok123",
      method: "POST",
      path: "/v1.0/iot-03/devices/abc/commands",
      body: '{"commands": [{"code": "switch_led", "value": true}]}',
    }).sign,
    "617BEE6C763AF4B325E02318E061627E1CC5D7F2779453A3219710270E19D2D2",
  );
  const list = tuyaSign({ ...base, accessToken: "tok123", method: "GET", path: "/v1.0/iot-01/associated-users/devices", query: { size: "100", last_row_key: "K1" } });
  assert.equal(list.sign, "CC4BD164F1E6136AA4138883E1E2127D3C04982FFE0CA24787DAB82C4CF7785D");
  assert.equal(list.url, "/v1.0/iot-01/associated-users/devices?last_row_key=K1&size=100", "query sorted");
});

test("Tuya: turning requests into device commands", () => {
  assert.deepEqual(buildTuyaCommands(BULB, [], { action: "off" }), [{ code: "switch_led", value: false }]);
  assert.deepEqual(buildTuyaCommands(BULB, [], { action: "toggle" }), [{ code: "switch_led", value: false }]);
  assert.deepEqual(buildTuyaCommands(PLUG, [], { action: "on" }), [{ code: "switch_1", value: true }]);

  // Brightness on the device's own scale, from its specification.
  const fns = [{ code: "bright_value_v2", type: "Integer", values: '{"min":10,"max":1000,"scale":0,"step":1}' }];
  assert.deepEqual(buildTuyaCommands(BULB, fns, { action: "set", brightness: 30 }), [
    { code: "switch_led", value: true },
    { code: "work_mode", value: "white" },
    { code: "bright_value_v2", value: 307 },
  ]);
  const colour = buildTuyaCommands(BULB, [], { action: "set", color: "blue", brightness: 50 });
  assert.deepEqual(colour.slice(1), [
    { code: "work_mode", value: "colour" },
    { code: "colour_data_v2", value: { h: 230, s: 1000, v: 500 } },
  ]);
  assert.deepEqual(buildTuyaCommands(BULB, [], { action: "set", warmth: 0 }).at(-1), { code: "temp_value_v2", value: 0 });
  assert.throws(() => buildTuyaCommands(PLUG, [], { action: "set", brightness: 50 }), /can't be dimmed/);
  assert.throws(() => buildTuyaCommands(BULB, [], { action: "set", color: "plaid" }), /colour "plaid"/);
  assert.throws(() => buildTuyaCommands(BULB, [], { action: "explode" }), /Don't know how/);

  assert.equal(scalePercent(0, { min: 25, max: 255 }), 25);
  assert.equal(scalePercent(100, { min: 25, max: 255 }), 255);
  assert.deepEqual(parseColor("#ff0000"), { h: 0, s: 1 });
  assert.deepEqual(parseColor("#00ff00"), { h: 120, s: 1 });
  assert.equal(describeTuya(BULB), "tuya:bulb1 — Bedroom Light (light) — on (brightness 50%)");
  assert.equal(describeTuya({ ...PLUG, online: false }), "tuya:plug1 — Fan (plug) — OFFLINE");
});

function fakeTuyaCloud(t: import("node:test").TestContext, devices: TuyaDevice[]) {
  const calls: { method: string; url: string; body?: string; headers: Record<string, string> }[] = [];
  let tokenCount = 0;
  let failNextWith1010 = false;
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    const u = new URL(url);
    const headers = init.headers as Record<string, string>;
    calls.push({ method: init.method ?? "GET", url: u.pathname + u.search, body: init.body as string | undefined, headers });
    if (u.pathname === "/v1.0/token") return Response.json({ success: true, result: { access_token: `tok${++tokenCount}`, expire_time: 7200 } });
    if (failNextWith1010) {
      failNextWith1010 = false;
      return Response.json({ success: false, code: 1010, msg: "token invalid" });
    }
    if (u.pathname === "/v1.0/iot-01/associated-users/devices") return Response.json({ success: true, result: { devices, has_more: false } });
    if (u.pathname.endsWith("/specification")) return Response.json({ success: true, result: { functions: [] } });
    if (u.pathname.endsWith("/commands")) return Response.json({ success: true, result: true });
    return Response.json({ success: false, code: 1108, msg: "uri path invalid" });
  });
  return { calls, expireToken: () => (failNextWith1010 = true) };
}

beforeEach(() => {
  resetTuyaState();
  process.env.TUYA_ACCESS_ID = "id";
  process.env.TUYA_ACCESS_SECRET = "secret";
  delete process.env.TUYA_REGION;
  delete process.env.HOME_ASSISTANT_URL;
  delete process.env.HOME_ASSISTANT_TOKEN;
  delete process.env.ANDROID_TV_HOST;
});

test("Tuya: find by name, control, security gating, token refresh", async (t) => {
  const cloud = fakeTuyaCloud(t, [BULB, PLUG, LOCK]);
  assert.equal((await findTuyaDevice("bedroom")).id, "bulb1");
  assert.equal((await findTuyaDevice("tuya:plug1")).name, "Fan");
  await assert.rejects(findTuyaDevice("kitchen"), /No Smart Life device called "kitchen"/);

  assert.match(await controlSmartHome({ device: "fan", action: "on" }), /Fan \(plug\) — on/);
  const cmd = cloud.calls.find((c) => c.url.endsWith("/plug1/commands"))!;
  assert.deepEqual(JSON.parse(cmd.body!), { commands: [{ code: "switch_1", value: true }] });
  assert.ok(cmd.url.startsWith("/v1.0/iot-03/devices/"), "India data centre by default");
  assert.equal(cmd.headers.sign_method, "HMAC-SHA256");
  assert.equal(cmd.headers.access_token, "tok1");

  await assert.rejects(controlTuya("front door", { action: "on" }), /smart_home_security/);
  assert.ok(!cloud.calls.some((c) => c.url.includes("/lock1/commands")), "the lock was never touched");

  cloud.expireToken();
  assert.match(await controlSmartHome({ device: "tuya:bulb1", action: "off" }), /off/);
  assert.equal(cloud.calls.at(-1)!.headers.access_token, "tok2", "retried with a fresh token");

  assert.match(await listSmartHome(), /tuya:bulb1 — Bedroom Light \(light\) — on[\s\S]*tuya:plug1 — Fan/);
});

test("Tuya: helpful errors", async (t) => {
  t.mock.method(globalThis, "fetch", async (url: string) =>
    new URL(url).pathname === "/v1.0/token"
      ? Response.json({ success: true, result: { access_token: "tok", expire_time: 7200 } })
      : Response.json({ success: false, code: 28841105, msg: "No permissions" }),
  );
  await assert.rejects(listSmartHome(), /IoT Core/);
  delete process.env.TUYA_ACCESS_ID;
  await assert.rejects(listSmartHome(), /TUYA_ACCESS_ID/);
  await assert.rejects(controlSmartHome({ device: "bedroom light", action: "on" }), /No smart-home connection/);
});

test("TV: adb commands, quoting, app launch, pairing prompt", async () => {
  process.env.ANDROID_TV_HOST = "192.168.1.40";
  const shellCmds: string[] = [];
  let authorized = true;
  let awake = false;
  setAdbRunner(async (args) => {
    if (args[0] === "connect") return authorized ? "connected to 192.168.1.40:5555" : "failed to authenticate to 192.168.1.40:5555";
    if (args[2] === "get-state") return "device";
    assert.deepEqual(args.slice(0, 3), ["-s", "192.168.1.40:5555", "shell"]);
    const cmd = args[3];
    shellCmds.push(cmd);
    if (cmd.startsWith("cat /sys/class/net")) return "aa:bb:cc:dd:ee:ff";
    if (cmd.startsWith("dumpsys power")) return awake ? "mWakefulness=Awake" : "mWakefulness=Asleep";
    if (cmd === "pm list packages") return "package:com.netflix.ninja\npackage:com.google.android.youtube.tv\npackage:com.android.vending";
    if (cmd.includes("resolve-activity") && cmd.includes("LEANBACK")) return "priority=0 preferredOrder=0\ncom.netflix.ninja/.MainActivity";
    return "";
  });
  try {
    assert.equal(await controlTv({ action: "power on" }), "The TV is on.");
    assert.ok(shellCmds.includes("input keyevent 224"), "woken up");
    awake = true;
    await controlTv({ action: "volume_down", steps: 4 });
    assert.ok(shellCmds.includes("input keyevent 25 25 25 25"));
    await controlTv({ action: "open_app", app: "Netflix" });
    assert.ok(shellCmds.includes("am start -n com.netflix.ninja/.MainActivity"));
    await assert.rejects(controlTv({ action: "open_app", app: "Hulu" }), /isn't installed/);

    await controlTv({ action: "youtube_search", query: "lo-fi beats; rm -rf / 'x'" });
    const yt = shellCmds.at(-1)!;
    assert.match(yt, /^am start -a android.intent.action.VIEW -d '[^']*' com.google.android.youtube.tv$/, "query stays inside one quoted, encoded argument");
    await controlTv({ action: "type_text", text: "it's here" });
    assert.equal(shellCmds.at(-1), `input text 'it'\\''s%shere'`);

    await controlTv({ action: "power_off" });
    assert.equal(shellCmds.at(-1), "input keyevent 223");
    await assert.rejects(controlTv({ action: "self_destruct" }), /can't "self_destruct"/);

    authorized = false;
    await assert.rejects(controlTv({ action: "mute" }), /allow debugging/i);
  } finally {
    setAdbRunner(null);
  }
  delete process.env.ANDROID_TV_HOST;
  await assert.rejects(controlTv({ action: "mute" }), /ANDROID_TV_HOST/);
});

test("TV helpers", () => {
  assert.equal(pickPackage("youtube", ["com.google.android.youtube", "com.google.android.youtube.tv"]), "com.google.android.youtube.tv");
  assert.equal(pickPackage("Prime Video", ["com.amazon.amazonvideo.livingroom"]), "com.amazon.amazonvideo.livingroom");
  assert.equal(pickPackage("kodi", ["org.xbmc.kodi"]), "org.xbmc.kodi");
  assert.equal(pickPackage("spotify", []), null);
  assert.equal(shQuote("a'b"), `'a'\\''b'`);
  const p = magicPacket("AA:BB:CC:DD:EE:FF");
  assert.equal(p.length, 102);
  assert.ok(p.subarray(0, 6).every((b) => b === 0xff));
  assert.equal(p.subarray(96).toString("hex"), "aabbccddeeff");
  assert.throws(() => magicPacket("nope"), /isn't a MAC/);
});
