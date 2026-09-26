import { getAccessToken } from "./googleAuth";

interface GmailHeader {
  name: string;
  value: string;
}

interface GmailPart {
  mimeType?: string;
  body?: { data?: string };
  parts?: GmailPart[];
}

interface GmailMessage {
  id: string;
  snippet?: string;
  payload?: GmailPart & { headers?: GmailHeader[] };
}

async function gmailFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const token = await getAccessToken();
  const res = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me${path}`, {
    ...init,
    headers: { ...(init?.headers ?? {}), Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    throw new Error(`Gmail API error (${res.status}): ${await res.text()}`);
  }
  return res.json() as Promise<T>;
}

function decodeBase64Url(data: string): string {
  const normalized = data.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(normalized, "base64").toString("utf-8");
}

function encodeBase64Url(data: string): string {
  return Buffer.from(data, "utf-8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function extractHeader(headers: GmailHeader[] | undefined, name: string): string {
  return headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? "";
}

function extractPlainText(payload: GmailPart | undefined): string {
  if (!payload) return "";
  if (payload.mimeType === "text/plain" && payload.body?.data) {
    return decodeBase64Url(payload.body.data);
  }
  if (payload.parts) {
    for (const part of payload.parts) {
      if (part.mimeType === "text/plain" && part.body?.data) return decodeBase64Url(part.body.data);
    }
    for (const part of payload.parts) {
      const text = extractPlainText(part);
      if (text) return text;
    }
  }
  if (payload.mimeType === "text/html" && payload.body?.data) {
    return decodeBase64Url(payload.body.data)
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }
  return "";
}

export async function listEmails(query = "", maxResults = 8): Promise<string> {
  const params = new URLSearchParams({ maxResults: String(Math.min(maxResults, 15)) });
  if (query) params.set("q", query);
  const listData = await gmailFetch<{ messages?: { id: string }[] }>(`/messages?${params.toString()}`);
  const ids = (listData.messages ?? []).map((m) => m.id);
  if (ids.length === 0) return query ? `No emails found matching "${query}".` : "No emails found.";

  const summaries = await Promise.all(
    ids.map(async (id) => {
      const msg = await gmailFetch<GmailMessage>(
        `/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`,
      );
      const headers = msg.payload?.headers;
      return `[${id}] From: ${extractHeader(headers, "From")} | Subject: ${extractHeader(headers, "Subject")} | ${extractHeader(headers, "Date")}\n  ${msg.snippet ?? ""}`;
    }),
  );
  return summaries.join("\n\n");
}

export interface EmailBrief {
  id: string;
  from: string;
  subject: string;
}

function shortSender(fromHeader: string): string {
  const match = fromHeader.match(/^"?([^"<]+)"?\s*<[^>]+>$/);
  return (match ? match[1] : fromHeader).trim() || "someone";
}

export async function listImportantUnread(maxResults = 5): Promise<EmailBrief[]> {
  const params = new URLSearchParams({ maxResults: String(maxResults), q: "is:important is:unread" });
  const listData = await gmailFetch<{ messages?: { id: string }[] }>(`/messages?${params.toString()}`);
  const ids = (listData.messages ?? []).map((m) => m.id);
  if (ids.length === 0) return [];

  return Promise.all(
    ids.map(async (id) => {
      const msg = await gmailFetch<GmailMessage>(
        `/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject`,
      );
      const headers = msg.payload?.headers;
      return { id, from: shortSender(extractHeader(headers, "From")), subject: extractHeader(headers, "Subject") || "(no subject)" };
    }),
  );
}

export async function readEmail(id: string): Promise<string> {
  const msg = await gmailFetch<GmailMessage>(`/messages/${id}?format=full`);
  const headers = msg.payload?.headers;
  const body = extractPlainText(msg.payload) || msg.snippet || "(no readable body)";
  return `From: ${extractHeader(headers, "From")}\nTo: ${extractHeader(headers, "To")}\nSubject: ${extractHeader(headers, "Subject")}\nDate: ${extractHeader(headers, "Date")}\n\n${body.slice(0, 4000)}`;
}

export async function sendEmail(to: string, subject: string, body: string): Promise<string> {
  const raw = encodeBase64Url(`To: ${to}\r\nSubject: ${subject}\r\nContent-Type: text/plain; charset="UTF-8"\r\n\r\n${body}`);
  await gmailFetch(`/messages/send`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ raw }),
  });
  return `Email sent to ${to}.`;
}
