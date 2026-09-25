import "./tempHome";
import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import { executeTool, TOOLS, AUTO_EXECUTE, type ToolName } from "../lib/agent/tools";
import { TEST_HOME } from "./tempHome";

const run = (name: string, input: Record<string, unknown> = {}) => executeTool(name as ToolName, input);
const text = async (name: string, input: Record<string, unknown> = {}) => String(await run(name, input));

test("every tool has a unique name, a handler, and valid required fields", async () => {
  const names = TOOLS.map((t) => t.name);
  assert.equal(new Set(names).size, names.length, "duplicate tool names");
  for (const t of TOOLS) {
    const schema = t.input_schema as { properties?: Record<string, unknown>; required?: string[] };
    for (const r of schema.required ?? []) assert.ok(schema.properties?.[r], `${t.name}: required "${r}" missing from properties`);
  }
  const src = await fs.readFile(path.join(import.meta.dirname, "../lib/agent/tools.ts"), "utf-8");
  for (const n of names) assert.ok(src.includes(`case "${n}":`), `${n} has no case in executeTool`);
});

test("risky tools require confirmation", () => {
  for (const risky of ["write_file", "install_app", "send_email", "run_code", "call_health_report", "power_action", "clean_disk_junk"]) {
    assert.ok(!AUTO_EXECUTE.has(risky as ToolName), `${risky} must not auto-execute`);
  }
});

test("workspace file tools stay inside the workspace", async () => {
  assert.match(await text("write_file", { path: "notes/a.txt", content: "hello" }), /Wrote 5 bytes/);
  assert.equal(await text("read_file", { path: "notes/a.txt" }), "hello");
  await assert.rejects(run("read_file", { path: "../../etc/passwd" }), /outside the agent workspace/);
});

test("analyze_csv: quoted commas and even-length median", async () => {
  await fs.writeFile(path.join(TEST_HOME, "ULTRON-Agent-Files", "d.csv"), 'name,age\n"Smith, J",30\nAnn, \nBob,25\n');
  const out = await text("analyze_csv", { path: "d.csv" });
  assert.match(out, /3 rows, 2 columns/);
  assert.match(out, /age: numeric — min 25, max 30, mean 27.50, median 27.5/);
});

test("analyze_writing: irregular passives and abbreviations", async () => {
  const out = await text("analyze_writing", { text: "The ball was thrown. Mistakes were made. Dr. Smith left at 3 p.m. today." });
  assert.match(out, /Sentences: 3/);
  assert.match(out, /passive-voice instances: 2/);
});

test("finance: loan math and input validation", async () => {
  assert.match(await text("calculate_loan", { principal: 200000, annualRatePct: 6.5, years: 30 }), /Monthly payment: \$1264\.14/);
  await assert.rejects(run("calculate_loan", { principal: "abc", annualRatePct: 5, years: 1 }), /must be numbers/);
  await assert.rejects(run("calculate_loan", { principal: 1000, annualRatePct: -1, years: 1 }), /can't be negative/);
  assert.match(await text("log_expense", { amount: 12, category: "" }), /"uncategorized"/);
});

test("fitness: catches unit mix-ups", async () => {
  assert.match(await text("calculate_bmi", { heightCm: 180, weightKg: 75 }), /BMI: 23\.1/);
  await assert.rejects(run("calculate_bmi", { heightCm: 1.8, weightKg: 75 }), /looks like metres/);
  await assert.rejects(run("calculate_bmi", { heightCm: 70, weightKg: 165 }), /check the units/);
  assert.match(
    await text("calculate_calorie_target", { sex: "Female", ageYears: 30, heightCm: 165, weightKg: 60, activityLevel: "Moderately Active" }),
    /BMR: 1320/,
  );
  await assert.rejects(run("calculate_calorie_target", { sex: "", ageYears: 30, heightCm: 180, weightKg: 80, activityLevel: "light" }), /male/);
});

test("color palette: short hex and neutral greys", async () => {
  assert.match(await text("generate_color_palette", { baseColor: "36c", scheme: "triadic" }), /#3366CC/);
  assert.equal(await text("generate_color_palette", { baseColor: "#808080", scheme: "monochromatic" }), "base: #CCCCCC (light) / #808080 (base) / #404040 (dark)");
});

test("vocab: spaced repetition boxes", async () => {
  await run("save_vocab", { word: "hola", translation: "hello", language: "Spanish" });
  assert.match(await text("vocab_result", { word: "hola", language: "Spanish", correct: "true" }), /box 2/);
  assert.match(await text("vocab_result", { word: "hola", language: "spanish", correct: false }), /back to box 1/);
});

test("disk cleanup rejects unknown categories", async () => {
  await assert.rejects(run("clean_disk_junk", { categories: ["downloads"] }), /Unknown categories: downloads/);
});
