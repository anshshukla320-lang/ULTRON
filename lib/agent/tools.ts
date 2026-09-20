import type Anthropic from "@anthropic-ai/sdk";
import * as actions from "./systemActions";
import * as gmail from "./gmailClient";
import { placeHealthReportCall } from "./callReport";
import * as spotify from "./spotifyClient";

export type ToolName =
  | "open_app"
  | "open_url"
  | "open_search"
  | "web_search"
  | "play_music"
  | "list_files"
  | "read_file"
  | "write_file"
  | "search_files"
  | "get_system_info"
  | "search_app"
  | "install_app"
  | "list_emails"
  | "read_email"
  | "send_email"
  | "call_health_report"
  | "spotify_play"
  | "spotify_pause"
  | "spotify_next"
  | "spotify_previous";

/** Tools in here run immediately. Anything not listed requires the user to
 *  click "Confirm" in the UI before it executes. */
export const AUTO_EXECUTE: ReadonlySet<ToolName> = new Set([
  "open_app",
  "open_url",
  "open_search",
  "web_search",
  "play_music",
  "list_files",
  "read_file",
  "search_files",
  "get_system_info",
  "search_app",
  "list_emails",
  "read_email",
  "spotify_play",
  "spotify_pause",
  "spotify_next",
  "spotify_previous",
]);

export const TOOLS: Anthropic.Tool[] = [
  {
    name: "open_app",
    description:
      "Launch an application already installed on this Windows PC (e.g. Notepad, Calculator, Chrome, VS Code, Spotify). Matches against the Start Menu, so use the app's common name.",
    input_schema: {
      type: "object",
      properties: { name: { type: "string", description: "Name of the application, e.g. 'notepad' or 'spotify'" } },
      required: ["name"],
    },
  },
  {
    name: "open_url",
    description: "Open a web page in the user's default browser.",
    input_schema: {
      type: "object",
      properties: { url: { type: "string", description: "Full http(s) URL to open" } },
      required: ["url"],
    },
  },
  {
    name: "open_search",
    description:
      "Open a real search-results page in the user's browser, e.g. searching Google, YouTube, Amazon, Wikipedia, Bing, or DuckDuckGo. Use this when the user wants to see/browse results themselves, as opposed to you reading and answering from the results (use web_search for that).",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "What to search for" },
        site: {
          type: "string",
          description: "One of: google, bing, duckduckgo, youtube, amazon, wikipedia. Defaults to google.",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "web_search",
    description:
      "Search the live web and get back the top results (title, snippet, URL) to read yourself and answer the user's question with — without opening a browser tab. Use this for current events, facts you don't know, or anything time-sensitive.",
    input_schema: {
      type: "object",
      properties: { query: { type: "string", description: "Search query" } },
      required: ["query"],
    },
  },
  {
    name: "play_music",
    description:
      "Play a song, artist, or piece of music. Finds the actual video on YouTube and opens it with autoplay requested, so the user doesn't have to click play themselves. Use this instead of open_search whenever the user asks to 'play' something.",
    input_schema: {
      type: "object",
      properties: { query: { type: "string", description: "Song and/or artist name to play" } },
      required: ["query"],
    },
  },
  {
    name: "list_files",
    description:
      "List files/folders inside the agent's sandboxed workspace folder (~/ULTRON-Agent-Files). Path is relative to that folder; use '.' for the root.",
    input_schema: {
      type: "object",
      properties: { path: { type: "string", description: "Relative path, default '.'" } },
      required: [],
    },
  },
  {
    name: "read_file",
    description: "Read a text file from the agent's sandboxed workspace folder.",
    input_schema: {
      type: "object",
      properties: { path: { type: "string", description: "Relative path to the file" } },
      required: ["path"],
    },
  },
  {
    name: "write_file",
    description:
      "Create or overwrite a text file inside the agent's sandboxed workspace folder. This is a destructive/persistent action, so it always requires the user's explicit confirmation before it runs.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Relative path to the file" },
        content: { type: "string", description: "Full text content to write" },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "search_files",
    description: "Search filenames (recursively) inside the agent's sandboxed workspace folder.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Substring to search for in filenames" },
        path: { type: "string", description: "Relative path to search under, default '.'" },
      },
      required: ["query"],
    },
  },
  {
    name: "get_system_info",
    description: "Get basic info about this PC: time, uptime, free memory, hostname.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "search_app",
    description:
      "Search winget (Windows's official curated package manager) for an installable application. Returns candidate package IDs from verified publishers. Always call this before install_app to find the exact package id.",
    input_schema: {
      type: "object",
      properties: { query: { type: "string", description: "App name to search for, e.g. 'vs code' or 'spotify'" } },
      required: ["query"],
    },
  },
  {
    name: "install_app",
    description:
      "Install an application via winget using its exact package id (from search_app). This installs real software on the user's PC, so it always requires the user's explicit confirmation before it runs.",
    input_schema: {
      type: "object",
      properties: { id: { type: "string", description: "Exact winget package id, e.g. 'Microsoft.VisualStudioCode'" } },
      required: ["id"],
    },
  },
  {
    name: "list_emails",
    description:
      "List recent Gmail messages (sender, subject, date, snippet). Use Gmail search syntax for the query, e.g. 'is:unread', 'from:someone@example.com'. Requires Gmail to already be connected — if it errors, tell the user to visit /api/gmail/auth.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Gmail search query, default '' (inbox, most recent)" },
        maxResults: { type: "number", description: "Max emails to return, default 8, max 15" },
      },
      required: [],
    },
  },
  {
    name: "read_email",
    description: "Read the full body of one Gmail message by its id (from list_emails output).",
    input_schema: {
      type: "object",
      properties: { id: { type: "string", description: "Gmail message id" } },
      required: ["id"],
    },
  },
  {
    name: "send_email",
    description:
      "Send an email from the user's Gmail account. This is externally visible and irreversible, so it always requires the user's explicit confirmation before it runs.",
    input_schema: {
      type: "object",
      properties: {
        to: { type: "string", description: "Recipient email address" },
        subject: { type: "string", description: "Email subject" },
        body: { type: "string", description: "Plain-text email body" },
      },
      required: ["to", "subject", "body"],
    },
  },
  {
    name: "spotify_play",
    description:
      "Actually play music through Spotify (not just open the app) — searches for a song/artist/album and starts it playing on the user's active Spotify device via Spotify Connect. If no query is given, resumes whatever was paused. Opens the Spotify desktop app automatically if nothing is running yet. Requires Spotify to be connected and Premium; use play_music (YouTube) as a fallback if this errors.",
    input_schema: {
      type: "object",
      properties: { query: { type: "string", description: "Song, artist, and/or album to search for and play. Omit to resume paused playback." } },
      required: [],
    },
  },
  {
    name: "spotify_pause",
    description: "Pause the current Spotify playback on the user's active device.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "spotify_next",
    description: "Skip to the next track in Spotify.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "spotify_previous",
    description: "Go back to the previous track in Spotify.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "call_health_report",
    description:
      "Place a real phone call (via Twilio) to the user's phone number and read out a spoken summary of this PC's health — disk space, memory, CPU load, and recent system errors — plus any important unread Gmail messages. Requires TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER, and USER_PHONE_NUMBER to be set in .env.local. This places a real, billed phone call, so it always requires the user's explicit confirmation before it runs.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
];

