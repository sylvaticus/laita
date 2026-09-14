/** Paragraph finding and prose detection: what decides which text reaches the model. */
import { createRequire } from "node:module";
const { detectLanguage, paragraphs, paragraphAt, isProse } =
  createRequire(import.meta.url)("../../src/text.js");

let pass = 0, fail = 0;
const eq = (n, g, w) => {
  const a = JSON.stringify(g), b = JSON.stringify(w);
  if (a === b) pass++; else { fail++; console.log("FAIL " + n + "\n  got  " + a + "\n  want " + b); }
};
const L = (s) => s.split("\n");

// ---------------------------------------------------------------- paragraphs
const doc = L("First para line one.\nstill first\n\nSecond para.\n\n\n  \nThird para.");
eq("blank lines separate paragraphs", paragraphs(doc).map((p) => [p.start, p.end]),
   [[0, 1], [3, 3], [7, 7]]);
eq("a run of blank lines is still one break", paragraphs(doc).length, 3);
eq("no trailing empty paragraph", paragraphs(L("Only para.\n\n")).map((p) => [p.start, p.end]),
   [[0, 0]]);
eq("an empty document has none", paragraphs(L("")), []);
eq("whitespace-only is not a paragraph", paragraphs(L("   \n\t\n")), []);

// code fences must arrive as one opaque block, never offered to a proofreader
const fenced = L("Prose here.\n\n```js\nconst x = 1;\n\nlet y = 2;\n```\n\nMore prose.");
const ps = paragraphs(fenced);
eq("a fence is a single paragraph", ps.map((p) => [p.start, p.end, p.code]),
   [[0, 0, false], [2, 6, true], [8, 8, false]]);
eq("a blank line inside a fence does not split it", ps.filter((p) => p.code).length, 1);
eq("tilde fences too", paragraphs(L("~~~\ncode\n~~~")).map((p) => p.code), [true]);

// ---------------------------------------------------------------- paragraphAt
eq("cursor in the first", paragraphAt(doc, 1)?.start, 0);
eq("cursor in the last", paragraphAt(doc, 7)?.start, 7);
eq("cursor on a blank line belongs to no paragraph", paragraphAt(doc, 2), null);
eq("cursor past the end", paragraphAt(doc, 99), null);

// ---------------------------------------------------------------- isProse
eq("ordinary prose", isProse("The committee met last Tuesday to discuss it.", false), true);
eq("code is never prose", isProse("const x = 1;", true), false);
eq("too short", isProse("Hi.", false), false);
eq("a markdown table row", isProse("| a | b |\n| - | - |", false), false);
eq("digits and punctuation only", isProse("12 34 56 78 90 12", false), false);
eq("three words is enough", isProse("Deadline moved again", false), true);

// ---------------------------------------------------------------- language
eq("english", detectLanguage("the cat is on the table and it is not from there"), "en");
eq("french", detectLanguage("le chat est sur la table et je ne sais pas pour vous"), "fr");
eq("italian", detectLanguage("il gatto e sulla tavola che non lo so per una di questo"), "it");
eq("falls back to english when unsure", detectLanguage("xyzzy plugh frobnitz"), "en");

console.log(pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
