/**
 * What does chunkMaxChars actually buy, and what does it cost?
 *
 *   node tools/measure-chunking.mjs                 # everything
 *   node tools/measure-chunking.mjs --curve         # latency vs input length only
 *   node tools/measure-chunking.mjs --model qwen3.5:4b --repeats 3
 *
 * This asks a real Ollama using the extension's own prompt builders, runner options and
 * chunker, so the numbers describe the shipped path. It is not a unit test: it needs a
 * model and it is slow.
 *
 * WHY THE HEADLINE IS TOKENS AND NOT SECONDS. A first pass timed the wall clock only and
 * produced a curve with a cliff in it - 521 characters took 21s, 639 took 96s, with FEWER
 * issues found. The server's own counters showed both requests generated the SAME amount,
 * 390 tokens against 392, at 22.5 tok/s and then 4.3 tok/s. The text was never the
 * variable: this is a laptop GPU, and sustained generation drives it into SW Thermal
 * Slowdown and SW Power Cap - 1455 MHz against a 3105 MHz maximum, confirmed in
 * nvidia-smi while the run was in flight. Every measurement after the first minute ran at
 * under half clock.
 *
 * So seconds measure the machine's thermal state as much as the work, and any comparison
 * that runs A before B hands B a hotter GPU. Output tokens do not have that problem:
 * reading the input is nearly free here (0.2-1.2s for 426-810 input tokens, against
 * minutes of generation), so tokens generated IS the work. Seconds are still reported,
 * with the clock beside them so the drift is visible rather than hidden, and the
 * whole-vs-split comparison runs ABBA so that linear drift cancels instead of accumulating
 * in whichever arm goes second.
 *
 * THE TWO CASES PULL IN OPPOSITE DIRECTIONS, which is what the LibreOffice measurement
 * in doc/roadmap.md missed by looking at only one of them:
 *
 *   TYPING (checkScope "caret", the default, and VS Code's automatic check) sends exactly
 *   ONE chunk - the paragraph, or the piece of it holding the caret. A smaller
 *   chunkMaxChars means less text per keystroke, so splitting can only help.
 *
 *   A SWEEP (Alt+Shift+C, the toolbar button, checkScope "field", LibreOffice's "check
 *   this document") sends every chunk, and all three ports run them one at a time -
 *   Ollama serialises requests anyway. So a sweep pays the sum of the parts, and each
 *   part re-reads the whole ~1500-character system prompt. Splitting can only cost.
 *
 * Two samples, because error density and length are easy to confound: DENSE has a mistake
 * in almost every sentence, SPARSE has four in the whole thing. If latency tracks what
 * the model WRITES rather than what it reads, they will not have the same shape.
 */
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import {
  buildSystemPrompt, buildUserPrompt, runnerOptions, parseIssues, ISSUES_PREDICT_TOKENS,
  RESPONSE_SCHEMA
} from "../src/background/ollama.js";

const SRC = new URL("../src/", import.meta.url).pathname;
globalThis.LAITA = {};
eval(readFileSync(SRC + "content/segment.js", "utf8"));

const arg = (name, fallback) => {
  const i = process.argv.indexOf("--" + name);
  return i === -1 ? fallback : process.argv[i + 1];
};
const flag = (name) => process.argv.includes("--" + name);

const SETTINGS = {
  endpoint: arg("endpoint", "http://localhost:11434"),
  model: arg("model", "qwen3.5:9b"),
  temperature: 0,
  numCtx: 0,
  think: false,
  keepAlive: "30m",
  categories: { error: true, style: true, rephrase: true },
  dictionary: [],
  extraInstructions: ""
};
const REPEATS = Number(arg("repeats", 1));

/**
 * Both samples are built so that every prefix ending at a sentence boundary is itself a
 * valid sample: the sizes are prefixes of each other, which rules out "the long one
 * happened to contain harder text" as an explanation for any difference between them.
 */
