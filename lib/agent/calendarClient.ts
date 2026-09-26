import { getAccessToken } from "./googleAuth";

interface CalendarEvent {
  id: string;
  summary?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
  location?: string;
}

async function calendarFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const token = await getAccessToken();
  const res = await fetch(`https://www.googleapis.com/calendar/v3${path}`, {
    ...init,
    headers: { ...(init?.headers ?? {}), Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    throw new Error(`Google Calendar API error (${res.status}): ${await res.text()}`);
  }
  return res.json() as Promise<T>;
}

function formatEvent(e: CalendarEvent): string {
  const when = e.start?.dateTime ?? e.start?.date ?? "unknown time";
  const where = e.location ? ` @ ${e.location}` : "";
  return `[${e.id}] ${e.summary ?? "(untitled)"} — ${when}${where}`;
}

export async function listUpcomingEvents(maxResults = 10): Promise<string> {
  const params = new URLSearchParams({
    maxResults: String(Math.min(maxResults, 50)),
    singleEvents: "true",
    orderBy: "startTime",
    timeMin: new Date().toISOString(),
  });
  const data = await calendarFetch<{ items?: CalendarEvent[] }>(`/calendars/primary/events?${params.toString()}`);
  const items = data.items ?? [];
  if (items.length === 0) return "No upcoming events found.";
  return items.map(formatEvent).join("\n");
}

/** Timed (not all-day) events starting within the next `minutes`, for
 *  proactive "your meeting starts soon" notices. */
export async function eventsStartingWithin(minutes: number): Promise<{ id: string; summary: string; start: Date }[]> {
  const now = new Date();
  const params = new URLSearchParams({
    maxResults: "10",
    singleEvents: "true",
    orderBy: "startTime",
    timeMin: now.toISOString(),
    timeMax: new Date(now.getTime() + minutes * 60_000).toISOString(),
  });
  const data = await calendarFetch<{ items?: CalendarEvent[] }>(`/calendars/primary/events?${params.toString()}`);
  return (data.items ?? [])
    .filter((e) => e.start?.dateTime)
    .map((e) => ({ id: e.id, summary: e.summary ?? "an untitled event", start: new Date(e.start!.dateTime!) }))
    .filter((e) => e.start.getTime() >= now.getTime());
}

/** The rest of today's events (for the morning briefing). */
export async function listTodaysEvents(): Promise<string> {
  const endOfDay = new Date();
  endOfDay.setHours(23, 59, 59, 999);
  const params = new URLSearchParams({
    maxResults: "20",
    singleEvents: "true",
    orderBy: "startTime",
    timeMin: new Date().toISOString(),
    timeMax: endOfDay.toISOString(),
  });
  const data = await calendarFetch<{ items?: CalendarEvent[] }>(`/calendars/primary/events?${params.toString()}`);
  const items = data.items ?? [];
  if (items.length === 0) return "Nothing else on the calendar today.";
  return items.map(formatEvent).join("\n");
}

export async function createEvent(summary: string, startISO: string, endISO: string, description?: string): Promise<string> {
  const body = {
    summary,
    description,
    start: { dateTime: startISO },
    end: { dateTime: endISO },
  };
  const event = await calendarFetch<CalendarEvent>("/calendars/primary/events", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return `Created event "${summary}" (${formatEvent(event)}).`;
}
