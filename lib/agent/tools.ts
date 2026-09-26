import Anthropic from "@anthropic-ai/sdk";
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
import { setTimer, setReminder, listReminders, cancelReminder, setDailyBriefing } from "./reminders";
import { morningBriefing } from "./briefing";
import { searchEpisodes } from "./episodes";
import { setProactive } from "./proactive";
import { usageReport } from "./usage";
import { searchDocuments, readDocument } from "./documents";
import { sendWhatsApp } from "./whatsapp";
import { listSmartHome, controlSmartHome, controlSmartHomeSecurity } from "./smartHome";
import { controlTv } from "./androidTv";
import { irControl } from "./tuyaIr";
import { saveRoutine, runRoutine, runRoutineSteps, listRoutines, deleteRoutine, findRoutine, routineNeedsConfirmation, type RoutineStep, type ToolPolicy } from "./routines";
import { startFocus, stopFocus, focusStatus } from "./focus";
import { screenTimeReport } from "./screenTime";
import { getNews, getStockPrices, getCricketScores } from "./liveInfo";
import { checkBills } from "./bills";
import { readClipboard, writeClipboard } from "./clipboard";
import { listEnglishVoices } from "./piperTts";
import { updateSettings } from "./settings";
import { operateComputer } from "./computerUse";
import { getSettings } from "./settings";
import { getWeather } from "./weather";
import { lookAtScreen } from "./screen";
import { setVolume, mediaControl, lockPc, setBrightness, powerAction, cancelShutdown } from "./pcControls";
import { scanDiskJunk, cleanDiskJunk, CLEANUP_CATEGORIES } from "./diskCleanup";

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
  | "vocab_summary"
  | "set_timer"
  | "set_reminder"
  | "list_reminders"
  | "cancel_reminder"
  | "set_daily_briefing"
  | "morning_briefing"
  | "get_weather"
  | "look_at_screen"
  | "set_volume"
  | "media_control"
  | "lock_pc"
  | "set_brightness"
  | "power_action"
  | "cancel_shutdown"
  | "scan_disk_junk"
  | "clean_disk_junk"
  | "recall_conversations"
  | "set_proactive"
  | "usage_report"
  | "search_documents"
  | "read_document"
  | "send_whatsapp"
  | "smart_home_devices"
  | "smart_home_control"
  | "smart_home_security"
  | "tv_control"
  | "ir_remote"
  | "save_routine"
  | "run_routine"
  | "list_routines"
  | "delete_routine"
  | "start_focus"
  | "stop_focus"
  | "focus_status"
  | "screen_time_report"
  | "get_news"
  | "get_stock_price"
  | "cricket_scores"
  | "check_bills"
  | "read_clipboard"
  | "write_clipboard"
  | "set_voice"
  | "operate_computer";

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
  "set_timer",
  "set_reminder",
  "list_reminders",
  "cancel_reminder",
  "set_daily_briefing",
  "morning_briefing",
  "get_weather",
  "look_at_screen",
  "set_volume",
  "media_control",
  "lock_pc",
  "set_brightness",
  "cancel_shutdown",
  "scan_disk_junk",
  "recall_conversations",
  "set_proactive",
  "usage_report",
  "search_documents",
  "read_document",
  "smart_home_devices",
  "smart_home_control",
  "tv_control",
  "ir_remote",
  "save_routine",
  "run_routine", // unless a step needs confirming — see needsConfirmation()
  "list_routines",
  "delete_routine",
  "start_focus",
  "stop_focus",
  "focus_status",
  "screen_time_report",
  "get_news",
  "get_stock_price",
  "cricket_scores",
  "check_bills",
  "read_clipboard",
  "write_clipboard",
  "set_voice",
  // send_whatsapp and smart_home_security need confirmation too.
  // power_action and clean_disk_junk deliberately need confirmation.
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
    name: "set_timer",
    description: "Start a countdown timer. ULTRON announces it out loud when it finishes (the ULTRON page must be open).",
    input_schema: {
      type: "object",
      properties: {
        duration_seconds: { type: "number", description: "Timer length in seconds, e.g. 300 for 5 minutes" },
        label: { type: "string", description: "Optional name, e.g. 'pasta' (announced as 'your pasta timer is done')" },
      },
      required: ["duration_seconds"],
    },
  },
  {
    name: "set_reminder",
    description: "Remind the user about something at a specific time or after a delay. Give exactly one of `at` or `in_minutes`. Use the current local time from the system prompt to work out `at`.",
    input_schema: {
      type: "object",
      properties: {
        text: { type: "string", description: "What to remind them about, phrased to be read back, e.g. 'call your mother'" },
        at: { type: "string", description: "Local date-time, e.g. 2026-09-25T17:30" },
        in_minutes: { type: "number", description: "Minutes from now" },
      },
      required: ["text"],
    },
  },
  {
    name: "list_reminders",
    description: "List active timers and reminders (with ids) and the daily briefing time.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "cancel_reminder",
    description: "Cancel timers/reminders by id, by words in their text, by kind ('timer'), or 'all'.",
    input_schema: {
      type: "object",
      properties: { query: { type: "string", description: "An id from list_reminders, text to match, 'timer', or 'all'" } },
      required: ["query"],
    },
  },
  {
    name: "set_daily_briefing",
    description: "Schedule the morning briefing to play automatically every day at a time, or turn it off.",
    input_schema: {
      type: "object",
      properties: { time: { type: "string", description: "24-hour local time like 07:30, or 'off'" } },
      required: ["time"],
    },
  },
  {
    name: "morning_briefing",
    description: "Gather a morning briefing in one call: weather, the rest of today's calendar, important unread email, open tasks, and reminders. Summarize it in a few spoken sentences — don't read it out verbatim.",
    input_schema: {
      type: "object",
      properties: { location: { type: "string", description: "City for the weather, if not the user's home location" } },
      required: [],
    },
  },
  {
    name: "get_weather",
    description: "Current weather plus today's and tomorrow's forecast for a place (live, Open-Meteo). Omit location to use the user's home location.",
    input_schema: {
      type: "object",
      properties: { location: { type: "string", description: "City name, optionally with region/country, e.g. 'Pune, India'" } },
      required: [],
    },
  },
  {
    name: "look_at_screen",
    description: "Take a screenshot of the user's screen and look at it. Only use when the user asks about something on their screen ('what's this error', 'summarize this page').",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "set_volume",
    description: "Change the PC's volume using the media keys. 'set' goes to an exact level; mute is a toggle.",
    input_schema: {
      type: "object",
      properties: {
        action: { type: "string", description: "One of: up, down, set, toggle_mute" },
        amount: { type: "number", description: "Percent to change by (up/down, default 10) or the level to set (0-100)" },
      },
      required: ["action"],
    },
  },
  {
    name: "media_control",
    description: "Control whatever media is playing (any app, not just Spotify) with the media keys.",
    input_schema: {
      type: "object",
      properties: { action: { type: "string", description: "One of: play_pause, next, previous, stop" } },
      required: ["action"],
    },
  },
  {
    name: "lock_pc",
    description: "Lock the PC (same as Windows+L).",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "set_brightness",
    description: "Set screen brightness (laptop screens only; external monitors don't support it).",
    input_schema: {
      type: "object",
      properties: { level: { type: "number", description: "0-100" } },
      required: ["level"],
    },
  },
  {
    name: "power_action",
    description: "Put the PC to sleep, or shut down / restart it. Shutdown and restart wait 60 seconds so they can be cancelled.",
    input_schema: {
      type: "object",
      properties: { action: { type: "string", description: "One of: sleep, shutdown, restart" } },
      required: ["action"],
    },
  },
  {
    name: "cancel_shutdown",
    description: "Cancel a shutdown or restart that's counting down.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "scan_disk_junk",
    description: "Measure how much space safe-to-delete junk is using (temp files, browser caches, thumbnail cache, npm cache, Recycle Bin). Deletes nothing.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "clean_disk_junk",
    description: `Delete junk found by scan_disk_junk. Never touches Downloads or personal files. Categories: ${CLEANUP_CATEGORIES.join(", ")}.`,
    input_schema: {
      type: "object",
      properties: {
        categories: { type: "array", items: { type: "string" }, description: "Which categories to clean" },
      },
      required: ["categories"],
    },
  },
  {
    name: "recall_conversations",
    description: "Search summaries of past conversations with the user (beyond the few recent ones already in your instructions). Use when they refer back to something ('what did we decide about…', 'that thing I mentioned last week').",
    input_schema: {
      type: "object",
      properties: { query: { type: "string", description: "Keywords to look for" } },
      required: ["query"],
    },
  },
  {
    name: "set_proactive",
    description: "Turn ULTRON's unprompted notices (meeting starting soon, important email, low disk, rain soon) on or off, or change the quiet hours when it never speaks up.",
    input_schema: {
      type: "object",
      properties: {
        enabled: { type: "boolean" },
        quiet_hours: { type: "string", description: "Like 22:00-07:00, or 'off' for no quiet hours" },
      },
      required: [],
    },
  },
  {
    name: "usage_report",
    description: "How much ULTRON has spent on the Claude API today and over the last 30 days, broken down by feature.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "search_documents",
    description: "Search the user's documents (PDF, Word, text) in the ULTRON workspace and any folders they've allowed, and return the most relevant passages with file names. Use before answering questions about their own papers, contracts, notes, etc.",
    input_schema: {
      type: "object",
      properties: { query: { type: "string", description: "What to look for, in plain words" } },
      required: ["query"],
    },
  },
  {
    name: "read_document",
    description: "Read a whole document (PDFs are shown to you as the real document, including tables and scans). Use a path returned by search_documents or list_files.",
    input_schema: {
      type: "object",
      properties: { path: { type: "string", description: "Path relative to the workspace, or an absolute path inside an allowed folder" } },
      required: ["path"],
    },
  },
  {
    name: "send_whatsapp",
    description: "Send a WhatsApp message through the WhatsApp desktop app. `to` is a contact name (looked up in Google Contacts) or a phone number. Always read the exact message back in your reply before this runs.",
    input_schema: {
      type: "object",
      properties: {
        to: { type: "string", description: "Contact name or phone number" },
        message: { type: "string", description: "Exact text to send" },
      },
      required: ["to", "message"],
    },
  },
  {
    name: "smart_home_devices",
    description: "List the user's smart-home devices — Smart Life / Tuya bulbs, plugs and switches, and Home Assistant entities — with their current state and ids. Call it before controlling a device whose id you don't know.",
    input_schema: {
      type: "object",
      properties: { query: { type: "string", description: "Optional words to filter by, e.g. 'bedroom' or 'light'" } },
      required: [],
    },
  },
  {
    name: "smart_home_control",
    description: "Control an everyday smart-home device (light, plug, switch, fan, climate, blinds, scene): on, off, toggle, or set with brightness / color / warmth for lights, speed for fans, set_temperature for climate, open/close/stop for blinds. A plug with a fan or lamp on it is switched with on/off. Not for locks, alarms or garage/doors (use smart_home_security), nor the TV (use tv_control).",
    input_schema: {
      type: "object",
      properties: {
        entity_id: { type: "string", description: "Device id from smart_home_devices (tuya:… or light.bedroom), or the device's name" },
        action: { type: "string", description: "on, off, toggle, set, open, close, stop, play, pause, set_temperature" },
        brightness: { type: "number", description: "Lights: 0-100" },
        color: { type: "string", description: "Lights: a colour name (red, blue, purple…) or #rrggbb" },
        warmth: { type: "number", description: "White lights: 0 = warm yellow, 100 = cool daylight" },
        speed: { type: "number", description: "Fans: 0-100" },
        channel: { type: "number", description: "Multi-switch boards: which switch (1, 2, 3…)" },
        temperature: { type: "number", description: "Climate only, with set_temperature" },
      },
      required: ["entity_id", "action"],
    },
  },
  {
    name: "smart_home_security",
    description: "Lock/unlock a door, arm/disarm an alarm, or open/close a garage or door. Always needs the user's confirmation.",
    input_schema: {
      type: "object",
      properties: {
        entity_id: { type: "string" },
        action: { type: "string", description: "lock, unlock, arm, disarm, open, close" },
      },
      required: ["entity_id", "action"],
    },
  },
  {
    name: "tv_control",
    description:
      "Control the user's Android / Google TV over Wi-Fi: power_on, power_off, status, volume_up / volume_down (with steps), mute, play_pause, next, previous, home, back, up/down/left/right/ok (with steps), open_app (e.g. YouTube, Netflix, Prime Video, Hotstar), youtube_search (opens YouTube with a query), type_text (into a focused search box).",
    input_schema: {
      type: "object",
      properties: {
        action: { type: "string" },
        steps: { type: "number", description: "How many presses for volume or arrow keys" },
        app: { type: "string", description: "For open_app" },
        query: { type: "string", description: "For youtube_search" },
        text: { type: "string", description: "For type_text" },
      },
      required: ["action"],
    },
  },
  {
    name: "ir_remote",
    description:
      "Press a button on a remote the user added to their Smart Life IR blaster (fan, TV, set-top box, speaker…), or set an IR air conditioner. For AC: temperature (16-30), mode (cool/heat/auto/fan/dry), fan_speed (auto/low/medium/high), or key 'off'. For other remotes: key like on, off, power, speed up, speed down, swing, timer, volume up, mute. IR can't read a device's state — power usually toggles.",
    input_schema: {
      type: "object",
      properties: {
        remote: { type: "string", description: "Remote name or ir:<id> from smart_home_devices, e.g. 'Bedroom AC'" },
        key: { type: "string" },
        temperature: { type: "number" },
        mode: { type: "string" },
        fan_speed: { type: "string" },
      },
      required: ["remote"],
    },
  },
  {
    name: "save_routine",
    description:
      "Create or replace a routine: a named list of tool calls that run together when the user says its name (e.g. 'good night': lights off, TV off, PC to sleep; 'movie mode': dim lights, TV on, open Netflix). Optionally on a schedule (then every step must be one that runs without confirmation). Use the real device names/ids from smart_home_devices. Read the steps back to the user in a sentence.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "What the user will say, e.g. 'good night'" },
        steps: {
          type: "array",
          items: {
            type: "object",
            properties: { tool: { type: "string" }, input: { type: "object" } },
            required: ["tool", "input"],
          },
        },
        schedule: {
          type: "object",
          description: "Optional. at: '23:30', '7:15 am', 'sunset', 'sunrise', or 'sunset-30'; days: ['mon','tue',…] or ['weekdays'] / ['weekends'] (omit for every day).",
          properties: { at: { type: "string" }, days: { type: "array", items: { type: "string" } } },
          required: ["at"],
        },
        announce: { type: "boolean", description: "Scheduled runs: say/notify when it runs (default false — quiet)." },
      },
      required: ["name", "steps"],
    },
  },
  {
    name: "run_routine",
    description: "Run a saved routine by name. Asks the user first only if one of its steps needs confirmation.",
    input_schema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
  },
  {
    name: "list_routines",
    description: "List the saved routines, their steps and schedules.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "delete_routine",
    description: "Delete a saved routine.",
    input_schema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
  },
  {
    name: "start_focus",
    description: "Start focus mode (Pomodoro): focus rounds with breaks, announced at each switch, and a nudge when YouTube / social media / games come to the front during a round.",
    input_schema: {
      type: "object",
      properties: {
        minutes: { type: "number", description: "Focus round length, default 25" },
        break_minutes: { type: "number", description: "Break length, default 5" },
        rounds: { type: "number", description: "How many rounds, default 1" },
        task: { type: "string", description: "What they're working on, if they said" },
      },
      required: [],
    },
  },
  { name: "stop_focus", description: "End focus mode early.", input_schema: { type: "object", properties: {}, required: [] } },
  { name: "focus_status", description: "How much of the current focus round or break is left.", input_schema: { type: "object", properties: {}, required: [] } },
  {
    name: "screen_time_report",
    description: "How long the user spent in each app/site on the PC.",
    input_schema: { type: "object", properties: { period: { type: "string", enum: ["today", "yesterday", "week"] } }, required: [] },
  },
  {
    name: "get_news",
    description: "Latest news headlines (India by default), optionally about a topic.",
    input_schema: { type: "object", properties: { topic: { type: "string" } }, required: [] },
  },
  {
    name: "get_stock_price",
    description: "Live stock / index prices. Accepts company names or tickers, comma-separated (e.g. 'Reliance, TCS', 'Nifty', 'AAPL').",
    input_schema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
  },
  {
    name: "cricket_scores",
    description: "Live and recent cricket match scores, optionally for one team.",
    input_schema: { type: "object", properties: { team: { type: "string" } }, required: [] },
  },
  {
    name: "check_bills",
    description: "Scan Gmail for bills (electricity, phone, broadband, credit card…), set reminders two days before each is due, and list upcoming bills.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "read_clipboard",
    description: "Read what the user copied (text, an image, or copied files). Use when they say 'this', 'what I copied', 'summarise this', 'translate this', 'reply to this'.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "write_clipboard",
    description: "Put text on the clipboard so the user can paste it (a drafted reply, a translation, a summary).",
    input_schema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
  },
  {
    name: "set_voice",
    description: "Change how ULTRON sounds: which installed voice (from the list this returns on error or with no arguments) and/or speaking speed (0.7 slow – 1.5 fast; 1 normal).",
    input_schema: { type: "object", properties: { voice: { type: "string" }, speed: { type: "number" } }, required: [] },
  },
  {
    name: "operate_computer",
    description:
      "Carry out a multi-step task on the user's PC by looking at the screen and using the mouse and keyboard — e.g. filling in a form, renaming files in Explorer, changing a setting in an app, finding something on a website. Needs the user's confirmation. Describe the task completely and concretely (which app/site, what to do, when to stop). It will not enter passwords or payment details, buy things, send messages, or delete files. Prefer a dedicated tool when one exists — this is slower.",
    input_schema: {
      type: "object",
      properties: { task: { type: "string", description: "The complete task, in plain words" } },
      required: ["task"],
    },
  },
  {
    name: "call_health_report",
    description:
      "Place a real phone call (via Twilio) to the user's phone number and read out a spoken summary of this PC's health — disk space, memory, CPU load, and recent system errors — plus any important unread Gmail messages. Requires TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER, and USER_PHONE_NUMBER to be set in .env.local. This places a real, billed phone call, so it always requires the user's explicit confirmation before it runs.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
];

