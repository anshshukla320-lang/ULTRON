// Splits a reply that arrives in small streamed pieces into whole sentences
// the moment each one is complete, so the first sentence can be spoken
// while Claude is still writing the rest.

const OPEN_TAG = /<lang\b[^>]*>/gi;
const CLOSE_TAG = /<\/lang>/gi;

// "Dr. Smith" or "3 p.m. today" shouldn't end a spoken chunk.
const ABBREVIATION_BEFORE = /\b(?:mr|mrs|ms|dr|prof|sr|jr|st|vs|etc|no|approx|e\.g|i\.e|a\.m|p\.m)$/i;

/** True while the text has an unclosed <lang> tag (or a tag still being typed). */
function insideLangTag(text: string): boolean {
  const opens = text.match(OPEN_TAG)?.length ?? 0;
  const closes = text.match(CLOSE_TAG)?.length ?? 0;
  return opens > closes || /<[^>]*$/.test(text);
}

export class SentenceChunker {
  private buffer = "";

  /** Adds streamed text; returns any sentences that are now complete. */
  push(delta: string): string[] {
    this.buffer += delta;
    const out: string[] = [];
    // A boundary is .!? (optionally followed by a closing quote/bracket)
    // then whitespace, or a line break.
    const boundary = /[.!?]+["')\]]*\s+|\n+/g;
    let start = 0;
    let match: RegExpExecArray | null;
    while ((match = boundary.exec(this.buffer)) !== null) {
      const end = match.index + match[0].length;
      const candidate = this.buffer.slice(start, end);
      const beforeDot = this.buffer.slice(start, match.index);
      if (insideLangTag(this.buffer.slice(0, end))) continue;
      if (match[0].startsWith(".") && ABBREVIATION_BEFORE.test(beforeDot)) continue;
      if (candidate.trim()) out.push(candidate.trim());
      start = end;
    }
    this.buffer = this.buffer.slice(start);
    return out;
  }

  /** Whatever is left once the reply has finished streaming. */
  flush(): string {
    const rest = this.buffer.trim();
    this.buffer = "";
    return rest;
  }
}
