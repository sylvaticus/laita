/** Prompt construction, Ollama transport, and validation of what the model gives back. */

/** Bump when the prompt changes so stale cache entries are discarded. */
export const PROMPT_VERSION = 4;

const LANGUAGE_NAMES = {
  en: "English", fr: "French", it: "Italian", es: "Spanish", de: "German",
  pt: "Portuguese", nl: "Dutch", ca: "Catalan", ro: "Romanian", pl: "Polish",
  sv: "Swedish", da: "Danish", nb: "Norwegian", no: "Norwegian", fi: "Finnish",
  cs: "Czech", el: "Greek", ru: "Russian", tr: "Turkish", ja: "Japanese",
  zh: "Chinese", ko: "Korean", ar: "Arabic", he: "Hebrew", hi: "Hindi"
};

export function languageName(code) {
  if (!code) return "the language of the text";
  return LANGUAGE_NAMES[String(code).toLowerCase().split("-")[0]] || code;
}

const RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    issues: {
      type: "array",
      items: {
        type: "object",
        properties: {
          original: { type: "string" },
          replacement: { type: "string" },
          type: { type: "string", enum: ["error", "style", "rephrase"] },
          message: { type: "string" }
        },
        required: ["original", "replacement", "type", "message"]
      }
    }
  },
  required: ["issues"]
};

export function buildSystemPrompt(settings, lang) {
  const L = languageName(lang);
  const wanted = Object.entries(settings.categories)
    .filter(([, on]) => on)
    .map(([k]) => k);

  const catDocs = {
    error:
      '- "error": objectively wrong. Spelling, agreement, conjugation, wrong preposition, ' +
      "punctuation, capitalisation, doubled words, missing words.",
    style:
      '- "style": not wrong, but weak. Wordiness, redundancy, needless passive voice, ' +
      "register mismatch, run-on sentences, clumsy repetition.",
    rephrase:
      '- "rephrase": a better word or a clearer formulation. Vocabulary upgrade, ' +
      "more idiomatic or more natural phrasing."
  };

  const lines = [
    `You are a meticulous proofreader working in ${L}. You receive a fragment of text that a`,
    `user is typing into a web form. You report writing problems as JSON.`,
    ``,
    `Report only these categories:`,
    ...wanted.map((c) => catDocs[c]),
    ``,
    `Hard rules:`,
    `- "original" MUST be an exact, verbatim, contiguous substring of the input, copied`,
    `  character for character including its capitalisation and accents. Keep it as short as`,
    `  possible while still unambiguous, normally a few words.`,
    `- "replacement" MUST be a drop-in replacement for "original": substituting one for the`,
    `  other must produce correct text. If you cannot give a concrete replacement, drop the issue.`,
    `- "message" is a short explanation, at most 12 words, written in ${L}.`,
    `- Never flag proper nouns, brand names, technical jargon, URLs, code, placeholders, or a`,
    `  missing full stop at the very end of the fragment.`,
    `- The fragment may start or end mid-thought because it was cut out of a longer text. Never`,
    `  flag that as an error.`,
    `- Never rewrite the whole text, never translate it, never add content of your own.`,
    `- Report at most 12 issues, the most important ones first.`,
    `- If the text is fine, return {"issues": []}.`
  ];

  if (settings.dictionary?.length) {
    lines.push(
      ``,
      `Always treat these as correctly spelled and never flag them: ` +
        settings.dictionary.slice(0, 300).join(", ")
    );
  }
  if (settings.extraInstructions?.trim()) {
    lines.push(``, `Additional house rules:`, settings.extraInstructions.trim());
  }
  return lines.join("\n");
}

/**
 * The options sent with every request.
 *
 * `num_ctx` is deliberately omitted unless the user pinned one: it is a *runner* option,
 * so Ollama treats the same model at two context sizes as two things to load. Leaving it
 * out means sharing whatever runner is already resident instead of evicting it. Whatever
 * this returns must be identical for proofreading and transforming, or the extension
 * would fight itself the same way.
 */
export function runnerOptions(settings) {
  const options = { temperature: Number(settings.temperature) || 0 };
  const pinned = Number(settings.numCtx) || 0;
  if (pinned > 0) options.num_ctx = pinned;
  return options;
}

/**
 * How long to allow a transform, in milliseconds.
 *
 * A transform emits roughly as much text as it consumes, so the work scales with the
 * selection while a flat timeout does not: measured on one machine, a paragraph took 4
 * seconds and ten pages took 205, against a 90 second default that could never be met
 * however many times the user retried. Generation also slows as the output grows - 31
 * tokens/second for a short answer, 10 for a long one - so the allowance is per expected
 * output token, at a rate pessimistic enough to cover a slower machine.
 *
 * The configured timeout stays the floor: it is what covers loading the model and
 * processing the prompt, neither of which scales the same way.
 */
const TRANSFORM_TOKENS_PER_SEC = 5;

export function transformTimeoutMs(textLength, settings) {
  const floor = Number(settings?.requestTimeoutMs) || 90000;
  const outputTokens = Math.ceil(Number(textLength) / 4);   // English averages ~4 chars/token
  return floor + Math.ceil(outputTokens / TRANSFORM_TOKENS_PER_SEC) * 1000;
}

