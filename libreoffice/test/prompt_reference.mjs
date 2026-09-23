// The JavaScript prompts, for the Python port to be compared against. The fence carries
// a random nonce, so the tag is injected here to make the comparison deterministic.
import {
  buildSystemPrompt, buildUserPrompt, languageName, parseIssues, PROMPT_VERSION,
  buildTransformSystemPrompt, buildTransformUserPrompt, cleanTransformOutput,
  looksTruncatedTransform, estimateTransformTokens, transformPredictTokens
} from "../../browser/src/background/ollama.js";

const SETTINGS = [
  { name: "all three categories",
    s: { categories: { error: true, style: true, rephrase: true }, dictionary: [], extraInstructions: "" } },
  { name: "errors only",
    s: { categories: { error: true, style: false, rephrase: false }, dictionary: [], extraInstructions: "" } },
  { name: "with a dictionary",
    s: { categories: { error: true, style: true, rephrase: true },
         dictionary: ["Ollama", "LAITA", "Lobianco"], extraInstructions: "" } },
  { name: "with house rules",
    s: { categories: { error: true, style: true, rephrase: true }, dictionary: [],
         extraInstructions: "Prefer British spelling.\nNever use exclamation marks." } },
  { name: "dictionary and house rules",
    s: { categories: { style: true }, dictionary: ["foo"], extraInstructions: "Be terse." } },
  // Over the 300-word cap, so the truncation itself is compared. Without this the cap
  // could differ between the two ports and no test would notice.
  { name: "dictionary past the cap",
    s: { categories: { error: true }, dictionary: Array.from({ length: 420 }, (_, i) => "word" + i),
         extraInstructions: "" } }
];
const LANGS = [undefined, "en", "en-GB", "fr", "it-IT", "zz", "JA"];
const PARSE = [
  '{"issues":[]}',
  '{"issues":[{"type":"error","original":"teh","replacement":"the","message":"typo"}]}',
  '```json\n{"issues":[{"type":"style","original":"a","replacement":"b","message":"m"}]}\n```',
  '<think>hmm let me see</think>{"issues":[]}',
  'Sure! Here you go: {"issues":[{"type":"error","original":"x","replacement":"y","message":"z"}]} hope that helps',
  '[{"type":"error","original":"p","replacement":"q","message":"r"}]',
  '{"notissues": 1}',
  '{"issues": "not an array"}'
];

const out = {
  promptVersion: PROMPT_VERSION,
  languageNames: LANGS.map((l) => [l ?? null, languageName(l)]),
  systemPrompts: [],
  userPrompts: LANGS.map((l) => [l ?? null, buildUserPrompt("Hello teh world.", l)]),
  parsed: PARSE.map((p) => {
    try { return { input: p, issues: parseIssues(p) }; }
    catch (e) { return { input: p, error: true }; }
  })
};
for (const { name, s } of SETTINGS) {
  for (const l of ["en", "fr"]) {
    out.systemPrompts.push({ name: `${name} / ${l}`, prompt: buildSystemPrompt(s, l) });
  }
}
// --- the transform half -------------------------------------------------------------
const INSTRUCTIONS = ["polish", "translate to French", "shorten it", "make it formal"];
const CLEAN = [
  ["plain answer", "Just the rewritten text.", "original"],
  ["a lead-in", "Here is the polished text:\nThe rewritten text.", "original"],
  ["a fence", "```\nThe rewritten text.\n```", "original"],
  ["a fence when the original had one", "```\nThe rewritten text.\n```", "a ``` original"],
  ["wrapped in quotes", '"The rewritten text."', "original"],
  ["quotes the original also had", '"The rewritten text."', '"original"'],
  ["thinking first", "<think>hmm</think>The rewritten text.", "original"],
  ["quotes inside, not wrapping", 'He said "no" to it.', "original"],
  ["an echoed closing fence", "The rewritten text.\nTEXT_3082eae76f9d", "original"],
  ["the whole fence echoed",
   "<<<TEXT_3082eae76f9d\nThe rewritten text.\nTEXT_3082eae76f9d>>>", "original"],
  ["a fence-shaped word inside prose", "He wrote TEXT_3082eae76f9d in the middle.", "original"]
];
const LONG = "word ".repeat(200);
const TRUNC = [
  ["half length", LONG, "word ".repeat(80), "polish"],
  ["full rewrite", LONG, "word ".repeat(190), "polish"],
  ["trailing ellipsis", LONG, "word ".repeat(180) + "...", "polish"],
  ["ellipsis both sides", LONG + "...", "word ".repeat(180) + "...", "polish"],
  ["asked to shorten", LONG, "word ".repeat(20), "shorten it"],
  ["asked to summarise", LONG, "word ".repeat(10), "summarise in one line"],
  ["short input", "Hello there.", "Hi.", "polish"]
];

out.transformSystemPrompts = [];
for (const instruction of INSTRUCTIONS) {
  for (const { name, s } of SETTINGS.slice(0, 4)) {
    out.transformSystemPrompts.push({
      name: `${name} / ${instruction}`,
      prompt: buildTransformSystemPrompt(s, "en", instruction)
    });
  }
}
out.transformUserPrompt = buildTransformUserPrompt("Hello teh world.");
out.cleaned = CLEAN.map(([name, content, original]) =>
  ({ name, out: cleanTransformOutput(content, original) }));
out.truncated = TRUNC.map(([name, a, b, i]) =>
  ({ name, out: looksTruncatedTransform(a, b, i) }));
out.tokens = [0, 1, 50, 500, 9000, 12000].map((n) =>
  [n, estimateTransformTokens(n), transformPredictTokens(n)]);

process.stdout.write(JSON.stringify(out, null, 1));
