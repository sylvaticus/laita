/**
 * The popup and the content script have to agree, and nothing else checks that they do.
 *
 * Everything the right-click menu offers is reachable from the toolbar popup as well,
 * because a page can replace its own context menu - Overleaf does - and then the menu
 * simply never appears. The popup is browser chrome and no page can touch it.
 *
 * These are string contracts across a message boundary: a typo in either half fails at
 * runtime, on one kind of page, with nothing in the console. Cheap to pin, so pin them.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = new URL("../../src/", import.meta.url).pathname;
const read = (p) => readFileSync(join(SRC, p), "utf8");

let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => {
  if (cond) pass++; else { fail++; console.log("FAIL " + name + (detail ? "\n  " + detail : "")); }
};

const popupJs = read("popup/popup.js");
const popupHtml = read("popup/popup.html");
const contentMain = read("content/main.js");
const transform = read("content/transform.js");

// --- every message the popup sends must be handled in the page ---------------------------
const sent = [...popupJs.matchAll(/sendMessage\(tab\.id,\s*\{\s*cmd:\s*"([a-zA-Z]+)"/g)]
  .map((m) => m[1]);
ok("the popup sends some messages", sent.length > 0, sent.join(", "));
for (const cmd of [...new Set(sent)]) {
  ok(`content/main.js handles "${cmd}"`, contentMain.includes(`msg.cmd === "${cmd}"`));
}

// --- the actions the context menu offers must also be in the popup -----------------------
ok("the popup can start a transform", sent.includes("transformSelection"));
ok("the popup can ask what is selected", sent.includes("peekSelection"));
ok("peekSelection is answered by Transform.peek", /peekSelection[\s\S]{0,120}Transform\.peek\(\)/.test(contentMain));
ok("Transform.peek exists", /\bpeek\(\)\s*\{/.test(transform));
ok("peek does not leave an adapter behind",
   /peek\(\)[\s\S]*?t\.owned[\s\S]*?destroy\(\)/.test(transform));

// --- every element the popup script reaches for must exist in its markup -----------------
const ids = [...new Set([...popupJs.matchAll(/\$\("([A-Za-z]+)"\)/g)].map((m) => m[1]))];
ok("the popup script uses some ids", ids.length > 0);
for (const id of ids) {
  ok(`popup.html defines #${id}`, popupHtml.includes(`id="${id}"`), ids.join(", "));
}

// --- pausing is reachable without the context menu too ------------------------------------
ok("the popup carries the per-site toggle", popupHtml.includes('id="site"'));
ok("...and names its keyboard shortcut", /id="site"[\s\S]{0,200}Alt\+Shift\+X/.test(popupHtml));
ok("...and the transform button names its own", /id="transform"[\s\S]{0,120}Alt\+Shift\+T/.test(popupHtml));

console.log(pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
