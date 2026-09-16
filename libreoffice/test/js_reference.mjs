// Run the shared cases through the JavaScript anchor and print the result as JSON, so
// the Python port can be compared against it character for character.
import { readFileSync } from "node:fs";
import { anchorIssues, hash } from "../../browser/src/background/anchor.js";

const cases = JSON.parse(readFileSync(new URL("./cases.json", import.meta.url), "utf8"));
const out = cases.map((c) => ({
  name: c.name,
  anchored: anchorIssues(c.text, c.issues),
  hash: hash(c.text)
}));
process.stdout.write(JSON.stringify(out, null, 1));
