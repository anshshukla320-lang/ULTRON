import type Anthropic from "@anthropic-ai/sdk";
import * as actions from "./systemActions";
import * as gmail from "./gmailClient";
import { placeHealthReportCall } from "./callReport";
import * as spotify from "./spotifyClient";
import { playVideo, getLikedVideos } from "./youtubeClient";
import { getRecentWatchHistory } from "./youtubeHistory";
import { rememberFact, forgetFact } from "./memory";
import * as calendar from "./calendarClient";
import * as drive from "./driveClient";
import * as contacts from "./contactsClient";
import * as tasks from "./tasksClient";
import { listRecentPhotos } from "./photosClient";
import { getRecentLocationHistory } from "./locationHistory";
import { runCode } from "./codeRunner";
import { generatePalette } from "./colorPalette";
import { logExpense, expenseSummary, calculateLoan, convertCurrency } from "./financeTools";
import { logWorkout, logMeal, fitnessSummary, calculateBmi, calculateCalorieTarget } from "./fitnessTools";
import { analyzeWriting } from "./writingMetrics";
import { analyzeCsv } from "./dataAnalysis";
import { saveVocab, vocabQuiz, vocabResult, vocabSummary } from "./vocabTools";

export type ToolName =
  | "open_app"
  | "open_url"
  | "open_search"
  | "web_search"
  | "play_video"
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
  | "spotify_previous"
  | "remember"
  | "forget"
  | "youtube_liked_videos"
  | "youtube_watch_history"
  | "list_calendar_events"
  | "create_calendar_event"
  | "drive_search_files"
  | "drive_read_file"
  | "search_contacts"
  | "list_tasks"
  | "create_task"
  | "complete_task"
  | "list_recent_photos"
  | "location_history"
  | "run_code"
  | "generate_color_palette"
  | "analyze_csv"
  | "analyze_writing"
  | "calculate_loan"
  | "convert_currency"
  | "log_expense"
  | "expense_summary"
  | "log_workout"
  | "log_meal"
  | "fitness_summary"
  | "calculate_bmi"
  | "calculate_calorie_target"
  | "save_vocab"
  | "vocab_quiz"
  | "vocab_result"
  | "vocab_summary";

/** Tools in here run immediately. Anything not listed requires the user to
 *  click "Confirm" in the UI before it executes. */
