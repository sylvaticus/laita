# -*- encoding: UTF-8 -*-
"""
Translation, for the hook Collabora calls DeepL.

Collabora's Translate button posts to whatever `deepl.api_url` names:

    POST <api_url>?tag_handling=html
    auth_key=...&target_lang=FR&text=<url-encoded HTML>

and reads `translations[0].text` out of the reply. The text is HTML, because the
selection is exported through the HTML filter - `<p>` swapped for `<span>` when it is a
single paragraph, which is how it avoids inserting a paragraph break. Translating a whole
document sends one request per paragraph; translating a selection sends one request.

Two things about the reading half decide the shape of this module.

**Nothing is waited on.** Unlike the LanguageTool call, which core cuts off at ten
seconds, the translate call sets no timeout at all - there is a `// todo add timeout` in
its place. So this can simply take as long as the model takes.

**An empty reply destroys the user's text.** The result is pasted back with
SwTransferable::Paste, and when the request fails or the JSON carries no translation the
caller returns an empty string and pastes THAT over the selection. It is a reported bug
in the DeepL integration itself. So the one rule here that is not negotiable:

    never return an empty translation - on any failure, return the original text,
    so that the paste is a no-op instead of a deletion.

That is the same bargain the rest of LAITA makes. The cost of returning the text
unchanged is a translation that did not happen and is visibly missing; the cost of
returning nothing is a paragraph silently deleted.

## What happens to the markup

Block structure is kept and inline formatting is dropped. `<p>`, `<li>`, `<td>` and
anything else unrecognised pass through untouched; `<b>`, `<i>`, `<a>`, `<span>` and the
rest are removed and their text translated as part of the sentence around them.

The model is never shown a tag and never asked to write one. It cannot then invent one,
drop one, or reorder them - and this path PASTES OVER the user's selection, so a model
that mangles markup here does not produce a bad suggestion, it produces damage. Inline
spans rarely survive a translation intact in any case: the words move.
"""
try:
    from html.parser import HTMLParser
    from html import escape
except ImportError:                       # pragma: no cover - python 2 never runs this
    from HTMLParser import HTMLParser
    from cgi import escape

# Removed, with their text kept and translated in place.
INLINE = frozenset((
    "a", "abbr", "b", "big", "cite", "code", "em", "font", "i", "kbd", "mark", "q", "s",
    "samp", "small", "span", "strike", "strong", "sub", "sup", "tt", "u", "var",
))

# Passed through verbatim, INCLUDING their text: translating a stylesheet or a script
# would be nonsense, and <head> is not what the user selected.
OPAQUE = frozenset(("head", "script", "style", "title"))

# DeepL names regional variants that the primary subtag alone would lose. Anything not
# here falls back to laita_ollama.LANGUAGE_NAMES on the primary subtag.
VARIANTS = {
    "en-gb": "British English", "en-us": "American English",
    "pt-br": "Brazilian Portuguese", "pt-pt": "European Portuguese",
    "zh-hans": "Simplified Chinese", "zh-hant": "Traditional Chinese",
}


def language_name(target_lang, names):
    """A DeepL target_lang as something to put in a prompt. `names` is
    laita_ollama.LANGUAGE_NAMES, passed in so this module imports nothing."""
    tag = str(target_lang or "").strip().lower()
    if not tag:
        return None
    if tag in VARIANTS:
        return VARIANTS[tag]
    return names.get(tag.split("-")[0], target_lang)


def instruction(language):
    """What to ask the model for. A translation is a transform with a fixed instruction,
    so this rides on laita_ollama.request_transform and inherits its fence against prompt
    injection, its output cleaning and its truncation guard."""
    return ("Translate the fragment into %s. Translate everything, including any text "
            "that is already in another language. Keep the meaning, the register and the "
            "tone. Do not explain, annotate or comment on the translation." % language)


class _Split(HTMLParser):
    """HTML into a list of parts: ("tag", raw) kept verbatim, ("text", s) to translate."""

    def __init__(self):
        try:
            HTMLParser.__init__(self, convert_charrefs=True)
        except TypeError:                 # pragma: no cover - older python
            HTMLParser.__init__(self)
        self.parts = []
        self._opaque = 0

    # Tags we drop leave NOTHING behind, so the text either side of them becomes one
    # run and is translated as one sentence rather than three fragments.
    def handle_starttag(self, tag, attrs):
        if tag in OPAQUE:
            self._opaque += 1
        elif tag in INLINE and not self._opaque:
            return
        self.parts.append(("tag", self.get_starttag_text() or "<%s>" % tag))

    def handle_endtag(self, tag):
        if tag in OPAQUE:
            self._opaque = max(0, self._opaque - 1)
        elif tag in INLINE and not self._opaque:
            return
        self.parts.append(("tag", "</%s>" % tag))

    def handle_startendtag(self, tag, attrs):
        # <br/> is a line break, not decoration: keeping it keeps the structure.
        if tag in INLINE and tag != "br" and not self._opaque:
            return
        self.parts.append(("tag", self.get_starttag_text() or "<%s/>" % tag))

    def handle_data(self, data):
        self.parts.append(("tag" if self._opaque else "text", data))

    def handle_comment(self, data):
        self.parts.append(("tag", "<!--%s-->" % data))

    def handle_decl(self, decl):
        self.parts.append(("tag", "<!%s>" % decl))

    def handle_pi(self, data):
        self.parts.append(("tag", "<?%s>" % data))

    def unknown_decl(self, data):
        self.parts.append(("tag", "<![%s]>" % data))


def split(html):
    """[(kind, value)] for `html`. Rebuilding it unchanged must give back the input's
    meaning, which test_translate.py checks against a corpus rather than assuming."""
    parser = _Split()
    parser.feed(html or "")
    parser.close()
    return parser.parts


def segments(parts):
    """[(indices, text)] - runs of adjacent text, which is a sentence once the inline
    tags between them are gone. Whitespace-only runs are not worth a model call."""
    out = []
    run, buf = [], []
    for i, (kind, value) in enumerate(parts):
        if kind == "text":
            run.append(i)
            buf.append(value)
        elif run:
            joined = "".join(buf)
            if joined.strip():
                out.append((run, joined))
            run, buf = [], []
    if run and "".join(buf).strip():
        out.append((run, "".join(buf)))
    return out


def _runs(parts):
    """{first index: every index} for each run of adjacent text."""
    runs, run = {}, []
    for i, (kind, _) in enumerate(parts):
        if kind == "text":
            run.append(i)
        elif run:
            runs[run[0]] = run
            run = []
    if run:
        runs[run[0]] = run
    return runs


def rebuild(parts, translations):
    """`parts` with each translated run put back in place of the original.

    `translations` maps a run's FIRST index to its translated text. The rest of that run
    collapses to nothing: the inline tags that separated those pieces are gone, so the
    run is one string now. Text the caller chose not to translate is emitted unchanged.

    The space around a run is preserved rather than translated. Models return their
    answer trimmed, and a lost leading space is a word joined to the previous one.
    """
    runs = _runs(parts)
    collapse = set()
    for first, indices in runs.items():
        if first in translations:
            collapse.update(indices[1:])

    out = []
    for i, (kind, value) in enumerate(parts):
        if kind == "tag":
            out.append(value)
        elif i in translations:
            whole = "".join(parts[j][1] for j in runs[i])
            lead = whole[:len(whole) - len(whole.lstrip())]
            tail = whole[len(whole.rstrip()):]
            out.append(lead + escape(translations[i].strip(), False) + tail)
        elif i not in collapse:
            out.append(escape(value, False))
    return "".join(out)
