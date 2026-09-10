import { readFileSync } from "node:fs";
import {
  cleanTransformOutput,
  transformNumCtx,
  buildTransformSystemPrompt
} from "../../src/background/ollama.js";

// common.js declares `var LAS`, so it has to be evaluated in the global sloppy scope.
(0, eval)(readFileSync(new URL("../../src/content/common.js", import.meta.url).pathname, "utf8"));
const LAS = globalThis.LAS;

let pass = 0, fail = 0;
const eq = (name, got, want) => {
  const a = JSON.stringify(got), b = JSON.stringify(want);
  if (a === b) pass++; else { fail++; console.log("FAIL " + name + "\n  got  " + a + "\n  want " + b); }
};

// ---------------------------------------------------------------- cleanTransformOutput

eq("plain answer untouched", cleanTransformOutput("I received your email."), "I received your email.");
eq("trims", cleanTransformOutput("  hello  "), "hello");
eq("drops a think block", cleanTransformOutput("<think>hmm</think>\nHello"), "Hello");
eq("drops an unpaired closing think", cleanTransformOutput("reasoning…</think>\nHello"), "Hello");
eq("unwraps a code fence", cleanTransformOutput("```\nHello there\n```"), "Hello there");
eq("unwraps a tagged fence", cleanTransformOutput("```text\nHello there\n```"), "Hello there");
eq("keeps a fence the input had", cleanTransformOutput("```\ncode\n```", "```\nold\n```"), "```\ncode\n```");
eq("drops a preamble", cleanTransformOutput("Here is the polished text:\nHello there"), "Hello there");
eq("drops a bare Sure:", cleanTransformOutput("Sure:\nHello"), "Hello");
eq("keeps a colon inside real prose", cleanTransformOutput("Note: this matters."), "Note: this matters.");
eq("strips wrapping quotes", cleanTransformOutput('"Hello there"'), "Hello there");
eq("strips guillemets", cleanTransformOutput("«Bonjour»"), "Bonjour");
eq("keeps quotes the input had", cleanTransformOutput('"Hello there"', '"Old text"'), '"Hello there"');
eq("keeps inner quotes", cleanTransformOutput('He said "no" to me'), 'He said "no" to me');
eq("keeps mismatched delimiters", cleanTransformOutput("'Hello\""), "'Hello\"");
eq("preserves internal newlines", cleanTransformOutput("- one\n- two"), "- one\n- two");
eq("empty stays empty", cleanTransformOutput(""), "");
eq("null stays empty", cleanTransformOutput(null), "");

// ---------------------------------------------------------------- transformNumCtx

eq("short text keeps the configured window", transformNumCtx(200, 4096), 4096);
eq("long text widens it", transformNumCtx(30000, 4096), 20800);
eq("never past the cap", transformNumCtx(500000, 4096), 32768);
eq("never below the configured value", transformNumCtx(10, 8192), 8192);
eq("bad config falls back", transformNumCtx(10, undefined), 4096);

// ---------------------------------------------------------------- the prompt

const sys = buildTransformSystemPrompt({ extraInstructions: "" }, "fr", "shorten it");
eq("prompt carries the instruction", sys.includes("shorten it"), true);
eq("prompt names the language", sys.includes("French"), true);
eq("prompt forbids commentary", /Return ONLY/.test(sys), true);
eq(
  "house rules are appended",
  buildTransformSystemPrompt({ extraInstructions: "Use British spelling." }, "en", "polish")
    .includes("Use British spelling."),
  true
);

// ---------------------------------------------------------------- appendSeparator

eq("space between two words", LAS.appendSeparator("hello", "world"), " ");
eq("nothing when the fragment already ends in space", LAS.appendSeparator("hello ", "world"), "");
eq("nothing when the addition starts with space", LAS.appendSeparator("hello", " world"), "");
eq("nothing when the fragment ends in a newline", LAS.appendSeparator("hello\n", "world"), "");
eq("blank line for a multi-line fragment", LAS.appendSeparator("a\nb", "c"), "\n\n");
eq("blank line for a multi-line addition", LAS.appendSeparator("a", "b\nc"), "\n\n");
eq("nothing to append", LAS.appendSeparator("hello", ""), "");

console.log(pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