function parseSex(value: unknown): "male" | "female" {
  const v = String(value ?? "").trim().toLowerCase();
  if (["female", "f", "woman"].includes(v)) return "female";
  if (["male", "m", "man"].includes(v)) return "male";
  // The formula differs by ~166 kcal/day — don't silently guess.
  throw new Error(`sex must be "male" or "female" for the Mifflin-St Jeor formula (got "${value}").`);
}

/** Most tools return text; look_at_screen also returns an image for Claude to see. */
export type ToolOutput =
  | string
  | { text: string; image: { mediaType: "image/png" | "image/jpeg"; data: string } }
  | { text: string; document: { mediaType: "application/pdf"; data: string } };

const KNOWN_TOOL_NAMES = new Set<string>(TOOLS.map((t) => t.name));

/** What routines may contain and which of their steps run without asking. */
export const TOOL_POLICY: ToolPolicy = {
  known: (name) => KNOWN_TOOL_NAMES.has(name),
  auto: (name) => AUTO_EXECUTE.has(name as ToolName),
};

/** Whether this call must wait for the user's OK. Mostly fixed per tool; a
 *  routine asks only when one of its steps would. */
/** What the confirm box shows and, once approved, what runs. For a routine
 *  that's its current steps, so the user approves what will really happen. */
