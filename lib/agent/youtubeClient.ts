import { openUrl, playMusic as braveFallbackSearch } from "./systemActions";

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
