// How the user is speaking right now, measured by the browser. Voice
// recognition gives text only (no tone of voice), so these are the honest
// cues available: pace, cutting ULTRON off, repeating themselves, and
// firing the next request the instant a reply ends.

export interface SpeakingSignals {
  wordsPerSecond?: number;
  interruptedLastReply?: boolean;
  repeatedRequest?: boolean;
  quickFollowUp?: boolean;
}

export function parseSignals(raw: unknown): SpeakingSignals {
  if (!raw || typeof raw !== "object") return {};
  const r = raw as Record<string, unknown>;
  const wps = Number(r.wordsPerSecond);
  return {
    ...(Number.isFinite(wps) && wps > 0 && wps < 10 ? { wordsPerSecond: wps } : {}),
    ...(r.interruptedLastReply === true ? { interruptedLastReply: true } : {}),
    ...(r.repeatedRequest === true ? { repeatedRequest: true } : {}),
    ...(r.quickFollowUp === true ? { quickFollowUp: true } : {}),
  };
}

/** One line for the system prompt, or "" when nothing stands out. Typical
 *  conversational speech is about 2.5 words a second. */
export function describeSignals(s: SpeakingSignals): string {
  const cues: string[] = [];
  if (s.wordsPerSecond !== undefined) {
    if (s.wordsPerSecond >= 3.5) cues.push(`speaking fast (${s.wordsPerSecond.toFixed(1)} words/s)`);
    else if (s.wordsPerSecond <= 1.4) cues.push(`speaking slowly (${s.wordsPerSecond.toFixed(1)} words/s)`);
  }
  if (s.interruptedLastReply) cues.push("cut off your previous reply");
  if (s.repeatedRequest) cues.push("repeated their previous request — you may have misunderstood or failed");
  if (s.quickFollowUp) cues.push("spoke again the moment you finished");
  return cues.length ? `How the user is speaking right now: ${cues.join("; ")}.` : "";
}