const DENSE = [
  "The committee have agreed that the new policy will be implemented next quarter.",
  "Its important to note that these changes effects every department, not just the ones who asked for them.",
  "We was told the budget would be finalised by March, however the finance team has since revised there estimates upwards.",
  "Their is a growing concern amongst staff that the timeline is to ambitious given the resources currently available.",
  "In my personal opinion, I think that we should of consulted more widely before committing to a date.",
  "The report which was published last week contains a number of recommendations, some of which are quite controversial.",
  "Managers are being asked to review they're teams workload and report back by the end of the month.",
  "Its worth remembering that the previous rollout was delayed twice, and each delay costed the organisation considerable goodwill.",
  "A survey conducted amongst the affected teams found that less then half felt adequately informed about what was coming.",
  "The steering group meets fortnightly, and their minutes are circulated to all staff whom have registered an interest.",
  "Whilst nobody disputes the need for change, the manner in which it has been communicated leaves alot to be desired.",
  "Several colleagues has raised the point that training was promised but never scheduled.",
  "We would of preferred a phased approach, but the decision was taken above our level and there is little point revisiting it now.",
  "Going forward, the intention is that each team nominates a representative whom will attend the monthly review.",
  "This person will be responsible for feeding back concerns and for ensuring that local practice is aligned with the new guidance.",
  "It remains to be seen weather this arrangement will prove any more effective then the last one.",
  "The chief executive has stated publicly that she is committed to listening, and their have been some encouraging signs.",
  "Nevertheless, a degree of scepticism persists, particularly amongst those who have been through similar exercises before.",
  "The next update is due in six weeks, at which point we should have a clearer picture of where things stand.",
  "Until then, teams are asked to continue as normal and to raise any issues through the usual channels."
].join(" ");

const SPARSE = [
  "The committee has agreed that the new policy will be implemented next quarter.",
  "It is important to note that these changes affect every department, not only the ones that asked for them.",
  "We were told the budget would be finalised by March, although the finance team has since revised its estimates upwards.",
  "There is a growing concern among staff that the timeline is too ambitious given the resources currently available.",
  "Several people have suggested that we should of consulted more widely before committing to a date.",
  "The report published last week contains a number of recommendations, some of which are controversial.",
  "Managers are being asked to review their teams' workload and to report back by the end of the month.",
  "It is worth remembering that the previous rollout was delayed twice, and each delay cost the organisation considerable goodwill.",
  "A survey conducted among the affected teams found that fewer than half felt adequately informed about what was coming.",
  "The steering group meets fortnightly, and its minutes are circulated to all staff who have registered an interest.",
  "While nobody disputes the need for change, the manner in which it has been communicated leaves alot to be desired.",
  "Several colleagues have raised the point that training was promised but never scheduled.",
  "We would have preferred a phased approach, but the decision was taken above our level and there is little point revisiting it now.",
  "In future, the intention is that each team nominates a representative who will attend the monthly review.",
  "That person will be responsible for feeding back concerns and for ensuring that local practice aligns with the new guidance.",
  "It remains to be seen weather this arrangement will prove any more effective than the last.",
  "The chief executive has stated publicly that she is committed to listening, and there have been some encouraging signs.",
  "Nevertheless, a degree of scepticism persists, particularly among those who have been through similar exercises before.",
  "The next update is due in six weeks, at which point we should have a clearer picture of where things stand.",
  "Until then, teams are asked to continue as normal and to raise any issues through the usual channels."
].join(" ");

/**
 * SM clock and temperature, or nulls where there is no nvidia-smi. Sampled per request
 * because on a laptop it is not a constant, and a table of seconds without it is a table
 * of numbers nobody can reproduce.
 */
function gpu() {
  try {
    const out = execFileSync("nvidia-smi",
      ["--query-gpu=clocks.sm,temperature.gpu", "--format=csv,noheader,nounits"],
      { encoding: "utf8" }).trim().split("\n")[0];
    const [mhz, degC] = out.split(",").map((x) => Number(x.trim()));
    return { mhz, degC };
  } catch {
    return { mhz: null, degC: null };
  }
}

