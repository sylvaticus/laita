import { readFileSync } from "node:fs";
import {
  cleanTransformOutput,
  runnerOptions,
  estimateTransformTokens,
  buildTransformSystemPrompt
} from "../../src/background/ollama.js";

// common.js declares `var LAITA`, so it has to be evaluated in the global sloppy scope.
(0, eval)(readFileSync(new URL("../../src/content/common.js", import.meta.url).pathname, "utf8"));
const LAITA = globalThis.LAITA;

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

// ---------------------------------------------------------------- runnerOptions
// num_ctx is a *runner* option: naming one makes Ollama load a separate copy of the
// model rather than reuse the resident one. So it must be absent unless asked for, and
// identical between proofreading and transforming.

eq("no context pinned means none is sent", runnerOptions({ temperature: 0, numCtx: 0 }), { temperature: 0 });
eq("missing setting means none is sent", runnerOptions({ temperature: 0 }), { temperature: 0 });
eq("a pinned context is sent", runnerOptions({ temperature: 0, numCtx: 8192 }), { temperature: 0, num_ctx: 8192 });
eq("a pinned string is honoured", runnerOptions({ temperature: 0, numCtx: "8192" }), { temperature: 0, num_ctx: 8192 });
eq("nonsense is treated as unpinned", runnerOptions({ temperature: 0, numCtx: "auto" }), { temperature: 0 });
eq("a negative context is treated as unpinned", runnerOptions({ temperature: 0, numCtx: -5 }), { temperature: 0 });
eq("temperature still travels", runnerOptions({ temperature: 0.7, numCtx: 0 }), { temperature: 0.7 });

// ---------------------------------------------------------------- estimateTransformTokens

eq("a short selection is cheap", estimateTransformTokens(300) < 1000, true);
eq("the estimate counts the rewrite too", estimateTransformTokens(3000) > 2 * (3000 / 3), true);
eq("a maximum-size selection needs a real window", estimateTransformTokens(12000) > 8000, true);
eq("it fits a 16k window", estimateTransformTokens(12000) < 16384, true);

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

eq("space between two words", LAITA.appendSeparator("hello", "world"), " ");
eq("nothing when the fragment already ends in space", LAITA.appendSeparator("hello ", "world"), "");
eq("nothing when the addition starts with space", LAITA.appendSeparator("hello", " world"), "");
eq("nothing when the fragment ends in a newline", LAITA.appendSeparator("hello\n", "world"), "");
eq("blank line for a multi-line fragment", LAITA.appendSeparator("a\nb", "c"), "\n\n");
eq("blank line for a multi-line addition", LAITA.appendSeparator("a", "b\nc"), "\n\n");
eq("nothing to append", LAITA.appendSeparator("hello", ""), "");

console.log(pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
