import { getAccessToken } from "./googleAuth";

interface Person {
  names?: { displayName?: string }[];
  emailAddresses?: { value?: string }[];
  phoneNumbers?: { value?: string }[];
}

// Google's People API searchContacts endpoint only works once its search
// index has been "warmed" and is unreliable for freshly-connected accounts,
// so this fetches connections directly and filters client-side instead —
// slower for huge contact lists, but actually reliable.
const MAX_SCAN = 500;

export async function searchContacts(query: string, maxResults = 10): Promise<string> {
  const token = await getAccessToken();
  const needle = query.trim().toLowerCase();
  const matches: string[] = [];
  let pageToken: string | undefined;
  let scanned = 0;

  do {
    const params = new URLSearchParams({
      personFields: "names,emailAddresses,phoneNumbers",
      pageSize: "200",
    });
    if (pageToken) params.set("pageToken", pageToken);

    const res = await fetch(`https://people.googleapis.com/v1/people/me/connections?${params.toString()}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw new Error(`Google Contacts request failed (${res.status}): ${await res.text()}`);
    const data = (await res.json()) as { connections?: Person[]; nextPageToken?: string };

    for (const person of data.connections ?? []) {
      scanned += 1;
      const name = person.names?.[0]?.displayName ?? "";
      const email = person.emailAddresses?.[0]?.value ?? "";
      const phone = person.phoneNumbers?.[0]?.value ?? "";
      const haystack = `${name} ${email} ${phone}`.toLowerCase();
      if (!needle || haystack.includes(needle)) {
        const parts = [name || "(no name)"];
        if (email) parts.push(email);
        if (phone) parts.push(phone);
        matches.push(parts.join(" — "));
      }
      if (matches.length >= maxResults) break;
    }

    pageToken = matches.length >= maxResults ? undefined : data.nextPageToken;
  } while (pageToken && scanned < MAX_SCAN);

  if (matches.length === 0) return `No contacts found matching "${query}".`;
  return matches.slice(0, maxResults).join("\n");
}

/** Contacts whose name matches, with every phone number they have — for
 *  messaging someone by name. */
export async function findContactPhones(query: string): Promise<{ name: string; phones: string[] }[]> {
  const token = await getAccessToken();
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  const found: { name: string; phones: string[] }[] = [];
  let pageToken: string | undefined;
  let scanned = 0;
  do {
    const params = new URLSearchParams({ personFields: "names,phoneNumbers", pageSize: "200" });
    if (pageToken) params.set("pageToken", pageToken);
    const res = await fetch(`https://people.googleapis.com/v1/people/me/connections?${params.toString()}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw new Error(`Google Contacts request failed (${res.status}): ${await res.text()}`);
    const data = (await res.json()) as { connections?: Person[]; nextPageToken?: string };
    for (const person of data.connections ?? []) {
      scanned += 1;
      const name = person.names?.[0]?.displayName ?? "";
      const phones = (person.phoneNumbers ?? []).map((p) => p.value ?? "").filter(Boolean);
      if (name.toLowerCase().includes(needle) && phones.length) found.push({ name, phones });
    }
    pageToken = data.nextPageToken;
  } while (pageToken && scanned < MAX_SCAN);
  return found;
}
