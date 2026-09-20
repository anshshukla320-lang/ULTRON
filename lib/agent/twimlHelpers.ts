function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

/** Speaks `say`, then listens for a spoken follow-up and POSTs the transcript
 *  to `actionUrl`. If nothing is heard within the timeout, says a short
 *  goodbye and hangs up instead of leaving the call open forever. */
export function sayAndGather(say: string, actionUrl: string): string {
  return (
    `<?xml version="1.0" encoding="UTF-8"?><Response>` +
    `<Gather input="speech" action="${escapeXml(actionUrl)}" method="POST" speechTimeout="auto" timeout="6">` +
    `<Say voice="Polly.Matthew">${escapeXml(say)}</Say>` +
    `</Gather>` +
    `<Say voice="Polly.Matthew">Didn't hear anything. Talk soon.</Say><Hangup/>` +
    `</Response>`
  );
}

export function sayAndHangup(say: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Say voice="Polly.Matthew">${escapeXml(say)}</Say><Hangup/></Response>`;
}
