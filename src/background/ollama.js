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
    think: settings.think ? undefined : false,
    format: RESPONSE_SCHEMA,
    keep_alive: settings.keepAlive,
    options: {
      temperature: Number(settings.temperature) || 0,
      num_ctx: Number(settings.numCtx) || 4096
    },
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

/**
 * A transform emits roughly as much text as it consumes, and both have to fit next to the
 * prompt. The proofreading context window is sized for a single paragraph, so widen it for
 * long selections rather than letting the model silently truncate its own answer.
 */
export function transformNumCtx(textLength, configured) {
  const base = Number(configured) || 4096;
  const needed = Math.ceil((textLength / 3) * 2) + 800;
  return Math.max(base, Math.min(needed, 32768));
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
    think: settings.think ? undefined : false,
    keep_alive: settings.keepAlive,
    options: {
      temperature: Number(settings.temperature) || 0,
      num_ctx: transformNumCtx(text.length, settings.numCtx)
    },
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
