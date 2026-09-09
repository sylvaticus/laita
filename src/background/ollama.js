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