export async function executeTool(name: ToolName, input: Record<string, unknown>): Promise<string> {
  switch (name) {
    case "open_app":
      return actions.openApp(String(input.name ?? ""));
    case "open_url":
      return actions.openUrl(String(input.url ?? ""));
    case "open_search":
      return actions.openSearch(String(input.query ?? ""), input.site ? String(input.site) : "google");
    case "web_search":
      return actions.webSearch(String(input.query ?? ""));
    case "play_music":
      return actions.playMusic(String(input.query ?? ""));
    case "list_files":
      return actions.listFiles(input.path ? String(input.path) : ".");
    case "read_file":
      return actions.readFile(String(input.path ?? ""));
    case "write_file":
      return actions.writeFile(String(input.path ?? ""), String(input.content ?? ""));
    case "search_files":
      return actions.searchFiles(String(input.query ?? ""), input.path ? String(input.path) : ".");
    case "get_system_info":
      return actions.getSystemInfo();
    case "search_app":
      return actions.searchApp(String(input.query ?? ""));
    case "install_app":
      return actions.installApp(String(input.id ?? ""));
    case "list_emails":
      return gmail.listEmails(input.query ? String(input.query) : "", input.maxResults ? Number(input.maxResults) : 8);
    case "read_email":
      return gmail.readEmail(String(input.id ?? ""));
    case "send_email":
      return gmail.sendEmail(String(input.to ?? ""), String(input.subject ?? ""), String(input.body ?? ""));
    case "call_health_report":
      return placeHealthReportCall();
    case "spotify_play":
      return spotify.playTrack(input.query ? String(input.query) : undefined);
    case "spotify_pause":
      return spotify.pausePlayback();
    case "spotify_next":
      return spotify.nextTrack();
    case "spotify_previous":
      return spotify.previousTrack();
    default:
      throw new Error(`Unknown tool "${name}"`);
  }
}
