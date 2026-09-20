import Twilio from "twilio";
import { gatherMachineHealth, type HealthIssue, type MachineHealth } from "./machineHealth";
import { listImportantUnread, type EmailBrief } from "./gmailClient";
import { stashCallScript } from "./callCache";

const E164_RE = /^\+[1-9]\d{6,14}$/;

function buildSpokenReport(health: MachineHealth, issues: HealthIssue[], emails: EmailBrief[]): string {
  const parts: string[] = [`This is Ultron with a status report for ${health.hostname}.`];

  if (issues.length === 0) {
    parts.push("Everything looks healthy — no disk, memory, C P U, or system error issues found.");
  } else {
    parts.push(`I found ${issues.length} issue${issues.length === 1 ? "" : "s"}.`);
    for (const issue of issues) parts.push(`${issue.detail}.`);
  }

  if (emails.length === 0) {
    parts.push("No important unread emails.");
  } else {
    parts.push(`You have ${emails.length} important unread email${emails.length === 1 ? "" : "s"}:`);
    for (const e of emails) parts.push(`One from ${e.from}, about ${e.subject}.`);
  }

  parts.push("That's the report. Anything you'd like to ask?");
  return parts.join(" ");
}

export async function placeHealthReportCall(): Promise<string> {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_PHONE_NUMBER;
  const to = process.env.USER_PHONE_NUMBER;

  const publicUrl = process.env.PUBLIC_URL;

  if (!accountSid || !authToken) throw new Error("TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN are not set in .env.local.");
  if (!from) throw new Error("TWILIO_PHONE_NUMBER is not set in .env.local.");
  if (!to) throw new Error("USER_PHONE_NUMBER is not set in .env.local.");
  if (!publicUrl) throw new Error("PUBLIC_URL is not set in .env.local (needed so Twilio can fetch what to say).");
  if (!E164_RE.test(from)) throw new Error(`TWILIO_PHONE_NUMBER "${from}" isn't a valid E.164 number (e.g. +15551234567).`);
  if (!E164_RE.test(to)) throw new Error(`USER_PHONE_NUMBER "${to}" isn't a valid E.164 number (e.g. +15551234567).`);

  const { health, issues } = await gatherMachineHealth();

  let emails: EmailBrief[] = [];
  try {
    emails = await listImportantUnread(5);
  } catch {
    // Gmail not connected or errored — don't block the health report over it.
  }

  const script = buildSpokenReport(health, issues, emails);
  const token = stashCallScript(script);
  const url = `${publicUrl.replace(/\/$/, "")}/api/call/twiml?token=${token}`;

  const client = Twilio(accountSid, authToken);
  const call = await client.calls.create({ to, from, url });

  const summary = issues.length ? `flagged: ${issues.map((i) => i.kind).join(", ")}` : "no issues found";
  return `Called ${to} (call sid ${call.sid}) and read out the machine health report — ${summary}, ${emails.length} important unread email(s).`;
}
