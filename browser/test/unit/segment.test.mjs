import { readFileSync } from "node:fs";
const B = new URL("../../src/content/", import.meta.url).pathname;
globalThis.LAITA = {};
eval(readFileSync(B + "segment.js", "utf8"));
let pass = 0, fail = 0;
const eq = (n, g, w) => { const a=JSON.stringify(g), b=JSON.stringify(w); if(a===b) pass++; else {fail++; console.log("FAIL "+n+"\n  got  "+a+"\n  want "+b);} };

const t1 = "First para line one.\nStill first para.\n\n  \n\nSecond para here.";
const c1 = LAITA.chunkText(t1, 700, "en");
eq("paragraph split", c1.map(c => c.text), ["First para line one.\nStill first para.", "Second para here."]);
eq("offsets exact", c1.every(c => t1.slice(c.start, c.start + c.text.length) === c.text), true);

const long = Array.from({length: 12}, (_, i) => `This is sentence number ${i} and it says something.`).join(" ");
const c2 = LAITA.chunkText(long, 200, "en");
eq("long para is split", c2.length > 1, true);
eq("split offsets exact", c2.every(c => long.slice(c.start, c.start + c.text.length) === c.text), true);
eq("chunks stay near limit", c2.every(c => c.text.length <= 260), true);
eq("nothing lost", c2.map(c => c.text).join(" "), long);

eq("blank text", LAITA.chunkText("   \n\n  ", 700, "en"), []);
eq("single word too short", LAITA.chunkText("a", 700, "en"), []);
const fr = "Bonjour, je vous écris. Malgré le budget, nous sommes intéressés.";
eq("french offsets", LAITA.chunkText(fr, 700, "fr").every(c => fr.slice(c.start, c.start+c.text.length) === c.text), true);

// ---------------------------------------------------------------- chunkAtCaret
// Only the paragraph holding the caret is checked automatically, so locating it wrongly
// means either checking the wrong text or checking nothing at all.

const doc = "First paragraph here.\n\nSecond paragraph here.\n\nThird paragraph here.";
const cs = LAITA.chunkText(doc, 700, "en");
eq("three paragraphs", cs.length, 3);

const at = (caret) => LAITA.chunkAtCaret(cs, caret);
eq("caret at the very start", at(0), 0);
eq("caret inside the first", at(5), 0);
eq("caret inside the second", at(doc.indexOf("Second") + 3), 1);
eq("caret inside the third", at(doc.indexOf("Third") + 3), 2);
eq("caret at the very end", at(doc.length), 2);

// a caret on a boundary belongs to the paragraph being typed, not the next one
const endOfFirst = cs[0].start + cs[0].text.length;
eq("caret at the end of a paragraph stays in it", at(endOfFirst), 0);
eq("caret in the blank line between belongs to the earlier one", at(endOfFirst + 1), 0);

eq("no caret means no chunk", at(null), -1);
eq("undefined caret means no chunk", at(undefined), -1);
eq("negative caret means no chunk", at(-1), -1);
eq("empty document", LAITA.chunkAtCaret([], 5), -1);

console.log(pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
