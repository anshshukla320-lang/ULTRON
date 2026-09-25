import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSpeechSegments, stripSpeechMarkup } from "../lib/speechSegments";
import { SentenceChunker } from "../lib/sentenceChunker";
import { detectWake, isStopCommand, leadingWakeCommand, looksLikeEcho, stripLeadingWake } from "../lib/voiceCommands";

test("language tags split into voice segments", () => {
  const segs = parseSpeechSegments('That is <lang code="es">hola</lang>, <lang code="es">amigo</lang>, sir.');
  assert.deepEqual(segs, [
    { text: "That is", lang: undefined },
    { text: "hola amigo", lang: "es" },
    { text: ", sir.", lang: undefined },
  ]);
  assert.equal(stripSpeechMarkup('say <lang code="fr">merci</lang>'), "say merci");
});

function chunkAll(pieces: string[]): string[] {
  const c = new SentenceChunker();
  const out = pieces.flatMap((p) => c.push(p));
  const rest = c.flush();
  return rest ? [...out, rest] : out;
}

test("sentences are released as soon as they complete", () => {
  const c = new SentenceChunker();
  assert.deepEqual(c.push("Good morning, sir"), []);
  assert.deepEqual(c.push(". It's 20 degr"), ["Good morning, sir."]);
  assert.deepEqual(c.push("ees outside! And"), ["It's 20 degrees outside!"]);
  assert.equal(c.flush(), "And");
});

test("chunks don't break abbreviations, decimals, or language tags", () => {
  assert.deepEqual(chunkAll(["Dr. Smith is at 3 p.m. today. Price is 3.5 dollars. Done"]), [
    "Dr. Smith is at 3 p.m. today.",
    "Price is 3.5 dollars.",
    "Done",
  ]);
  assert.deepEqual(chunkAll(['Say <lang code="es">¿Dónde está? Aquí.</lang> Then go.']), [
    'Say <lang code="es">¿Dónde está? Aquí.</lang> Then go.',
  ]);
  assert.deepEqual(chunkAll(['Try <lang co', 'de="fr">Bonjour. Ça va?</lang> Next. Last']), [
    'Try <lang code="fr">Bonjour. Ça va?</lang> Next.',
    "Last",
  ]);
});

test("wake word handling", () => {
  assert.equal(detectWake("hey ultron, what's the time"), "what's the time");
  assert.equal(detectWake("play music"), null);
  assert.equal(leadingWakeCommand("hey ultron spanish"), "spanish");
  assert.equal(leadingWakeCommand("tell me about the movie Ultron"), null);
  assert.equal(stripLeadingWake("Ultron, open notepad"), "open notepad");
});

test("stop phrases must be the whole utterance", () => {
  for (const s of ["stop", "Stop.", "ultron stop", "hey ultron, stop", "never mind", "be quiet please", "that's enough"]) {
    assert.ok(isStopCommand(s), s);
  }
  for (const s of ["I'll stop the music, sir", "stop the timer and play music", "don't stop"]) {
    assert.ok(!isStopCommand(s), s);
  }
});

test("echo detection", () => {
  const spoken = "The weather in Pune is 24 degrees and partly cloudy, sir.";
  assert.ok(looksLikeEcho("partly cloudy sir", spoken));
  assert.ok(!looksLikeEcho("set a timer for five minutes", spoken));
  assert.ok(!looksLikeEcho("stop", spoken), "single words aren't judged");
});
