import { NextResponse } from "next/server";
import { getSettings, updateSettings, type Settings } from "@/lib/agent/settings";
import { clearAllFacts, deleteFactExact, listFacts, rememberFact } from "@/lib/agent/memory";
import { deleteEpisode, listEpisodes } from "@/lib/agent/episodes";
import { cancelReminder, listRemindersRaw, setDailyBriefing } from "@/lib/agent/reminders";
import { getProactiveState, setProactive } from "@/lib/agent/proactive";
import { usageSummary } from "@/lib/agent/usage";

export const runtime = "nodejs";

/** Everything the control panel shows, in one call. */
async function snapshot() {
  const [settings, facts, episodes, reminders, proactive, usage] = await Promise.all([
    getSettings(),
    listFacts(),
    listEpisodes(),
    listRemindersRaw(),
    getProactiveState(),
    usageSummary(),
  ]);
  return {
    settings,
    facts,
    episodes: [...episodes].reverse(),
    reminders,
    proactive,
    usage,
    integrations: {
      google: Boolean(process.env.GOOGLE_CLIENT_ID),
      homeAssistant: Boolean(process.env.HOME_ASSISTANT_URL && process.env.HOME_ASSISTANT_TOKEN),
      telegram: Boolean(process.env.TELEGRAM_BOT_TOKEN),
      homeLocation: process.env.ULTRON_HOME_LOCATION ?? null,
    },
  };
}

export async function GET() {
  return NextResponse.json(await snapshot());
}

type Action =
  | { action: "update"; settings: Partial<Settings> }
  | { action: "add_fact"; text: string }
  | { action: "delete_fact"; text: string }
  | { action: "clear_facts" }
  | { action: "delete_episode"; id: string }
  | { action: "cancel_reminder"; id: string }
  | { action: "briefing"; time: string }
  | { action: "proactive"; enabled?: boolean; quietHours?: string };

export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as Action | null;
  if (!body || typeof body !== "object") return NextResponse.json({ error: "Expected JSON." }, { status: 400 });
  try {
    switch (body.action) {
      case "update":
        await updateSettings(body.settings ?? {});
        break;
      case "add_fact":
        await rememberFact(String(body.text ?? ""));
        break;
      case "delete_fact":
        await deleteFactExact(String(body.text ?? ""));
        break;
      case "clear_facts":
        await clearAllFacts();
        break;
      case "delete_episode":
        await deleteEpisode(String(body.id ?? ""));
        break;
      case "cancel_reminder":
        await cancelReminder(String(body.id ?? ""));
        break;
      case "briefing":
        await setDailyBriefing(String(body.time ?? "off"));
        break;
      case "proactive":
        await setProactive(body.enabled, body.quietHours);
        break;
      default:
        return NextResponse.json({ error: "Unknown action." }, { status: 400 });
    }
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 400 });
  }
  return NextResponse.json(await snapshot());
}