/** Rough token cost of transforming `textLength` characters: the fragment, then its
 *  rewrite, plus the prompt. Only used to refuse a transform that cannot fit a pinned
 *  context, rather than let the model silently truncate it. */
export function estimateTransformTokens(textLength) {
  return Math.ceil((textLength / 3) * 2) + 400;
}

export function buildUserPrompt(text, lang) {
  return (
    `Proofread this ${languageName(lang)} text:\n` +
    `<<<TEXT\n${text}\nTEXT>>>`
  );
}

/**
 * Ask the model about one chunk of text.
 * Returns the raw (unvalidated) issue list, or throws.
 */
export async function requestIssues({ text, lang, settings, signal }) {
  const url = settings.endpoint.replace(/\/+$/, "") + "/api/chat";
  const body = {
    model: settings.model,
    stream: false,
    think: !!settings.think,
    format: RESPONSE_SCHEMA,
    keep_alive: settings.keepAlive,
    options: runnerOptions(settings),
    messages: [
      { role: "system", content: buildSystemPrompt(settings, lang) },
      { role: "user", content: buildUserPrompt(text, lang) }
    ]
  };

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal
  });

  if (!res.ok) {
    const detail = (await res.text().catch(() => "")).slice(0, 300);
    throw new Error(`Ollama returned HTTP ${res.status}. ${detail}`);
  }

  const json = await res.json();
  const content = json?.message?.content ?? "";
  return parseIssues(content);
}

/** Tolerant JSON extraction: models occasionally wrap the object in prose or a code fence. */
export function parseIssues(content) {
  let raw = String(content).replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
  raw = raw.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();

  let obj = null;
  try {
    obj = JSON.parse(raw);
  } catch {
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        obj = JSON.parse(raw.slice(start, end + 1));
      } catch {
        /* fall through */
      }
    }
  }
  if (!obj) throw new Error("Could not parse the model's answer as JSON.");
  const issues = Array.isArray(obj) ? obj : obj.issues;
  return Array.isArray(issues) ? issues : [];
}

/**
 * Reachability + model-presence probe used by the popup and the options page.
 *
 * A plain GET carries no Origin header, so it would sail past Ollama's origin check even
 * when the POST that does the real work is refused. The probe therefore ends with a POST,
 * so that "connection OK" means the same thing proofreading needs.
 */
export async function probe(settings) {
  const base = settings.endpoint.replace(/\/+$/, "");

  const res = await fetch(base + "/api/tags", { method: "GET" });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${base}/api/tags`);
  const json = await res.json();
  const models = (json.models || []).map((m) => m.name);

  const post = await fetch(base + "/api/show", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: settings.model })
  });
  // 404 just means the model is missing, which the caller reports separately.
  if (!post.ok && post.status !== 404) {
    throw new Error(`HTTP ${post.status} from ${base}/api/show`);
  }

  return { models, hasModel: models.includes(settings.model) };
}

// ------------------------------------------------------------------ error handling

/**
 * Is this worth trying again?
 *
 * Ollama answers 500 when its model runner has to be started and does not come up in
 * time - routine on a machine where the model only just fits in VRAM. The failed attempt
 * has usually kicked the load off, so the second one tends to succeed. A refused origin,
 * a missing model or a request we aborted ourselves will never get better by repeating.
 */
export function isTransient(err) {
  if (err?.stale || err?.name === "AbortError") return false;
  const msg = String(err?.message || err);
  if (/HTTP (500|502|503|504)/.test(msg)) return true;
  return /NetworkError|Failed to fetch|ECONNREFUSED|network/i.test(msg);
}

const LOAD_FAILURE = /llama-server|load failed|unable to load|out of memory|no such file|runner/i;

/** The origin this build actually sends, so the 403 advice is right on each surface.
 *  Chrome sends chrome-extension://<id>, Firefox moz-extension://<uuid>, and the VS Code
 *  host is Node and sends no Origin at all - where the old hardcoded moz-extension advice
 *  was not merely unhelpful but nonsense. */
function originHint() {
  try {
    const url = globalThis.browser?.runtime?.getURL?.("");
    if (url) {
      const { protocol, origin } = new URL(url);
      return protocol === "moz-extension:" ? '"moz-extension://*"' : `"${origin}"`;
    }
  } catch {
    /* fall through to the wildcard */
  }
  return '"moz-extension://*,chrome-extension://*"';
}

/** Turn whatever went wrong into something the user can act on. */
export function describeError(err) {
  if (err?.stale) return { ok: false, stale: true };
  const msg = String(err?.message || err);
  if (err?.name === "AbortError") {
    return {
      ok: false,
      kind: "timeout",
      error:
        "The request to Ollama timed out. A large model on a busy GPU can need longer - " +
        "raise the timeout in the options, or use a smaller model."
    };
  }
  if (/NetworkError|Failed to fetch|ECONNREFUSED|network/i.test(msg)) {
    return {
      ok: false,
      kind: "connection",
      error:
        "Cannot reach Ollama. Check that `ollama serve` is running and that the endpoint " +
        "in Local AI Text Assistant's options is correct."
    };
  }
  if (/HTTP 403/.test(msg)) {
    return {
      ok: false,
      kind: "cors",
      error:
        "Ollama refused the request because it came from a browser extension. Allow it once " +
        `with OLLAMA_ORIGINS=${originHint()} and restart Ollama - see the README.`
    };
  }
  if (/HTTP 404/.test(msg)) {
    return { ok: false, kind: "model", error: "Ollama does not have that model. Run `ollama pull <model>`." };
  }
  if (/HTTP 5\d\d/.test(msg)) {
    return {
      ok: false,
      kind: "server",
      error: LOAD_FAILURE.test(msg)
        ? "Ollama could not start the model. That usually means it does not fit in the GPU " +
          "alongside what else is running - try a smaller model, or raise \"Keep model loaded " +
          "for\" in the options so it reloads less often."
        : "Ollama failed on this request. " + msg.slice(0, 200)
    };
  }
  return { ok: false, kind: "other", error: msg };
}

// ------------------------------------------------------------------ transform

/**
 * Free-form transformation of a selected fragment ("polish", "translate to French",
 * "shorten it"). Unlike proofreading this returns prose, not JSON: the model is asked for
 * the rewritten fragment and nothing else, and `cleanTransformOutput` undoes the wrappers
 * it adds anyway.
 */
export function buildTransformSystemPrompt(settings, lang, instruction) {
  const L = languageName(lang);
  const lines = [
    `You rewrite a fragment of text that a user has selected in a web page.`,
    ``,
    `The user's instruction is:`,
    instruction,
    ``,
    `Hard rules:`,
    `- Return ONLY the rewritten fragment. No preamble, no explanation, no commentary, no`,
    `  quotation marks around it and no markdown code fence.`,
    `- Carry out the instruction and nothing else. Never add facts, opinions or content of`,
    `  your own, and never answer the fragment as if it were a question addressed to you.`,
    `- Keep the fragment in ${L} unless the instruction asks for another language.`,
    `- Preserve its formatting: line breaks, list markers, indentation, and any markup,`,
    `  code or placeholders it contains.`,
    `- It may start or end mid-sentence because it was cut out of a longer text. Leave it`,
    `  that way: do not complete it and do not add a full stop of your own.`,
    `- If the instruction cannot sensibly be applied, return the fragment unchanged.`
  ];
  if (settings.extraInstructions?.trim()) {
    lines.push(``, `Additional house rules:`, settings.extraInstructions.trim());
  }
  return lines.join("\n");
}

