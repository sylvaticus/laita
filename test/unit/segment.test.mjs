import { readFileSync } from "node:fs";
const B = new URL("../../src/content/", import.meta.url).pathname;
globalThis.LAS = {};
eval(readFileSync(B + "segment.js", "utf8"));
let pass = 0, fail = 0;
const eq = (n, g, w) => { const a=JSON.stringify(g), b=JSON.stringify(w); if(a===b) pass++; else {fail++; console.log("FAIL "+n+"\n  got  "+a+"\n  want "+b);} };

const t1 = "First para line one.\nStill first para.\n\n  \n\nSecond para here.";
const c1 = LAS.chunkText(t1, 700, "en");
eq("paragraph split", c1.map(c => c.text), ["First para line one.\nStill first para.", "Second para here."]);
eq("offsets exact", c1.every(c => t1.slice(c.start, c.start + c.text.length) === c.text), true);

const long = Array.from({length: 12}, (_, i) => `This is sentence number ${i} and it says something.`).join(" ");
const c2 = LAS.chunkText(long, 200, "en");
eq("long para is split", c2.length > 1, true);
eq("split offsets exact", c2.every(c => long.slice(c.start, c.start + c.text.length) === c.text), true);
eq("chunks stay near limit", c2.every(c => c.text.length <= 260), true);
eq("nothing lost", c2.map(c => c.text).join(" "), long);

eq("blank text", LAS.chunkText("   \n\n  ", 700, "en"), []);
eq("single word too short", LAS.chunkText("a", 700, "en"), []);
const fr = "Bonjour, je vous écris. Malgré le budget, nous sommes intéressés.";
eq("french offsets", LAS.chunkText(fr, 700, "fr").every(c => fr.slice(c.start, c.start+c.text.length) === c.text), true);
console.log(pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