export function confirmationInput(name: string, input: Record<string, unknown>): Record<string, unknown> {
  if (name !== "run_routine") return input;
  const r = findRoutine(String(input.name ?? ""));
  return { name: r?.name ?? String(input.name ?? ""), confirmed_steps: r?.steps ?? [] };
}

export function needsConfirmation(name: string, input: Record<string, unknown>): boolean {
  if (name === "run_routine") return routineNeedsConfirmation(String(input.name ?? ""), TOOL_POLICY);
  return !AUTO_EXECUTE.has(name as ToolName);
}

async function setVoice(voice?: string, speed?: number): Promise<string> {
  const installed = await listEnglishVoices();
  const patch: { voice?: string; voiceSpeed?: number } = {};
  if (voice !== undefined) {
    const v = voice.trim().toLowerCase();
    const pick = ["default", "normal", "original"].includes(v) ? "" : installed.find((x) => x.toLowerCase() === v) ?? installed.find((x) => x.toLowerCase().includes(v));
    if (pick === undefined) {
      throw new Error(`No installed voice matches "${voice}". Installed: ${installed.join(", ") || "none"}. More can be added with scripts\\install-piper-voice.ps1 (jarvis, butler, us-male, us-female, uk-female, narrator).`);
    }
    patch.voice = pick;
  }
  if (speed !== undefined) patch.voiceSpeed = speed;
  if (voice === undefined && speed === undefined) {
    const s = await getSettings();
    return `Voice: ${s.voice || "default"}, speed ${s.voiceSpeed}. Installed voices: ${installed.join(", ") || "none (browser voice)"}.`;
  }
  const s = await updateSettings(patch);
  return `Voice set to ${s.voice || "the default"} at speed ${s.voiceSpeed}.`;
}

