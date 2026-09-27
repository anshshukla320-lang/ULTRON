import { getEmail, replyToEmail, searchEmailIds, type FullEmail } from "./gmailClient";
import { claudeJson, emailsForPrompt } from "./claudeJson";
import { jsonStore, localDay } from "./jsonStore";

// Inbox helper: once each morning (and whenever asked) ULTRON reads the
// unread mail that isn't promotions or notifications, says which emails
// matter, and drafts replies to the ones that need one. Nothing is sent
// until the user says so and approves the exact text in the confirm box.

const MODEL = "claude-sonnet-5";
const QUERY = "in:inbox is:unread newer_than:3d -category:promotions -category:social -category:updates -category:forums";
const MAX_EMAILS = 12;

export interface InboxItem {
  id: string;
  fromName: string;
  subject: string;
  summary: string;
  importance: "high" | "normal" | "low";
  needsReply: boolean;
  draft: string;
  at: string;
  sent?: boolean;
}

interface Store {
  items: InboxItem[];
  lastDigest?: string;
}

const store = jsonStore<Store>("inbox.json", () => ({ items: [] }));

interface Classified {
  message_id: string;
  summary: string;
  importance: "high" | "normal" | "low";
  needs_reply: boolean;
  draft_reply: string;
}

const SCHEMA = {
  type: "object",
  properties: {
    emails: {
      type: "array",
      items: {
        type: "object",
        properties: {
          message_id: { type: "string" },
          summary: { type: "string", description: "One sentence: what they want or say." },
          importance: { type: "string", enum: ["high", "normal", "low"], description: "high = a real person needs something soon, or money/deadlines/security; low = automated or FYI." },
          needs_reply: { type: "boolean", description: "True only if a person is waiting for an answer from the user." },
          draft_reply: { type: "string", description: "If needs_reply: a short reply in the user's voice, ready to send (no subject line, no placeholders in brackets; ask a clarifying question instead of inventing facts). Otherwise empty." },
        },
        required: ["message_id", "summary", "importance", "needs_reply", "draft_reply"],
        additionalProperties: false,
      },
    },
  },
  required: ["emails"],
  additionalProperties: false,
} as const;

export interface InboxDeps {
  search: (q: string, max: number) => Promise<string[]>;
  get: (id: string) => Promise<FullEmail>;
  classify: (emails: FullEmail[], ownerName: string) => Promise<Classified[]>;
  send: (email: FullEmail, body: string) => Promise<void>;
}

const claudeClassify: InboxDeps["classify"] = async (emails, ownerName) =>
  (
    await claudeJson<{ emails: Classified[] }>({
      model: MODEL,
      system: `You triage ${ownerName ? `${ownerName}'s` : "the user's"} email for their personal assistant and draft replies they can send as-is. Replies: warm, brief, natural, signed with ${ownerName ? `"${ownerName}"` : "no signature"}; never commit to money, dates or facts the email doesn't give — ask instead.`,
      content: emailsForPrompt(emails.map((e) => ({ id: e.id, text: `From: ${e.from}\nSubject: ${e.subject}\nDate: ${e.date}\n\n${e.body}` }))),
      schema: SCHEMA,
      usage: "email",
      maxTokens: 4096,
    })
  ).emails ?? [];

export const defaultInboxDeps: InboxDeps = {
  search: (q, max) => searchEmailIds(q, max),
  get: getEmail,
  classify: claudeClassify,
  send: replyToEmail,
};

/** The emails worth mentioning, most important first (the digest's numbering). */
function ordered(items: InboxItem[]): InboxItem[] {
  const order = { high: 0, normal: 1, low: 2 };
  return items.filter((i) => !i.sent && i.importance !== "low").sort((a, b) => order[a.importance] - order[b.importance]);
}

function render(items: InboxItem[]): string {
  const open = ordered(items);
  if (!open.length) return "Nothing in the inbox needs you right now.";
  return open
    .map((i, n) => `${n + 1}. ${i.fromName} — "${i.subject}": ${i.summary}${i.needsReply ? `\n   Draft reply: ${i.draft}` : ""}`)
    .join("\n");
}

/** inbox_digest tool / the morning run: triages new unread mail. */
export async function inboxDigest(now = new Date(), deps: InboxDeps = defaultInboxDeps): Promise<string> {
  const known = new Set((await store.read()).items.map((i) => i.id));
  const ids = (await deps.search(QUERY, MAX_EMAILS)).filter((id) => !known.has(id));
  const emails = (await Promise.all(ids.map((id) => deps.get(id).catch(() => null)))).filter((e): e is FullEmail => !!e);
  const classified = emails.length ? await deps.classify(emails, process.env.ULTRON_OWNER_NAME?.trim() ?? "") : [];
  const items = await store.update((s) => {
    for (const c of classified) {
      const e = emails.find((x) => x.id === c.message_id);
      if (!e) continue;
      s.items.push({
        id: e.id,
        fromName: e.fromName,
        subject: e.subject,
        summary: c.summary,
        importance: c.importance,
        needsReply: c.needs_reply && !!c.draft_reply.trim(),
        draft: c.draft_reply.trim(),
        at: now.toISOString(),
      });
    }
    // Keep the last few days.
    s.items = s.items.filter((i) => now.getTime() - new Date(i.at).getTime() < 4 * 86_400_000).slice(-60);
    return s.items;
  });
  return render(items);
}

/** Morning: triage once, return how many need a reply (for a short notice). */
export async function morningInbox(now = new Date(), deps: InboxDeps = defaultInboxDeps): Promise<InboxItem[]> {
  const s = await store.read();
  if (now.getHours() < 8 || s.lastDigest === localDay(now)) return [];
  await store.update((x) => void (x.lastDigest = localDay(now)));
  await inboxDigest(now, deps);
  return (await store.read()).items.filter((i) => i.needsReply && !i.sent && i.at === now.toISOString());
}

/** The draft whose sender or subject matches (or the Nth in the digest). */
export async function findInboxItem(who: string): Promise<InboxItem> {
  const all = ordered((await store.read()).items);
  const items = all.filter((i) => i.needsReply);
  const w = who.trim().toLowerCase();
  const n = Number(w.replace(/^#/, ""));
  const byNumber = Number.isInteger(n) && n > 0 ? all[n - 1] : undefined;
  const hit =
    (byNumber?.needsReply ? byNumber : undefined) ||
    items.find((i) => i.fromName.toLowerCase() === w) ||
    items.find((i) => i.fromName.toLowerCase().includes(w) || i.subject.toLowerCase().includes(w));
  if (!hit) throw new Error(`No drafted reply matches "${who}". Run inbox_digest to see the emails that need replies.`);
  return hit;
}

/** send_email_reply tool (after the user approved the exact text). */
export async function sendInboxReply(who: string, body: string, deps: InboxDeps = defaultInboxDeps): Promise<string> {
  if (!body.trim()) throw new Error("The reply is empty.");
  const item = await findInboxItem(who);
  const email = await deps.get(item.id);
  await deps.send(email, body.trim());
  await store.update((s) => {
    const i = s.items.find((x) => x.id === item.id);
    if (i) i.sent = true;
  });
  return `Replied to ${item.fromName} ("${item.subject}").`;
}
