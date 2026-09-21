function countSyllables(word: string): number {
  const w = word.toLowerCase().replace(/[^a-z]/g, "");
  if (!w) return 0;
  const matches = w.match(/[aeiouy]+/g);
  let count = matches ? matches.length : 1;
  if (w.endsWith("e") && count > 1) count -= 1;
  return Math.max(count, 1);
}

/**
 * Gives Claude's writing critique something objective to ground on (like
 * generate_color_palette does for design) — real Flesch reading-ease math,
 * not another LLM call re-judging the same text.
 */
export function analyzeWriting(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) throw new Error("No text provided.");

  const sentences = trimmed.split(/[.!?]+(?:\s|$)/).filter((s) => s.trim().length > 0);
  const words = trimmed.split(/\s+/).filter(Boolean);
  const syllables = words.reduce((s, w) => s + countSyllables(w), 0);
  const avgWordsPerSentence = sentences.length ? words.length / sentences.length : words.length;
  const avgSyllablesPerWord = words.length ? syllables / words.length : 0;
  const fleschScore = 206.835 - 1.015 * avgWordsPerSentence - 84.6 * avgSyllablesPerWord;

  let readability: string;
  if (fleschScore >= 90) readability = "very easy (5th grade)";
  else if (fleschScore >= 70) readability = "easy (7th grade)";
  else if (fleschScore >= 60) readability = "standard (8th-9th grade)";
  else if (fleschScore >= 50) readability = "fairly difficult (college)";
  else if (fleschScore >= 30) readability = "difficult (college graduate)";
  else readability = "very difficult (professional/academic)";

  const passiveMatches = trimmed.match(/\b(is|are|was|were|be|been|being)\s+\w+ed\b/gi) ?? [];
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
