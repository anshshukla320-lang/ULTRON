import { openUrl, playMusic as braveFallbackSearch } from "./systemActions";
import { getAccessToken } from "./googleAuth";

interface YouTubeVideo {
  videoId: string;
  title: string;
  channel: string;
}

interface YouTubeSearchItem {
  id?: { videoId?: string };
  snippet?: { title?: string; channelTitle?: string };
}

async function searchViaYouTubeApi(query: string): Promise<YouTubeVideo | null> {
  const apiKey = process.env.YOUTUBE_API_KEY;
  if (!apiKey) return null;

  const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&maxResults=1&q=${encodeURIComponent(query)}&key=${apiKey}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`YouTube search failed (${res.status}): ${await res.text()}`);
  }
  const data = (await res.json()) as { items?: YouTubeSearchItem[] };
  const item = data.items?.[0];
  const videoId = item?.id?.videoId;
  if (!videoId) return null;

  return { videoId, title: item?.snippet?.title ?? query, channel: item?.snippet?.channelTitle ?? "" };
}

/** Finds and opens a specific YouTube video with autoplay requested. Prefers
 *  the real YouTube Data API for accurate results; falls back to the
 *  Brave-search-based guess (systemActions.playMusic) if no API key is
 *  configured or the API finds nothing. */
export async function playVideo(query: string): Promise<string> {
  const video = await searchViaYouTubeApi(query);
  if (!video) {
    return braveFallbackSearch(query);
  }

  await openUrl(`https://www.youtube.com/watch?v=${video.videoId}&autoplay=1`);
  const who = video.channel ? ` by ${video.channel}` : "";
  return `Playing "${video.title}"${who} on YouTube. If your browser blocks autoplay on the first try, one click on the video starts it.`;
}

interface LikedVideoItem {
  snippet?: { title?: string; channelTitle?: string };
}

/** The YouTube Data API has no watch-history endpoint (Google deprecated it
 *  in 2016 for privacy reasons) — "liked" is the closest thing it actually
 *  exposes, via the authenticated user's own rating on videos.list. */
export async function getLikedVideos(maxResults = 10): Promise<string> {
  const token = await getAccessToken();
  const params = new URLSearchParams({
    part: "snippet",
    myRating: "like",
    maxResults: String(Math.min(maxResults, 50)),
  });
  const res = await fetch(`https://www.googleapis.com/youtube/v3/videos?${params.toString()}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    throw new Error(`YouTube liked-videos request failed (${res.status}): ${await res.text()}`);
  }
  const data = (await res.json()) as { items?: LikedVideoItem[] };
  const items = data.items ?? [];
  if (items.length === 0) return "No liked videos found.";

  return items
    .map((v, i) => `${i + 1}. ${v.snippet?.title ?? "(untitled)"} — ${v.snippet?.channelTitle ?? "unknown channel"}`)
    .join("\n");
}