export async function executeTool(
  name: ToolName,
  input: Record<string, unknown>,
  /** confirmed: the user approved exactly this call in the confirm box. */
  ctx: { signal?: AbortSignal; confirmed?: boolean } = {},
): Promise<ToolOutput> {
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
        parseSex(input.sex),
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
      return vocabResult(String(input.word ?? ""), String(input.language ?? ""), input.correct === true || input.correct === "true");
    case "vocab_summary":
      return vocabSummary(input.language ? String(input.language) : undefined);
    case "set_timer":
      return setTimer(Number(input.duration_seconds), input.label ? String(input.label) : undefined);
    case "set_reminder":
      return setReminder(
        String(input.text ?? ""),
        input.at ? String(input.at) : undefined,
        input.in_minutes !== undefined ? Number(input.in_minutes) : undefined,
      );
    case "list_reminders":
      return listReminders();
    case "cancel_reminder":
      return cancelReminder(String(input.query ?? ""));
    case "set_daily_briefing":
      return setDailyBriefing(String(input.time ?? ""));
    case "morning_briefing":
      return morningBriefing(input.location ? String(input.location) : undefined);
    case "get_weather":
      return getWeather(input.location ? String(input.location) : undefined);
    case "look_at_screen":
      return lookAtScreen();
    case "set_volume":
      return setVolume(String(input.action ?? ""), input.amount !== undefined ? Number(input.amount) : undefined);
    case "media_control":
      return mediaControl(String(input.action ?? ""));
    case "lock_pc":
      return lockPc();
    case "set_brightness":
      return setBrightness(Number(input.level));
    case "power_action":
      return powerAction(String(input.action ?? ""));
    case "cancel_shutdown":
      return cancelShutdown();
    case "scan_disk_junk":
      return scanDiskJunk();
    case "clean_disk_junk":
      return cleanDiskJunk(Array.isArray(input.categories) ? input.categories.map(String) : [String(input.categories ?? "")]);
    case "recall_conversations":
      return searchEpisodes(String(input.query ?? ""));
    case "set_proactive":
      return setProactive(
        typeof input.enabled === "boolean" ? input.enabled : input.enabled === "true" ? true : input.enabled === "false" ? false : undefined,
        input.quiet_hours !== undefined ? String(input.quiet_hours) : undefined,
      );
    case "usage_report":
      return usageReport();
    case "search_documents":
      return searchDocuments(String(input.query ?? ""));
    case "read_document":
      return readDocument(String(input.path ?? ""));
    case "send_whatsapp":
      return sendWhatsApp(String(input.to ?? ""), String(input.message ?? ""));
    case "smart_home_devices":
      return listSmartHome(input.query ? String(input.query) : "");
    case "smart_home_control": {
      const num = (v: unknown) => (v === undefined || v === null || v === "" ? undefined : Number(v));
      return controlSmartHome({
        device: String(input.entity_id ?? input.device ?? ""),
        action: String(input.action ?? ""),
        brightness: num(input.brightness),
        temperature: num(input.temperature),
        color: input.color ? String(input.color) : undefined,
        warmth: num(input.warmth),
        speed: num(input.speed),
        channel: num(input.channel),
      });
    }
    case "smart_home_security":
      return controlSmartHomeSecurity(String(input.entity_id ?? ""), String(input.action ?? ""));
    case "tv_control":
      return controlTv({
        action: String(input.action ?? ""),
        steps: input.steps !== undefined ? Number(input.steps) : undefined,
        app: input.app ? String(input.app) : undefined,
        query: input.query ? String(input.query) : undefined,
        text: input.text ? String(input.text) : undefined,
      });
    case "ir_remote":
      return irControl({
        remote: String(input.remote ?? ""),
        key: input.key ? String(input.key) : undefined,
        temperature: input.temperature !== undefined ? Number(input.temperature) : undefined,
        mode: input.mode ? String(input.mode) : undefined,
        fan_speed: input.fan_speed ? String(input.fan_speed) : undefined,
      });
    case "save_routine":
      return saveRoutine(input as never, TOOL_POLICY);
    case "run_routine": {
      // Steps run as if the user had asked for each one directly: they
      // approved the routine as a whole when any step needed approval — and
      // then exactly the steps they were shown (snapshotted server-side), so
      // an edit in between can't sneak something in.
      const runStep = (tool: string, stepInput: Record<string, unknown>) => executeTool(tool as ToolName, stepInput, { signal: ctx.signal });
      if (ctx.confirmed && Array.isArray(input.confirmed_steps)) {
        return runRoutineSteps({ id: "", name: String(input.name ?? "routine"), steps: input.confirmed_steps as RoutineStep[], createdAt: "" }, runStep);
      }
      if (routineNeedsConfirmation(String(input.name ?? ""), TOOL_POLICY)) throw new Error("That routine needs the user's confirmation.");
      return runRoutine(String(input.name ?? ""), runStep);
    }
    case "list_routines":
      return listRoutines();
    case "delete_routine":
      return deleteRoutine(String(input.name ?? ""));
    case "start_focus":
      return startFocus({
        minutes: input.minutes !== undefined ? Number(input.minutes) : undefined,
        breakMinutes: input.break_minutes !== undefined ? Number(input.break_minutes) : undefined,
        rounds: input.rounds !== undefined ? Number(input.rounds) : undefined,
        task: input.task ? String(input.task) : undefined,
      });
    case "stop_focus":
      return stopFocus();
    case "focus_status":
      return focusStatus();
    case "screen_time_report":
      return screenTimeReport(input.period ? String(input.period) : "today");
    case "get_news":
      return getNews(input.topic ? String(input.topic) : "");
    case "get_stock_price":
      return getStockPrices(String(input.query ?? ""));
    case "cricket_scores":
      return getCricketScores(input.team ? String(input.team) : "");
    case "check_bills":
      return checkBills();
    case "read_clipboard":
      return readClipboard();
    case "write_clipboard":
      return writeClipboard(String(input.text ?? ""));
    case "set_voice":
      return setVoice(input.voice ? String(input.voice) : undefined, input.speed !== undefined ? Number(input.speed) : undefined);
    case "operate_computer": {
      if (!(await getSettings()).computerUse) throw new Error("Operating the computer is switched off in Settings.");
      return operateComputer(String(input.task ?? ""), {
        client: new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }),
        signal: ctx.signal,
      });
    }
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
