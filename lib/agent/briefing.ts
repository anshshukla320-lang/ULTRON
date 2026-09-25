import { listTodaysEvents } from "./calendarClient";
import { listImportantUnread } from "./gmailClient";
import { listTasks } from "./tasksClient";
import { getWeather } from "./weather";
import { listReminders } from "./reminders";

/**
 * Gathers everything for a spoken morning briefing in one tool call:
 * weather, the rest of today's calendar, important unread email, open
 * tasks, and pending reminders. Each part is fetched in parallel and fails
 * on its own — a missing Google connection shouldn't lose the weather.
 */
export async function morningBriefing(location?: string): Promise<string> {
  const sections: [string, Promise<string>][] = [
    ["Weather", getWeather(location)],
    ["Calendar (rest of today)", listTodaysEvents()],
    [
      "Important unread email",
      listImportantUnread(5).then((mails) =>
        mails.length ? mails.map((m) => `${m.from}: ${m.subject}`).join("\n") : "No important unread email.",
      ),
    ],
    ["Open tasks", listTasks(10)],
    ["Timers and reminders", listReminders()],
  ];
  const results = await Promise.allSettled(sections.map(([, p]) => p));
  return sections
    .map(([title], i) => {
      const r = results[i];
      const body = r.status === "fulfilled" ? r.value : `(unavailable: ${r.reason instanceof Error ? r.reason.message : String(r.reason)})`;
      return `## ${title}\n${body}`;
    })
    .join("\n\n");
}
