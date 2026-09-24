function countSyllables(word: string): number {
  const w = word.toLowerCase().replace(/[^a-z]/g, "");
  if (!w) return 0;
  const matches = w.match(/[aeiouy]+/g);
  let count = matches ? matches.length : 1;
  if (w.endsWith("e") && count > 1) count -= 1;
  return Math.max(count, 1);
}

// Periods that don't end a sentence ("Dr. Smith", "3 p.m. on Jan. 5").
const ABBREVIATIONS = /\b(mr|mrs|ms|dr|prof|sr|jr|st|vs|etc|no|fig|approx|e\.g|i\.e|a\.m|p\.m|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)\./gi;

// Common irregular past participles — "was thrown", "were written" don't
// end in -ed, so a plain /\w+ed/ check misses most everyday passives.
const IRREGULAR_PARTICIPLES =
  "arisen|awoken|beaten|become|begun|bent|bitten|blown|born|borne|bought|bound|broken|brought|built|burnt|caught|chosen|come|cut|dealt|done|drawn|driven|drunk|dug|eaten|fallen|fed|felt|fought|found|flown|forbidden|forgiven|forgotten|frozen|given|gone|grown|heard|held|hidden|hit|hung|hurt|kept|known|laid|led|left|lent|let|lit|lost|made|meant|met|paid|put|quit|read|ridden|risen|run|said|seen|sent|set|shaken|shot|shown|shut|sold|sought|spent|spoken|spread|stolen|struck|stuck|sung|sunk|swept|sworn|taken|taught|thrown|thought|told|torn|understood|undone|upset|woken|won|worn|written";
const PASSIVE = new RegExp(`\\b(?:is|are|was|were|be|been|being)\\s+(?:\\w+ly\\s+)?(?:\\w+ed|${IRREGULAR_PARTICIPLES})\\b`, "gi");

/**
 * Gives Claude's writing critique something objective to ground on (like
 * generate_color_palette does for design) — real Flesch reading-ease math,
 * not another LLM call re-judging the same text.
 */
export function analyzeWriting(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) throw new Error("No text provided.");

  const sentences = trimmed
    .replace(ABBREVIATIONS, (m) => m.replace(/\./g, "\u0000"))
    .split(/[.!?]+(?:\s|$)/)
    .map((s) => s.replace(/\u0000/g, "."))
    .filter((s) => s.trim().length > 0);
  const words = trimmed.split(/\s+/).filter(Boolean);
  const syllables = words.reduce((s, w) => s + countSyllables(w), 0);
  const avgWordsPerSentence = sentences.length ? words.length / sentences.length : words.length;
  const avgSyllablesPerWord = words.length ? syllables / words.length : 0;
  // The raw formula runs past 0-100 on very short or very dense text.
  const fleschScore = Math.min(100, Math.max(0, 206.835 - 1.015 * avgWordsPerSentence - 84.6 * avgSyllablesPerWord));

  let readability: string;
  if (fleschScore >= 90) readability = "very easy (5th grade)";
  else if (fleschScore >= 70) readability = "easy (7th grade)";
  else if (fleschScore >= 60) readability = "standard (8th-9th grade)";
  else if (fleschScore >= 50) readability = "fairly difficult (college)";
  else if (fleschScore >= 30) readability = "difficult (college graduate)";
  else readability = "very difficult (professional/academic)";

  const passiveMatches = trimmed.match(PASSIVE) ?? [];
  const longest = sentences.reduce((a, b) => (b.split(/\s+/).length > a.split(/\s+/).length ? b : a), "");
  const longestWords = longest.trim().split(/\s+/).length;

  return [
    `Words: ${words.length}, Sentences: ${sentences.length}`,
    `Avg words/sentence: ${avgWordsPerSentence.toFixed(1)}`,
    `Flesch reading ease: ${fleschScore.toFixed(0)} (${readability})`,
    `Possible passive-voice instances: ${passiveMatches.length}`,
    `Longest sentence (${longestWords} words): "${longest.trim().slice(0, 120)}${longest.length > 120 ? "..." : ""}"`,
  ].join("\n");
}
