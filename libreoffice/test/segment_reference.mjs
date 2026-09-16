// The JavaScript chunker, for the Python port to be compared against. segment.js is a
// content script that assigns to a global, so it is evaluated rather than imported.
import { readFileSync } from "node:fs";
const B = new URL("../../browser/src/content/", import.meta.url).pathname;
globalThis.LAITA = {};
eval(readFileSync(B + "segment.js", "utf8"));

const CASES = JSON.parse(readFileSync(new URL("./segment_cases.json", import.meta.url), "utf8"));
const out = CASES.map((c) => ({
  name: c.name,
  limit: c.limit,
  chunks: LAITA.chunkText(c.text, c.limit, "en").map((x) => [x.start, x.text])
}));
process.stdout.write(JSON.stringify(out, null, 1));