/** The longest prefix no longer than `n`, cut at a sentence boundary. */
function prefix(text, n) {
  if (text.length <= n) return text;
  return text.slice(0, text.lastIndexOf(". ", n) + 1);
}

/**
 * One request, built exactly as requestIssues builds it, but keeping the counters that
 * requestIssues throws away.
 */
async function ask(text, lang = "en") {
  const body = {
    model: SETTINGS.model,
    stream: false,
    think: !!SETTINGS.think,
    format: RESPONSE_SCHEMA,
    keep_alive: SETTINGS.keepAlive,
    options: runnerOptions(SETTINGS, { predictTokens: ISSUES_PREDICT_TOKENS }),
    messages: [
      { role: "system", content: buildSystemPrompt(SETTINGS, lang) },
      { role: "user", content: buildUserPrompt(text, lang) }
    ]
  };
  const t0 = Date.now();
  const res = await fetch(SETTINGS.endpoint.replace(/\/+$/, "") + "/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!res.ok) throw new Error("HTTP " + res.status + " " + (await res.text()).slice(0, 200));
  const j = await res.json();
  const g = gpu();
  return {
    ms: Date.now() - t0,
    mhz: g.mhz,
    degC: g.degC,
    issues: parseIssues(j?.message?.content ?? "").length,
    inTok: j.prompt_eval_count || 0,
    outTok: j.eval_count || 0,
    readMs: Math.round((j.prompt_eval_duration || 0) / 1e6),
    writeMs: Math.round((j.eval_duration || 0) / 1e6),
    truncated: j.done_reason === "length"
  };
}

/** A sweep: every chunk, one at a time, the way all three ports queue them. */
async function sweep(text, limit) {
  const chunks = LAITA.chunkText(text, limit, "en");
  const acc = { ms: 0, issues: 0, inTok: 0, outTok: 0, readMs: 0, writeMs: 0, truncated: 0 };
  for (const c of chunks) {
    const r = await ask(c.text);
    for (const k of ["ms", "issues", "inTok", "outTok", "readMs", "writeMs"]) acc[k] += r[k];
    acc.truncated += r.truncated ? 1 : 0;
  }
  const g = gpu();
  acc.mhz = g.mhz;
  acc.degC = g.degC;
  acc.chunks = chunks.length;
  return acc;
}

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};
const secs = (ms) => (ms / 1000).toFixed(1) + "s";
const pad = (v, n) => String(v).padStart(n);

async function repeat(fn) {
  const runs = [];
  for (let i = 0; i < REPEATS; i++) runs.push(await fn());
  const out = { runs };
  for (const k of Object.keys(runs[0])) {
    if (typeof runs[0][k] === "number") out[k] = median(runs.map((r) => r[k]));
  }
  return out;
}

function row(label, r) {
  const rate = r.writeMs ? (r.outTok / (r.writeMs / 1000)).toFixed(1) : "-";
  console.log("  %s | %s | %s | %s | %s | %s | %s | %s",
    pad(label, 11), pad(r.outTok, 7), pad(r.issues, 6),
    pad(r.inTok, 6), pad(secs(r.ms), 7), pad(rate, 6),
    pad(r.mhz == null ? "?" : r.mhz, 5), pad(r.degC == null ? "?" : r.degC, 4)
    + (r.truncated ? "  TRUNCATED" : ""));
}
const HEAD = "        size | out tok | issues | in tok |    time | tok/s |  MHz |  \u00b0C";

async function curve(name, text) {
  console.log("\n%s - latency vs input length, one whole request", name);
  console.log(HEAD);
  for (const n of [300, 550, 1000, 1400, text.length]) {
    const t = prefix(text, n);
    row(t.length, await repeat(() => ask(t)));
  }
}

