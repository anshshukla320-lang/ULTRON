import { getAccessToken } from "./googleAuth";

const MAX_READ_BYTES = 100_000;

interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime?: string;
}

async function driveFetch(path: string, init?: RequestInit): Promise<Response> {
  const token = await getAccessToken();
  return fetch(`https://www.googleapis.com/drive/v3${path}`, {
    ...init,
    headers: { ...(init?.headers ?? {}), Authorization: `Bearer ${token}` },
  });
}

export async function searchFiles(query: string, maxResults = 10): Promise<string> {
  const params = new URLSearchParams({
    pageSize: String(Math.min(maxResults, 50)),
    fields: "files(id,name,mimeType,modifiedTime)",
    q: query ? `name contains '${query.replace(/'/g, "\\'")}' and trashed = false` : "trashed = false",
    orderBy: "modifiedTime desc",
  });
  const res = await driveFetch(`/files?${params.toString()}`);
  if (!res.ok) throw new Error(`Google Drive search failed (${res.status}): ${await res.text()}`);
  const data = (await res.json()) as { files?: DriveFile[] };
  const files = data.files ?? [];
  if (files.length === 0) return `No Drive files found matching "${query}".`;
  return files.map((f) => `[${f.id}] ${f.name} (${f.mimeType})`).join("\n");
}

const EXPORT_MIME_BY_TYPE: Record<string, string> = {
  "application/vnd.google-apps.document": "text/plain",
  "application/vnd.google-apps.spreadsheet": "text/csv",
  "application/vnd.google-apps.presentation": "text/plain",
};

export async function readFile(fileId: string): Promise<string> {
  const metaRes = await driveFetch(`/files/${fileId}?fields=id,name,mimeType`);
  if (!metaRes.ok) throw new Error(`Couldn't look up Drive file "${fileId}" (${metaRes.status}): ${await metaRes.text()}`);
  const meta = (await metaRes.json()) as DriveFile;

  const exportMime = EXPORT_MIME_BY_TYPE[meta.mimeType];
  const contentRes = exportMime
    ? await driveFetch(`/files/${fileId}/export?mimeType=${encodeURIComponent(exportMime)}`)
    : await driveFetch(`/files/${fileId}?alt=media`);

  if (!contentRes.ok) {
    throw new Error(`Couldn't read Drive file "${meta.name}" (${contentRes.status}): ${await contentRes.text()}`);
  }

  const buf = await contentRes.arrayBuffer();
  if (buf.byteLength > MAX_READ_BYTES) {
    throw new Error(`"${meta.name}" is too large to read (${buf.byteLength} bytes, limit ${MAX_READ_BYTES}).`);
  }

  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(buf);
  } catch {
    throw new Error(`"${meta.name}" doesn't look like a readable text file (binary content).`);
  }

  return `${meta.name}:\n\n${text}`;
}