export const AUTO_EXECUTE: ReadonlySet<ToolName> = new Set([
  "open_app",
  "open_url",
  "open_search",
  "web_search",
  "play_video",
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
  "remember",
  "forget",
  "youtube_liked_videos",
  "youtube_watch_history",
  "list_calendar_events",
  "create_calendar_event",
  "drive_search_files",
  "drive_read_file",
  "search_contacts",
  "list_tasks",
  "create_task",
  "complete_task",
  "list_recent_photos",
  "location_history",
  "generate_color_palette",
  "analyze_csv",
  "analyze_writing",
  "calculate_loan",
  "convert_currency",
  "log_expense",
  "expense_summary",
  "log_workout",
  "log_meal",
  "fitness_summary",
  "calculate_bmi",
  "calculate_calorie_target",
  "save_vocab",
  "vocab_quiz",
  "vocab_result",
  "vocab_summary",
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
    name: "play_video",
    description:
      "Find and open a specific YouTube video with autoplay requested, so the user doesn't have to search or click play themselves — a song, a trailer, a tutorial, highlights, anything on YouTube. Uses the YouTube Data API for accurate results. Use this instead of open_search whenever the user asks to 'play' or 'open and play' something.",
    input_schema: {
      type: "object",
      properties: { query: { type: "string", description: "What to find and play, e.g. a song/artist, a movie trailer, or a video topic" } },
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
      "Actually play music through Spotify (not just open the app) — searches for a song/artist/album and starts it playing on the user's active Spotify device via Spotify Connect. If no query is given, resumes whatever was paused. Opens the Spotify desktop app automatically if nothing is running yet. Requires Spotify to be connected and Premium; use play_video (YouTube) as a fallback if this errors.",
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
    name: "remember",
    description:
      "Save a short, genuinely useful fact or note to long-term memory so you can recall it in future conversations and phone calls — a preference the user states, a lasting detail about their setup, a durable fact worth carrying forward from a web search. Don't save trivial one-off command results or anything time-sensitive (like today's weather).",
    input_schema: {
      type: "object",
      properties: { fact: { type: "string", description: "The fact or note to remember, written concisely in your own words" } },
      required: ["fact"],
    },
  },
  {
    name: "forget",
    description: "Remove previously remembered facts matching a search term. Use when the user corrects something or says a remembered fact is wrong or outdated.",
    input_schema: {
      type: "object",
      properties: { query: { type: "string", description: "Text to match against remembered facts; every matching entry is removed" } },
      required: ["query"],
    },
  },
  {
    name: "youtube_liked_videos",
    description:
      "List the user's liked videos on YouTube (requires YouTube connected via /api/youtube/auth). This is the closest thing the YouTube API actually exposes to \"what have I watched\" — Google removed API access to real watch history in 2016.",
    input_schema: {
      type: "object",
      properties: { maxResults: { type: "number", description: "Max videos to return, default 10, max 50" } },
      required: [],
    },
  },
  {
    name: "youtube_watch_history",
    description:
      "Read the user's real YouTube watch history from a Google Takeout export (watch-history.json) if one has been placed in the agent's sandboxed workspace folder. There's no live API for this. If none is found, the tool explains how to export one.",
    input_schema: {
      type: "object",
      properties: { limit: { type: "number", description: "Max recent entries to return, default 10" } },
      required: [],
    },
  },
  {
    name: "list_calendar_events",
    description: "List the user's upcoming Google Calendar events, soonest first.",
    input_schema: {
      type: "object",
      properties: { maxResults: { type: "number", description: "Max events to return, default 10, max 50" } },
      required: [],
    },
  },
  {
    name: "create_calendar_event",
    description: "Create an event on the user's primary Google Calendar. No attendees/invites — a personal event only.",
    input_schema: {
      type: "object",
      properties: {
        summary: { type: "string", description: "Event title" },
        startISO: { type: "string", description: "Start time as an ISO 8601 datetime with timezone offset, e.g. 2025-06-01T14:00:00-07:00" },
        endISO: { type: "string", description: "End time, same format" },
        description: { type: "string", description: "Optional event notes" },
      },
      required: ["summary", "startISO", "endISO"],
    },
  },
  {
    name: "drive_search_files",
    description: "Search the user's Google Drive by filename.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Text to search for in file names" },
        maxResults: { type: "number", description: "Max files to return, default 10, max 50" },
      },
      required: ["query"],
    },
  },
  {
    name: "drive_read_file",
    description: "Read the text content of a Google Drive file by its id (from drive_search_files). Google Docs/Sheets/Slides are exported to plain text/CSV automatically; other file types are read directly if they're text, up to 100KB.",
    input_schema: {
      type: "object",
      properties: { fileId: { type: "string", description: "Drive file id" } },
      required: ["fileId"],
    },
  },
  {
    name: "search_contacts",
    description: "Search the user's Google Contacts by name, email, or phone number.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Text to search for" },
        maxResults: { type: "number", description: "Max contacts to return, default 10" },
      },
      required: ["query"],
    },
  },
  {
    name: "list_tasks",
    description: "List the user's open (incomplete) Google Tasks from their default task list.",
    input_schema: {
      type: "object",
      properties: { maxResults: { type: "number", description: "Max tasks to return, default 20, max 100" } },
      required: [],
    },
  },
  {
    name: "create_task",
    description: "Add a task to the user's default Google Tasks list.",
    input_schema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Task title" },
        notes: { type: "string", description: "Optional task notes" },
        due: { type: "string", description: "Optional due date, RFC 3339 date, e.g. 2025-06-01T00:00:00.000Z" },
      },
      required: ["title"],
    },
  },
  {
    name: "complete_task",
    description: "Mark a Google Task as completed by its id (from list_tasks).",
    input_schema: {
      type: "object",
      properties: { taskId: { type: "string", description: "Task id" } },
      required: ["taskId"],
    },
  },
  {
    name: "list_recent_photos",
    description:
      "List recent Google Photos media items. Since March 2025 Google restricts third-party apps to only photos the app itself uploaded, so this will almost always come back empty — that's a platform-wide restriction on every third-party app, not something specific to ULTRON. Tell the user this plainly rather than implying their library is empty.",
    input_schema: {
      type: "object",
      properties: { maxResults: { type: "number", description: "Max items to return, default 10" } },
      required: [],
    },
  },
  {
    name: "location_history",
    description:
      "Read the user's Google Maps location/Timeline history from a Google Takeout export placed in the agent's sandboxed workspace folder. There is no live API for this at all — Google removed third-party access entirely and moved Timeline to on-device-only storage in late 2024. If no export is found, the tool explains how (or whether) one can still be obtained.",
    input_schema: {
      type: "object",
      properties: { limit: { type: "number", description: "Max recent places to return, default 10" } },
      required: [],
    },
  },
  {
    name: "run_code",
    description:
      "Run a short Node.js, Python, or PowerShell script with its working directory set to the agent's sandboxed workspace folder. This is NOT a real sandbox — the code runs with the same permissions as the user's own account, only the working directory is scoped — so it always requires the user's explicit confirmation before it runs. Times out after 15 seconds. Use for coding tasks: testing a snippet, running a script the user asked for, checking output.",
    input_schema: {
      type: "object",
      properties: {
        language: { type: "string", description: "One of: node, python, powershell" },
        code: { type: "string", description: "The code to run" },
      },
      required: ["language", "code"],
    },
  },
  {
    name: "generate_color_palette",
    description:
      "Generate a real color-theory-based palette from a base hex color — complementary, analogous, triadic, or monochromatic — each hue returned as light/base/dark variants ready to use. Pure computation, no image generation involved. Use this whenever a design task calls for concrete color suggestions rather than vague advice.",
    input_schema: {
      type: "object",
      properties: {
        baseColor: { type: "string", description: "A 6-digit hex color, e.g. #3366FF" },
        scheme: { type: "string", description: "One of: complementary, analogous, triadic, monochromatic" },
      },
      required: ["baseColor", "scheme"],
    },
  },
  {
    name: "analyze_csv",
    description: "Analyze a CSV file in the agent's sandboxed workspace folder — row/column count, and per-column stats (min/max/mean/median for numeric columns, distinct-value count for text columns).",
    input_schema: {
      type: "object",
      properties: { path: { type: "string", description: "Relative path to the CSV file in the workspace" } },
      required: ["path"],
    },
  },
  {
    name: "analyze_writing",
    description: "Score a piece of writing objectively — word/sentence counts, Flesch reading-ease score, rough passive-voice count, longest sentence. Use this to ground a writing critique in real numbers before giving qualitative feedback.",
    input_schema: {
      type: "object",
      properties: { text: { type: "string", description: "The text to analyze" } },
      required: ["text"],
    },
  },
  {
    name: "calculate_loan",
    description: "Calculate monthly payment and total interest for a loan given principal, annual interest rate, and term in years. Pure math, no bank involved.",
    input_schema: {
      type: "object",
      properties: {
        principal: { type: "number", description: "Loan amount" },
        annualRatePct: { type: "number", description: "Annual interest rate as a percent, e.g. 6.5" },
        years: { type: "number", description: "Loan term in years" },
      },
      required: ["principal", "annualRatePct", "years"],
    },
  },
  {
    name: "convert_currency",
    description: "Convert an amount between currencies using live exchange rates.",
    input_schema: {
      type: "object",
      properties: {
        amount: { type: "number", description: "Amount to convert" },
        from: { type: "string", description: "Source currency code, e.g. USD" },
        to: { type: "string", description: "Target currency code, e.g. EUR" },
      },
      required: ["amount", "from", "to"],
    },
  },
  {
    name: "log_expense",
    description: "Log a personal expense to a local ledger for later summary. No bank connection — this is manual tracking only.",
    input_schema: {
      type: "object",
      properties: {
        amount: { type: "number", description: "Amount spent" },
        category: { type: "string", description: "Category, e.g. groceries, rent, entertainment" },
        note: { type: "string", description: "Optional note" },
      },
      required: ["amount", "category"],
    },
  },
  {
    name: "expense_summary",
    description: "Summarize logged expenses by category over a recent period.",
    input_schema: {
      type: "object",
      properties: { days: { type: "number", description: "Number of recent days to summarize, default 30" } },
      required: [],
    },
  },
  {
    name: "log_workout",
    description: "Log a workout to a local fitness log.",
    input_schema: {
      type: "object",
      properties: {
        description: { type: "string", description: "What the workout was, e.g. '5k run' or 'upper body strength'" },
        durationMin: { type: "number", description: "Duration in minutes" },
        notes: { type: "string", description: "Optional notes" },
      },
      required: ["description"],
    },
  },
  {
    name: "log_meal",
    description: "Log a meal to a local nutrition log.",
    input_schema: {
      type: "object",
      properties: {
        description: { type: "string", description: "What was eaten" },
        calories: { type: "number", description: "Estimated calories" },
        notes: { type: "string", description: "Optional notes" },
      },
      required: ["description"],
    },
  },
  {
    name: "fitness_summary",
    description: "Summarize logged workouts and meals over a recent period.",
    input_schema: {
      type: "object",
      properties: { days: { type: "number", description: "Number of recent days to summarize, default 7" } },
      required: [],
    },
  },
  {
    name: "calculate_bmi",
    description: "Calculate BMI from height and weight. General estimate, not medical advice.",
    input_schema: {
      type: "object",
      properties: {
        heightCm: { type: "number", description: "Height in centimeters" },
        weightKg: { type: "number", description: "Weight in kilograms" },
      },
      required: ["heightCm", "weightKg"],
    },
  },
  {
    name: "calculate_calorie_target",
    description: "Estimate BMR and maintenance calories using the Mifflin-St Jeor equation. General estimate, not medical advice.",
    input_schema: {
      type: "object",
      properties: {
        sex: { type: "string", description: "'male' or 'female'" },
        ageYears: { type: "number" },
        heightCm: { type: "number" },
        weightKg: { type: "number" },
        activityLevel: { type: "string", description: "One of: sedentary, light, moderate, active, very active" },
      },
      required: ["sex", "ageYears", "heightCm", "weightKg", "activityLevel"],
    },
  },
  {
    name: "save_vocab",
    description: "Save a word or phrase to the user's local vocabulary deck for spaced-repetition review. Saving an existing word updates its translation.",
    input_schema: {
      type: "object",
      properties: {
        word: { type: "string", description: "The word or phrase in the language being learned" },
        translation: { type: "string", description: "Its meaning in the user's language" },
        language: { type: "string", description: "Language being learned, e.g. Spanish, Japanese" },
        example: { type: "string", description: "Optional short example sentence using the word" },
      },
      required: ["word", "translation", "language"],
    },
  },
  {
    name: "vocab_quiz",
    description: "Get the vocabulary words that are due for review (spaced repetition). Returns answers for grading — quiz the user one word at a time without revealing the answer first.",
    input_schema: {
      type: "object",
      properties: {
        language: { type: "string", description: "Optional: only quiz this language" },
        count: { type: "number", description: "Max words to review, default 5" },
      },
      required: [],
    },
  },
  {
    name: "vocab_result",
    description: "Record whether the user recalled a vocabulary word correctly during a quiz. Moves it up a review box if correct, back to box 1 if missed.",
    input_schema: {
      type: "object",
      properties: {
        word: { type: "string" },
        language: { type: "string" },
        correct: { type: "boolean" },
      },
      required: ["word", "language", "correct"],
    },
  },
  {
    name: "vocab_summary",
    description: "Summarize the vocabulary deck per language — total words, due now, mastered, and recall accuracy.",
    input_schema: {
      type: "object",
      properties: { language: { type: "string", description: "Optional: only this language" } },
      required: [],
    },
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
    case "play_video":
      return playVideo(String(input.query ?? ""));
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
    case "remember":
      return rememberFact(String(input.fact ?? ""));
    case "forget":
      return forgetFact(String(input.query ?? ""));
    case "youtube_liked_videos":
      return getLikedVideos(input.maxResults ? Number(input.maxResults) : 10);
    case "youtube_watch_history":
      return getRecentWatchHistory(input.limit ? Number(input.limit) : 10);
    case "list_calendar_events":
      return calendar.listUpcomingEvents(input.maxResults ? Number(input.maxResults) : 10);
    case "create_calendar_event":
      return calendar.createEvent(
        String(input.summary ?? ""),
        String(input.startISO ?? ""),
        String(input.endISO ?? ""),
        input.description ? String(input.description) : undefined,
      );
    case "drive_search_files":
      return drive.searchFiles(String(input.query ?? ""), input.maxResults ? Number(input.maxResults) : 10);
    case "drive_read_file":
      return drive.readFile(String(input.fileId ?? ""));
    case "search_contacts":
      return contacts.searchContacts(String(input.query ?? ""), input.maxResults ? Number(input.maxResults) : 10);
    case "list_tasks":
      return tasks.listTasks(input.maxResults ? Number(input.maxResults) : 20);
    case "create_task":
      return tasks.createTask(String(input.title ?? ""), input.notes ? String(input.notes) : undefined, input.due ? String(input.due) : undefined);
    case "complete_task":
      return tasks.completeTask(String(input.taskId ?? ""));
    case "list_recent_photos":
      return listRecentPhotos(input.maxResults ? Number(input.maxResults) : 10);
    case "location_history":
      return getRecentLocationHistory(input.limit ? Number(input.limit) : 10);
    case "run_code":
      return runCode(String(input.language ?? ""), String(input.code ?? ""));
    case "generate_color_palette":
      return generatePalette(String(input.baseColor ?? ""), String(input.scheme ?? ""));
    case "analyze_csv":
      return analyzeCsv(String(input.path ?? ""));
    case "analyze_writing":
      return analyzeWriting(String(input.text ?? ""));
    case "calculate_loan":
      return calculateLoan(Number(input.principal ?? 0), Number(input.annualRatePct ?? 0), Number(input.years ?? 0));
    case "convert_currency":
      return convertCurrency(Number(input.amount ?? 0), String(input.from ?? ""), String(input.to ?? ""));
    case "log_expense":
      return logExpense(Number(input.amount ?? 0), String(input.category ?? ""), input.note ? String(input.note) : undefined);
    case "expense_summary":
      return expenseSummary(input.days ? Number(input.days) : 30);
    case "log_workout":
      return logWorkout(
        String(input.description ?? ""),
        input.durationMin ? Number(input.durationMin) : undefined,
        input.notes ? String(input.notes) : undefined,
      );
    case "log_meal":
      return logMeal(
        String(input.description ?? ""),
        input.calories ? Number(input.calories) : undefined,
        input.notes ? String(input.notes) : undefined,
      );
    case "fitness_summary":
      return fitnessSummary(input.days ? Number(input.days) : 7);
    case "calculate_bmi":
      return calculateBmi(Number(input.heightCm ?? 0), Number(input.weightKg ?? 0));
    case "calculate_calorie_target":
      return calculateCalorieTarget(
        input.sex === "female" ? "female" : "male",
        Number(input.ageYears ?? 0),
        Number(input.heightCm ?? 0),
        Number(input.weightKg ?? 0),
        String(input.activityLevel ?? "light"),
      );
    case "save_vocab":
      return saveVocab(
        String(input.word ?? ""),
        String(input.translation ?? ""),
        String(input.language ?? ""),
        input.example ? String(input.example) : undefined,
      );
    case "vocab_quiz":
      return vocabQuiz(input.language ? String(input.language) : undefined, input.count ? Number(input.count) : 5);
    case "vocab_result":
      return vocabResult(String(input.word ?? ""), String(input.language ?? ""), input.correct === true);
    case "vocab_summary":
      return vocabSummary(input.language ? String(input.language) : undefined);
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
