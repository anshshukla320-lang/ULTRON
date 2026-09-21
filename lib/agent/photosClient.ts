import { getAccessToken } from "./googleAuth";

interface MediaItem {
  filename?: string;
  mediaMetadata?: { creationTime?: string };
}

const LIMITATION_NOTE =
  "Note: since March 2025, Google restricts third-party apps to only photos/videos the app itself uploaded — " +
  "ULTRON has never uploaded anything, so this will almost always be empty. There is no way for any third-party " +
  "app to browse your existing Google Photos library anymore; this isn't specific to ULTRON.";

export async function listRecentPhotos(maxResults = 10): Promise<string> {
  const token = await getAccessToken();
  const res = await fetch("https://photoslibrary.googleapis.com/v1/mediaItems", {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    throw new Error(`Google Photos API error (${res.status}): ${await res.text()}\n${LIMITATION_NOTE}`);
  }
  const data = (await res.json()) as { mediaItems?: MediaItem[] };
  const items = (data.mediaItems ?? []).slice(0, maxResults);
  if (items.length === 0) return `No photos found. ${LIMITATION_NOTE}`;

  const list = items.map((m) => `${m.filename ?? "(untitled)"} (${m.mediaMetadata?.creationTime ?? "unknown date"})`).join("\n");
  return `${list}\n\n${LIMITATION_NOTE}`;
}
