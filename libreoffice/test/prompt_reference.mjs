// The JavaScript prompts, for the Python port to be compared against. The fence carries
// a random nonce, so the tag is injected here to make the comparison deterministic.
import {
  buildSystemPrompt, buildUserPrompt, languageName, parseIssues, PROMPT_VERSION
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
process.stdout.write(JSON.stringify(out, null, 1));
