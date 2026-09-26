// Pure helpers for interpreting what the microphone heard. Kept separate
// from the React component so they can be unit-tested.

/** Tolerant of common mis-hearings ("hey ultron" -> "hey altron", or "hey"
 *  getting dropped entirely by the recognizer). Returns whatever came after
 *  the wake phrase in the same utterance ("" if the wake word was said
 *  alone), or null if no wake word was heard at all. */
export function detectWake(transcript: string): string | null {
  // Whisper writes the name in Devanagari when listening for Hindi.
  const patterns = [/\b(hey|ok)[,]?\s+(ultron|altron)\b/i, /(हे|हाय|ओके)[,]?\s*(अल्ट्रॉन|अल्ट्रोन|अल्ट्रान)/, /\bultron\b/i, /\baltron\b/i, /अल्ट्रॉन|अल्ट्रोन|अल्ट्रान/];
  for (const pattern of patterns) {
    const match = transcript.match(pattern);
    if (match && match.index !== undefined) {
      return transcript.slice(match.index + match[0].length).replace(/^[,.!?\s]+/, "").trim();
    }
  }
  return null;
}

const LEADING_WAKE = /^\s*(?:(?:hey|ok|हे|हाय|ओके)[,]?\s*)?(?:ultron\b|altron\b|अल्ट्रॉन|अल्ट्रोन|अल्ट्रान)[,.!।]?\s*/i;

/** Only a wake phrase at the *start* counts, so "tell me about the movie
 *  Ultron" stays intact. Returns the command after it, or null if the
 *  utterance doesn't start with the wake word. */
export function leadingWakeCommand(transcript: string): string | null {
  return LEADING_WAKE.test(transcript) ? transcript.replace(LEADING_WAKE, "").trim() : null;
}

/** Removes a leading wake phrase if present; otherwise returns the text as-is. */
export function stripLeadingWake(transcript: string): string {
  return transcript.replace(LEADING_WAKE, "").trim();
}

// The whole utterance has to be a stop phrase — "I'll stop the music, sir"
// coming back from the speakers must not count.
const STOP_PHRASE =
  /^(?:(?:hey|ok)[,]?\s+)?(?:(?:ultron|altron)[,]?\s+)?(?:stop|stop it|stop talking|stop that|quiet|be quiet|shut up|silence|never ?mind|cancel|cancel that|that'?s enough|enough|hold on|wait|pause)(?:\s+(?:please|now|ultron|altron))?[.!]?$/i;

export function isStopCommand(transcript: string): boolean {
  return STOP_PHRASE.test(transcript.trim());
}

function words(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/<[^>]+>/g, " ")
    .replace(/[^\p{L}\p{N}\s']/gu, " ")
    .split(/\s+/)
    .filter((w) => w.length > 1);
}

/** True when a transcript is most likely ULTRON's own voice picked up by the
 *  mic (the tail of a reply heard just after it finished speaking). */
export function looksLikeEcho(transcript: string, recentlySpoken: string): boolean {
  const heard = words(transcript);
  if (heard.length === 0 || !recentlySpoken) return false;
  const spoken = new Set(words(recentlySpoken));
  const overlap = heard.filter((w) => spoken.has(w)).length;
  return heard.length >= 2 && overlap / heard.length >= 0.7;
}

/** True when two requests are essentially the same words — the user
 *  repeating themselves, usually because ULTRON got it wrong. */
export function isRepeatOf(current: string, previous: string): boolean {
  const a = words(current);
  const b = new Set(words(previous));
  if (a.length < 2 || b.size === 0) return false;
  // People rephrase a little when repeating ("ten" -> "10", "... please").
  return a.filter((w) => b.has(w)).length / Math.max(a.length, b.size) >= 0.6;
}