async function main() {
  console.log("model: %s   endpoint: %s   repeats: %d",
    SETTINGS.model, SETTINGS.endpoint, REPEATS);
  console.log("DENSE: %d chars, a mistake in almost every sentence", DENSE.length);
  console.log("SPARSE: %d chars, four mistakes in total", SPARSE.length);
  console.log("num_predict: %d, response schema caps issues at 12", ISSUES_PREDICT_TOKENS);

  // The first request of a session pays for loading the weights; that cost would
  // otherwise land entirely on whichever measurement happened to run first.
  process.stdout.write("\nwarming up... ");
  console.log(secs((await ask(prefix(DENSE, 300))).ms));

  // --warm N: N seconds of continuous generation before measuring, so every row starts
  // from a GPU that has been working, not one that has just cooled down. On this laptop a
  // cool card is the FAST state (~30 tok/s) and sustained load is what throttles it -
  // measured down to 6 tok/s at 210 MHz after a couple of minutes - so a run without this
  // starts fast and slows as it goes, and its first rows are not comparable to its last.
  const warm = Number(arg("warm", 0));
  if (warm > 0) {
    const until = Date.now() + warm * 1000;
    let n = 0, last = null;
    while (Date.now() < until) { last = await ask(prefix(SPARSE, 700)); n++; }
    console.log("warmed for %ds (%d requests); now %s MHz, %s °C", warm, n,
      last ? last.mhz : "?", last ? last.degC : "?");
  }

  const only = ["curve", "sweep", "keystroke"].filter(flag);
  const want = (name) => only.length === 0 || only.includes(name);

  if (want("curve")) {
    await curve("DENSE", DENSE);
    await curve("SPARSE", SPARSE);
  }
  if (want("sweep")) {

  // What Alt+Shift+C, the toolbar button and "check this document" actually do.
  //
  // ABBA: whole, split, split, whole, averaging the pair from each arm. A laptop GPU
  // loses clock steadily under load, so A-then-B charges the whole of that drift to B -
  // which is exactly the shape of the "splitting is 4x slower" result in
  // doc/roadmap.md, measured on this machine with split always second. ABBA gives both
  // arms one early slot and one late one, so a linear drift cancels.
  for (const [name, text] of [["DENSE", DENSE], ["SPARSE", SPARSE]]) {
    console.log("\n%s - whole-field sweep: one request vs sequential chunks at 700 (ABBA)", name);
    console.log(HEAD);
    for (const n of [1400, text.length]) {
      const t = prefix(text, n);
      const w1 = await ask(t);
      const s1 = await sweep(t, 700);
      const s2 = await sweep(t, 700);
      const w2 = await ask(t);
      const mean = (a, b) => {
        const out = { ...a };
        for (const k of Object.keys(a)) {
          if (typeof a[k] === "number") out[k] = (a[k] + b[k]) / 2;
        }
        return out;
      };
      const whole = mean(w1, w2);
      const split = mean(s1, s2);
      row(t.length + " whole", whole);
      row(s1.chunks + "x split", split);
      console.log("             | %sx the tokens, %sx the issues, %sx the seconds",
        (split.outTok / whole.outTok).toFixed(2),
        whole.issues ? (split.issues / whole.issues).toFixed(2) : "n/a",
        (split.ms / whole.ms).toFixed(2));
    }
  }

  }
  if (!want("keystroke")) return;

  // One chunk, not all of them: what a keystroke in a long paragraph costs at each
  // setting. This is the case chunkMaxChars exists for, and the one the LibreOffice
  // measurement never looked at.
  for (const [name, text] of [["DENSE", DENSE], ["SPARSE", SPARSE]]) {
    console.log("\n%s - one keystroke mid-paragraph (caret scope sends ONE chunk)", name);
    console.log(HEAD);
    for (const limit of [300, 500, 700, 1200, 4000]) {
      const chunks = LAITA.chunkText(text, limit, "en");
      const mid = chunks[Math.floor(chunks.length / 2)];
      row(limit + "->" + mid.text.length, await repeat(() => ask(mid.text)));
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
