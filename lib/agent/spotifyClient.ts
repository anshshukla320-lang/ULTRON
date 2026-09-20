import { getAccessToken } from "./spotifyAuth";
import { openApp } from "./systemActions";

interface SpotifyDevice {
  id: string;
  is_active: boolean;
  name: string;
  type: string;
}

interface SpotifyTrack {
  uri: string;
  name: string;
  artists: { name: string }[];
}

async function spotifyFetch(path: string, init?: RequestInit): Promise<Response> {
  const token = await getAccessToken();
  return fetch(`https://api.spotify.com/v1${path}`, {
    ...init,
    headers: { ...(init?.headers ?? {}), Authorization: `Bearer ${token}` },
  });
}

async function getDevices(): Promise<SpotifyDevice[]> {
  const res = await spotifyFetch("/me/player/devices");
  if (!res.ok) throw new Error(`Couldn't list Spotify devices (${res.status}).`);
  const data = (await res.json()) as { devices?: SpotifyDevice[] };
  return data.devices ?? [];
}

/** Finds a device to control, opening the desktop app and giving it a few
 *  seconds to register with Spotify Connect if nothing is available yet. */
async function ensureDevice(): Promise<string> {
  let devices = await getDevices();
  if (devices.length === 0) {
    await openApp("spotify").catch(() => {
      throw new Error("Couldn't find or open the Spotify app — install it or open it manually, then try again.");
    });
    for (let i = 0; i < 5 && devices.length === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      devices = await getDevices();
    }
  }
  if (devices.length === 0) {
    throw new Error("No Spotify device found even after opening the app — make sure you're logged in, then try again.");
  }
  return (devices.find((d) => d.is_active) ?? devices[0]).id;
}

async function searchTrack(query: string): Promise<SpotifyTrack> {
  const res = await spotifyFetch(`/search?type=track&limit=1&q=${encodeURIComponent(query)}`);
  if (!res.ok) throw new Error(`Spotify search failed (${res.status}).`);
  const data = (await res.json()) as { tracks?: { items?: SpotifyTrack[] } };
  const track = data.tracks?.items?.[0];
  if (!track) throw new Error(`No Spotify track found for "${query}".`);
  return track;
}

async function assertPlaybackOk(res: Response, action: string): Promise<void> {
  if (res.ok) return;
  if (res.status === 403) {
    throw new Error(`${action} failed — this needs Spotify Premium (free accounts can't be remote-controlled).`);
  }
  if (res.status === 404) {
    throw new Error(`${action} failed — no active Spotify device. Open Spotify and try again.`);
  }
  throw new Error(`${action} failed (${res.status}): ${await res.text()}`);
}

export async function playTrack(query?: string): Promise<string> {
  const deviceId = await ensureDevice();

  if (query && query.trim()) {
    const track = await searchTrack(query.trim());
    const res = await spotifyFetch(`/me/player/play?device_id=${deviceId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ uris: [track.uri] }),
    });
    await assertPlaybackOk(res, "Play");
    return `Playing "${track.name}" by ${track.artists.map((a) => a.name).join(", ")} on Spotify.`;
  }

  const res = await spotifyFetch(`/me/player/play?device_id=${deviceId}`, { method: "PUT" });
  await assertPlaybackOk(res, "Resume");
  return "Resumed Spotify playback.";
}

export async function pausePlayback(): Promise<string> {
  const deviceId = await ensureDevice();
  const res = await spotifyFetch(`/me/player/pause?device_id=${deviceId}`, { method: "PUT" });
  await assertPlaybackOk(res, "Pause");
  return "Paused Spotify playback.";
}

export async function nextTrack(): Promise<string> {
  const deviceId = await ensureDevice();
  const res = await spotifyFetch(`/me/player/next?device_id=${deviceId}`, { method: "POST" });
  await assertPlaybackOk(res, "Skip");
  return "Skipped to the next track.";
}

export async function previousTrack(): Promise<string> {
  const deviceId = await ensureDevice();
  const res = await spotifyFetch(`/me/player/previous?device_id=${deviceId}`, { method: "POST" });
  await assertPlaybackOk(res, "Previous track");
  return "Went back to the previous track.";
}
