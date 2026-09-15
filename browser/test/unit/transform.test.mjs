import { readFileSync } from "node:fs";
import {
  cleanTransformOutput,
  runnerOptions,
  estimateTransformTokens,
  buildTransformSystemPrompt,
  transformTimeoutMs,
  effectiveContext,
  looksTruncatedTransform,
  ASSUMED_CONTEXT
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

// ---------------------------------------------------------------- transformTimeoutMs
// A flat timeout is right for a paragraph and unreachable for ten pages: measured, a
// 10269-character selection needed 205s against a 90s default and could never succeed.

const S = { requestTimeoutMs: 90000 };
const secs = (chars) => transformTimeoutMs(chars, S) / 1000;

eq("a paragraph gets about the configured floor", secs(400) <= 110, true);
eq("never below the configured timeout", transformTimeoutMs(0, S) >= 90000, true);
eq("the measured ten-page case now fits", secs(10269) > 205, true);
eq("and is not absurdly generous either", secs(10269) < 900, true);
eq("grows with the selection", secs(8000) > secs(2000), true);
eq("respects a raised floor", transformTimeoutMs(400, { requestTimeoutMs: 300000 }) >= 300000, true);
eq("copes with a missing setting", transformTimeoutMs(1000, undefined) > 0, true);

// --- the context guard -------------------------------------------------------------------
// This used to run only when numCtx was pinned, and numCtx defaults to 0, so the shipped
// configuration allowed a transform about twice the size of the window it would run in.
// The window is read from /api/ps, not /api/show: show reports the architecture's maximum
// (262144 for qwen3.5), which would make every guard pass.
const withFetch = async (impl, fn) => {
  const real = globalThis.fetch;
  globalThis.fetch = impl;
  try { return await fn(); } finally { globalThis.fetch = real; }
};
const ps = (models) => async () => ({ ok: true, json: async () => ({ models }) });
const conf = (over = {}) => ({ endpoint: "http://x", model: "m", numCtx: 0, ...over });

eq("a pinned window wins and needs no request",
   await effectiveContext(conf({ numCtx: 8192 })),
   { tokens: 8192, source: "pinned" });

eq("an unpinned window is read from the loaded model",
   await withFetch(ps([{ model: "loaded-a", context_length: 16384 }]),
     () => effectiveContext(conf({ model: "loaded-a" }))),
   { tokens: 16384, source: "server" });

eq("a different model being loaded does not count",
   await withFetch(ps([{ model: "someone-else", context_length: 32768 }]),
     () => effectiveContext(conf({ model: "not-that-one" }))),
   { tokens: ASSUMED_CONTEXT, source: "assumed" });

eq("an unloaded model assumes Ollama's default rather than optimism",
   await withFetch(ps([]), () => effectiveContext(conf({ model: "not-loaded-b" }))),
   { tokens: ASSUMED_CONTEXT, source: "assumed" });

eq("an unreachable server also assumes the default",
   await withFetch(async () => { throw new Error("ECONNREFUSED"); },
     () => effectiveContext(conf({ model: "unreachable-c" }))),
   { tokens: ASSUMED_CONTEXT, source: "assumed" });

eq("the default maxChars really does overflow the assumed window",
   estimateTransformTokens(12000) > ASSUMED_CONTEXT, true);

// --- the truncation guard ------------------------------------------------------------------
const long = "word ".repeat(200);              // 1000 chars
eq("half the input is treated as truncation",
   looksTruncatedTransform(long, "word ".repeat(80), "polish"), true);
eq("a full rewrite is not",
   looksTruncatedTransform(long, "word ".repeat(190), "polish"), false);
eq("a trailing ellipsis the original lacks is truncation",
   looksTruncatedTransform(long, "word ".repeat(180) + "...", "polish"), true);
eq("but not when the original ends that way too",
   looksTruncatedTransform(long + "...", "word ".repeat(180) + "...", "polish"), false);
eq("asking to shorten legitimately returns much less",
   looksTruncatedTransform(long, "word ".repeat(20), "shorten it"), false);
eq("so does asking for a summary",
   looksTruncatedTransform(long, "word ".repeat(10), "summarise in one line"), false);
eq("and for bullet points",
   looksTruncatedTransform(long, "a", "turn into bullets"), false);
eq("short selections are left alone - the ratio is meaningless there",
   looksTruncatedTransform("Hello there.", "Hi.", "polish"), false);
eq("translation that shortens a little is fine",
   looksTruncatedTransform(long, "word ".repeat(120), "translate to French"), false);

console.log(pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