export function buildTransformUserPrompt(text) {
  return `<<<TEXT\n${text}\nTEXT>>>`;
}

const QUOTE_PAIRS = { '"': '"', "'": "'", "«": "»", "“": "”" };

/** The quote character a string is wrapped in, if the whole string is wrapped in one. */
function wrapper(s) {
  const open = s[0];
  const close = s[s.length - 1];
  if (s.length <= 2 || QUOTE_PAIRS[open] !== close) return null;
  return s.slice(1, -1).includes(close) ? null : open;
}

/**
 * Strip the packaging models put around a plain-text answer.
 * `original` is the fragment that was sent: anything it already had (a code fence, its own
 * surrounding quotes) is left alone, so a legitimately quoted selection survives.
 */
export function cleanTransformOutput(content, original = "") {
  let out = String(content ?? "")
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/^[\s\S]*?<\/think>/i, (m) => (/<think>/i.test(m) ? m : ""))
    .trim();

  const fence = out.match(/^```[a-zA-Z0-9_+-]*[ \t]*\n([\s\S]*?)\n?```$/);
  if (fence && !original.includes("```")) out = fence[1].trim();

  out = out.replace(
    /^(?:sure|certainly|of course|here(?:'s| is| are)[^\n:]*|the (?:rewritten|transformed|revised|polished|corrected|shortened|translated)[^\n:]*)\s*:[ \t]*\n+/i,
    ""
  );

  const quote = wrapper(out);
  if (quote && wrapper(original) !== quote) out = out.slice(1, -1).trim();

  return out;
}

/** Ask the model to transform one fragment. Returns the cleaned text, or throws. */
export async function requestTransform({ text, instruction, lang, settings, signal }) {
  const url = settings.endpoint.replace(/\/+$/, "") + "/api/chat";
  const body = {
    model: settings.model,
    stream: false,
    think: !!settings.think,
    keep_alive: settings.keepAlive,
    options: runnerOptions(settings),
    messages: [
      { role: "system", content: buildTransformSystemPrompt(settings, lang, instruction) },
      { role: "user", content: buildTransformUserPrompt(text) }
    ]
  };

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal
  });

  if (!res.ok) {
    const detail = (await res.text().catch(() => "")).slice(0, 300);
    throw new Error(`Ollama returned HTTP ${res.status}. ${detail}`);
  }

  const json = await res.json();
  const output = cleanTransformOutput(json?.message?.content ?? "", text);
  if (!output) throw new Error("The model returned an empty answer.");
  return output;
}
