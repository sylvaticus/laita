/** Paragraph finding and prose detection: what decides which text reaches the model. */
import { createRequire } from "node:module";
const { detectLanguage, paragraphs, paragraphAt, isProse, chunkParagraph, chunkAt } =
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

// ---------------------------------------------------------------- chunking
// Latency grows faster than length - 419 chars took 4.4s, 1119 took 19.4 - so a long
// paragraph must not go out whole.

const SENT = "The negative loops become stronger as growth approaches the limit. ";
const LONGP = SENT.repeat(8).trim();

eq("a short paragraph is one piece", chunkParagraph("Short enough.", 700, "en").length, 1);
eq("its offset is zero", chunkParagraph("Short enough.", 700, "en")[0].offset, 0);

const cs = chunkParagraph(LONGP, 300, "en");
eq("a long one is split", cs.length > 1, true);
eq("every chunk is within the limit, allowing one overshoot per sentence",
   cs.every((c) => c.text.length <= 300 + SENT.length), true);
eq("offsets index their own text",
   cs.every((c) => LONGP.slice(c.offset, c.offset + c.text.length) === c.text), true);
eq("nothing is lost", cs.map((c) => c.text).join(""), LONGP);
eq("nothing is duplicated", cs.map((c) => c.text).join("").length, LONGP.length);

// a single sentence longer than the limit still has to go somewhere
const HUGE = "word ".repeat(300).trim();
const hs = chunkParagraph(HUGE, 300, "en");
eq("one huge sentence is not dropped", hs.map((c) => c.text).join(""), HUGE);

eq("chunkAt finds the one holding an offset",
   chunkAt(cs, cs[1].offset + 5)?.offset, cs[1].offset);
eq("a boundary belongs to the earlier chunk", chunkAt(cs, cs[0].text.length)?.offset, cs[0].offset);
eq("past the end is nothing", chunkAt(cs, LONGP.length + 50), null);

console.log(pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
