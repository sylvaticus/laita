/**
 * core/ holds anchor.js and ollama.js copied from the browser extension, because a
 * packaged .vsix may only contain files from inside vscode/. The copies are generated,
 * not committed: tools/sync-core.sh makes them, vscode:prepublish runs it before
 * packaging, and this runs it before checking that what came out matches the source.
 *
 * core/package.json IS committed - it declares the copies as ESM and is not generated.
 */
import { readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const CORE = join(HERE, "../../core");
const SRC = join(HERE, "../../../browser/src/background");

execFileSync(join(HERE, "../../tools/sync-core.sh"), { stdio: "pipe" });

let pass = 0, fail = 0;
const ok = (n, c, d = "") => { if (c) pass++; else { fail++; console.log("FAIL " + n + (d ? "\n  " + d : "")); } };

for (const f of ["anchor.js", "ollama.js"]) {
  ok(`core/${f} exists`, existsSync(join(CORE, f)));
  if (existsSync(join(CORE, f)) && existsSync(join(SRC, f))) {
    ok(`core/${f} matches the browser copy`,
       readFileSync(join(CORE, f)).equals(readFileSync(join(SRC, f))),
       "run tools/sync-core.sh");
  }
}

// the copies must stay free of anything that only exists in a browser
for (const f of ["anchor.js", "ollama.js"]) {
  const s = readFileSync(join(CORE, f), "utf8");
  ok(`core/${f} has no browser API`, !/\bbrowser\.|chrome\.|document\.|window\./.test(s));
}

// and must actually load and work under node
const { cleanTransformOutput, transformTimeoutMs, describeError } = await import(join(CORE, "ollama.js"));
const { anchorIssues } = await import(join(CORE, "anchor.js"));
ok("ollama.js loads under node", typeof cleanTransformOutput === "function");
ok("anchor.js loads under node", typeof anchorIssues === "function");
ok("anchoring still works", anchorIssues("I have recieve it",
     [{ original: "recieve", replacement: "received", type: "error", message: "sp" }],
     { categories: { error: true }, ignored: [] })[0].start, 7);
ok("timeout still scales", transformTimeoutMs(10269, { requestTimeoutMs: 90000 }) > 205000);
ok("errors still classified", describeError(new Error("HTTP 403")).kind === "cors");

console.log(pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
