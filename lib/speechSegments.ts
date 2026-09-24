// Ultron marks foreign-language text in its replies as
// <lang code="es">¿Dónde está la estación?</lang> so each piece can be
// spoken by a native voice instead of the English one. Shared by the
// client (splitting/playing, and stripping tags for display) and the TTS
// route.

export interface SpeechSegment {
  text: string;
  /** BCP-47-ish language code ("es", "pt-BR"); undefined = default English voice. */
  lang?: string;
}

const LANG_TAG = /<lang\s+code=["']?([A-Za-z]{2,3}(?:[-_][A-Za-z]{2,4})?)["']?\s*>([\s\S]*?)<\/lang>/gi;

export function parseSpeechSegments(text: string): SpeechSegment[] {
  const segments: SpeechSegment[] = [];
  const pushSegment = (chunk: string, lang?: string) => {
    const cleaned = chunk.replace(/<\/?lang[^>]*>/gi, "").replace(/\s+/g, " ").trim();
    // Punctuation-only leftovers (", " between two tags) aren't worth their
    // own audio clip.
    if (!/[\p{L}\p{N}]/u.test(cleaned)) return;
    const prev = segments[segments.length - 1];
    if (prev && prev.lang === lang) prev.text = `${prev.text} ${cleaned}`;
    else segments.push({ text: cleaned, lang });
  };

  let last = 0;
  for (const match of text.matchAll(LANG_TAG)) {
    pushSegment(text.slice(last, match.index));
    const code = match[1].replace("_", "-");
    pushSegment(match[2], /^en\b/i.test(code) ? undefined : code);
    last = match.index + match[0].length;
  }
  pushSegment(text.slice(last));
  return segments;
}

export function stripSpeechMarkup(text: string): string {
  return text.replace(LANG_TAG, "$2").replace(/<\/?lang[^>]*>/gi, "");
}
