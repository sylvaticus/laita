# LAITA as a LanguageTool server

A small HTTP service that speaks the [LanguageTool API](https://languagetool.org/http-api/)
and answers from your own Ollama. Anything that can be pointed at a LanguageTool server
gets LAITA's proofreading without installing anything: Collabora Online, LibreOffice
desktop, and the several editors that have a LanguageTool setting.

It exists because **Collabora Online cannot use the `.oxt`**. The CODE container has no
working `unopkg add --shared`, and Collabora draws its own interface in the browser, so an
`Addons.xcu` toolbar and an `.xdl` dialog have nowhere to appear. What Collabora *does*
have is a LanguageTool client, configured once by the administrator and active for every
user.

`doc/roadmap.md` rejected the LanguageTool protocol for the desktop extension because it
has no slot for a transform. That is still true. It costs nothing here, on a surface where
the transform was never reachable anyway.

**Deploying this to a Nextcloud + Collabora installation is a separate, step-by-step
document: [`DEPLOY.md`](DEPLOY.md).** This file is the design and the reasoning.

## Running it

```bash
src/laita_lt_server.py                      # 127.0.0.1:8181, defaults, logs to stderr
src/laita_lt_server.py -c laita-lt.json     # with a configuration file
```

It says at startup whether Ollama is reachable and whether it has the model, because the
alternative is a server that looks healthy and answers every check with nothing.

```
LAITA LanguageTool 0.1.0 starting on 127.0.0.1:8181
model qwen3.5:9b at http://localhost:11434, chunk 700, debounce 1500ms
Ollama reachable, model present
```

`GET /status` reports the same plus cache hits and whether the model is busy. `POST
/v2/check` takes `text` and `language`; `GET /v2/languages` lists what it advertises.

**`/v2/languages` advertises, it does not gate.** Nothing in the check path consults it: a
request naming a language absent from the list is proofread in that language anyway,
because the prompt simply says what the client said. The list defaults to every language
`laita_ollama.LANGUAGE_NAMES` can name — derived from that table rather than restated, so
the two cannot drift apart — and LibreOffice does not read the endpoint at all, taking its
locale list from its own linguistic configuration. Set `languages` only if some client
insists on region variants such as `fr-FR`.

### Configuration

One JSON file, read once at start, applying to everybody. The proofreading settings are
the extension's own `DEFAULTS` — imported, not restated, so the default model changes in
one place — plus a few that only a server needs:

```json
{
  "host": "172.17.0.1",
  "port": 8181,
  "model": "qwen3.5:9b",
  "endpoint": "http://127.0.0.1:11434",
  "categories": {"error": true, "style": true, "rephrase": false},
  "extraInstructions": "This is academic writing about agriculture and forestry.",
  "dictionary": ["LAITA", "Lorraine", "agroforesterie"],
  "logFile": "/var/log/laita-languagetool.log"
}
```

A setting the file names but the server does not understand is an **error**, not a shrug.
The extension degrades to defaults deliberately — raising inside LibreOffice becomes a
modal dialog on every keystroke — but a server that silently ignores `chunkMaxChar` costs
someone an afternoon. Settings that need a cursor (`scope`, `checkAsYouType`, `transform*`)
are refused with a message saying why rather than accepted and ignored.

`LAITA_LT_HOST`, `LAITA_LT_PORT`, `LAITA_LT_MODEL`, `LAITA_LT_ENDPOINT` and
`LAITA_LT_API_KEY` override the file, for a unit file or a container. Everything else
belongs in the JSON, where it can carry a comment about why.

### Pointing Collabora Online at it

Two `--o:` options on coolwsd, which the container takes through `extra_params`:

```
--o:languagetool.enabled=true
--o:languagetool.base_url=http://172.17.0.1:8181/v2
```

`base_url` carries no `/check` suffix: LibreOffice appends it. `172.17.0.1` is the host on
the `docker0` bridge — the container cannot reach the host's loopback, so the server has to
bind to the bridge address, and on a host with a default-deny `INPUT` chain the bridge also
needs letting through:

```bash
iptables -A INPUT -i docker0 -d 172.17.0.1 -p tcp --dport 8181 -j ACCEPT
```

Without it the connection is *dropped*, not refused, so every check hangs for the client's
full ten seconds instead of failing quickly. That is worth recognising: it looks like a slow
model, not a firewall.

Set `apiKey` in the configuration and pass `--o:languagetool.api_key=` the same value if the
service has to sit anywhere less private. It is the only authentication the protocol has.

### As a systemd service

```bash
sudo tools/install.sh --host 172.17.0.1 --port 8181
```

Writes `/etc/laita/languagetool.json` and a `laita-languagetool.service` that runs the
server out of this checkout. It does not copy the code: the service reuses
`libreoffice/src/pythonpath/`, so the repository has to stay where it is, or
`LAITA_SHARED_PATH` has to say where those modules went.

## Translation, through the DeepL hook

Collabora has a second hook: `deepl.api_url`, behind the Translate entry in the Tools
menu. Point it here and translation runs on the same local model, with no DeepL account
and nothing leaving the machine.

```
--o:deepl.enabled=true
--o:deepl.api_url=http://172.17.0.1:8181/v2/translate
--o:deepl.auth_key=<anything, or the apiKey you configured>
```

Unlike `languagetool.base_url`, `api_url` is the **whole endpoint**, not a base — the
DeepL default it replaces is `https://api-free.deepl.com/v2/translate`.

A translation is a transform with a fixed instruction, so it rides on
`laita_ollama.request_transform` and inherits the fence against prompt injection, the
output cleaning and the truncation guard the extension's *Transform selection* already
uses. It does **not** go through the `Engine`: proofreading is automatic, cached and
debounced, a translation is one thing a person asked for once. Nothing in LAITA lets those
two share a code path.

### The rule that cannot break

The reply is pasted back over the user's selection with `SwTransferable::Paste`, and when
the request fails core pastes **an empty string** — that is a
[reported bug](https://forum.collaboraonline.com/t/deepl-integration-removes-text-to-be-translated/3341)
in the real DeepL integration, and it is not ours to reproduce. So:

> **Never return an empty translation.** Every failure returns the *original* text, so the
> paste is a no-op instead of a deletion.

That includes a model that is down, that returns whitespace, that raises, a missing target
language, a wrong `auth_key`, and translation being switched off. All of them answer HTTP
200 carrying the text unchanged — a 4xx would make core paste nothing. A wrong key costs a
model call, not a paragraph. `test_translate.py` asserts it from each of those directions.

Two more consequences of the reply being pasted rather than displayed: the model's output
is HTML-escaped on the way out, so anything tag-shaped in its answer lands as text rather
than as structure; and there is no timeout to respect, because core sets none on this call
(`// todo add timeout`) — unlike the ten seconds it allows a grammar check.

### What happens to the markup

The text arrives as HTML, because the selection is exported through the HTML filter.
Block structure is kept and inline formatting is dropped: `<p>`, `<li>`, `<td>` and
anything unrecognised pass through untouched, while `<b>`, `<i>`, `<a>` and `<span>` are
removed and their text translated as part of the sentence around them.

The model is never shown a tag and never asked to write one, so it cannot invent, drop or
reorder them. DeepL's own `tag_handling=html` preserves markup because DeepL guarantees
it; a local model does not, and this path pastes over the user's work. Inline spans rarely
survive a translation intact anyway — the words move.

One case worth knowing: a single paragraph arrives wrapped in `<span>` rather than `<p>`,
which is how Collabora avoids inserting a paragraph break. `<span>` is inline, so it is
dropped, and the property is preserved by accident of the rule rather than by a special
case.

## Can this be used as a general LanguageTool server for other programs?

Partly. It speaks the protocol — `POST /v2/check` with `text` and `language`, `GET
/v2/languages` — so anything that can be pointed at a LanguageTool server can talk to it.
**Desktop LibreOffice 7.4 or newer works with it unchanged**, since Collabora and desktop
LibreOffice run the same client code: point the LanguageTool Server settings page in
Options at the same `base_url`.

Beyond that family, four things are shaped for a client that re-sends text as somebody
types, and they are worth knowing before assuming it is a drop-in replacement.

**A client that submits text once will get nothing back.** This is the important one.
`scope: "typed"` infers "somebody is editing this" from the same paragraph arriving
repeatedly; a tool that submits a document once — a command-line checker, a mail client
checking on send, a CI lint step — is a permanent first sighting and is answered `not being
edited`, with no matches, forever. Such clients need `scope: "document"`.

**The category ids are chosen for their colour, not their meaning.** `style` goes out as
`GRAMMAR` and `rephrase` as `STYLE`, purely because that is what yields orange and blue in
LibreOffice's fixed table. A client that displays the category name will show something
odd. There is no setting for this yet.

**The last word of an unpunctuated paragraph is not checked**, because
`laita_lt_typing.without_part_typed_word` assumes it is a word still being typed. Right
while typing, wrong for checking a finished document.

**Only `text` is accepted, not `data`.** The real API takes either, `data` being a JSON
object carrying `text` or `annotation` (text with markup). Clients that use `data` —
including the official LanguageTool browser add-on — would get nothing. There is also no
`/v2/words` (personal dictionaries), and `enabledRules`/`disabledRules` and the other rule
selection parameters are ignored rather than honoured.

So: a drop-in replacement for LibreOffice-family clients, and a conditional one elsewhere.
None of the four is hard to fix; none has been, because nothing has needed it yet.

## The constraint that shapes all of it

**LibreOffice sets `CURLOPT_TIMEOUT` to 10 seconds on this call** and does not make it
configurable (`lingucomponent/source/spellcheck/languagetool/languagetoolimp.cxx`). A
paragraph takes this model 8–50 seconds.

So a check answers from the cache, or from the nearest previous answer, **immediately** —
and only when it has neither does it wait, for up to `waitMs` (7 s by default).

That order is the whole design, and both halves of it were measured rather than reasoned.

**The first version did not wait at all**, on the extension's reasoning: answer empty, fill
the cache behind, let the next keystroke collect it. It was measured against a real
Collabora and it does not work. 75 checks, 25 of them answered `queued`, and **not one
non-empty answer ever reached a user.** The client stops asking the moment the user stops
typing, and there is no `PROOFREAD_AGAIN` on this path to tell it to look again — so the
last check of a paragraph is always the one that matters, and always the one with no answer
yet. The mock used to prove the plumbing had worked precisely because it answered
synchronously.

Waiting is affordable because the 8–50 s in `doc/roadmap.md` was a laptop GPU under thermal
throttling. On a server with the model resident, a real paragraph comes back in 0.7–2.2 s,
and LibreOffice never proofreads one document concurrently (measured, same file), so a call
that waits throttles that document rather than queueing behind itself. Measured end to end
here: **3.1 s** for a first check — 1.5 s of debounce plus 1.6 s of model — against a
ceiling of 10.

`waitMs` has to cover the debounce *and* the model, so a value below `debounceMs` is refused
at startup rather than left to be discovered: every check would wait, time out and answer
empty, which is the exact failure the wait was added to fix.

**And waiting when there was something to show was worse than not waiting.** The second
draft waited on every cache miss. Every answer then arrived about three seconds after the
keystroke that asked for it, by which time the paragraph had moved on — and not one
underline appeared, although the log showed matches going out on every request. A result
that describes text the user has already edited is no result at all. Answering in 0 ms from
the previous answer put them back, and the model's fresh answer is collected by the next
keystroke, which is exactly what `provisional()` is for.

So the wait is now only for a **cold** paragraph, where the alternative is not a stale
underline but no underline ever.

**What is still lost against the extension.** A paragraph slower than the budget — a long
one, or one queued behind other people's — still answers empty, and its answer then sits in
the cache until the client happens to ask again. The debounce and the cache keep that rare
rather than impossible.

**Added: several people at once.** The protocol carries no session, no document and no user;
two requests are indistinguishable except by their text. The extension's single debounce
slot is exactly right for one cursor and quietly wrong for many — two typists would cancel
each other, and the timer would fire only for whoever paused last, or with enough typists
for nobody at all. `StreamDebouncer` keeps one timer per paragraph instead, asking
`laita_engine.same_stream` whether two texts are the same paragraph one edit apart. It counts
characters shared at **both** ends, which is why editing the *start* of a paragraph is still
recognised as the same stream; a shared-prefix key would have called every keystroke there a
new person and fired a request for each.

## Only the paragraph somebody is working in

Opening a long document makes the client offer **every** paragraph to the checker at once.
Each one is a model call, so starting to type on page five put the answer behind fifty
paragraphs nobody had asked about.

The extension solves this with `checkScope: "caret"` — it knows where the cursor is.
Nothing in this protocol says where the cursor is, or even which document a request belongs
to. What it does say is the text, and that turns out to be enough: **a paragraph being
edited arrives again and again, a character apart, while a paragraph merely displayed
arrives once and never changes.** `laita_engine.same_stream` already answers exactly that
question, for the debounce.

So `scope` defaults to `"typed"`: a first sighting is remembered but not sent to the model,
and a text continuing one already seen is. Remembering is what makes the first keystroke in
a paragraph recognised immediately rather than costing a round trip.

"Being edited" means the text **changed**, not that it matched something seen before.
Reopening a document offers every paragraph again unchanged, and treating that as evidence
of editing swept the whole document — the very thing this setting exists to prevent.

Reopening is fast for a different reason: the cache is keyed on the paragraph's text, so a
document that has been checked before — or a *copy* of it, which has the same text — is
answered from cache in about a millisecond, with no model call. That is the service's own
cache, not anything Collabora or Nextcloud keeps.

Two costs, both pinned by tests rather than left to be found:

- A document nobody types in is never checked, and a brand-new paragraph costs one
  keystroke before it is recognised.
- Paragraphs that differ only in a word or two read as edits of one another, so a document
  of near-identical lines — a list, a table of similar entries — degrades towards checking
  everything. That is the safe direction to fail in.

`scope: "document"` restores checking everything. `"caret"` is accepted as a synonym for
`"typed"`, so a configuration copied from the extension means what it looks like.

## The word being typed

This is the only LAITA surface asked about text on every keystroke, so it sees half-written
words constantly, and one measured session shows why that matters:

```
08:41:43  model: 69 chars  'Sorry, I don't speak very good English. I would wish that  I can spea'
```

The model did as it was told and reported *"Missing letter 'k' and incomplete word"*. Two
things then went wrong. It underlined the word the user was in the middle of typing — which
no spell checker does. And the answer was cached, reused while the next one computed, and
the fragment matched inside a correctly spelled `speak` **earlier in the sentence**, offering
to replace a good word with itself.

`laita_lt_typing.py` holds both guards: the part-typed word is not sent to the model, and an
anchored range that is only part of a longer word is dropped. The second is the load-bearing
one — it is what makes any stale cached answer safe against edited text — and it is
script-aware, because in Japanese, Chinese and Korean every character abuts another and a
naive test would reject every suggestion in those languages.

The cost is stated rather than hidden: a paragraph that ends without punctuation has its
last word unchecked until a space or full stop follows it. That is the bargain every spell
checker makes.

Neither guard is in `laita_anchor.py`, on purpose: that file is a transcription of
`anchor.js` and the two are tested against each other. If these prove right they belong in
the JavaScript first and in the port after — the browser and VS Code reuse cached answers
the same way and have the same latent bug.

## How it is put together

| | |
| --- | --- |
| `src/laita_lt_server.py` | the debounce, the cache, the HTTP, and `main()` |
| `src/laita_lt_typing.py` | the part-typed word, at both ends |
| `src/laita_lt_translate.py` | HTML in, HTML out, and the prompt between them |
| `src/laita_lt_protocol.py` | LAITA issues as LanguageTool matches. No I/O, no clock |
| `src/laita_lt_config.py` | the JSON file, the environment, and what is refused |
| `src/laita_lt_shared.py` | the one place that says where the ported modules live |

Nothing is copied from `libreoffice/`. The prompts, the anchoring, the chunking and the
cache are imported from `libreoffice/src/pythonpath/`, which imports no `uno` and never
did. `doc/roadmap.md` already names the Python port of `anchor.js` as the thing most likely
to rot — the four guards in it were each paid for with corrupted text — so a second copy
would be a third place for them to be wrong.

The one change made to the shared code was to lift the similarity test out of
`Engine.provisional` into `laita_engine.same_stream`, so that both callers ask the question
the same way. Behaviour is unchanged and `libreoffice/test/run.sh` proves it.

## What the reader does with the answer, and why the values look odd

All of this is `languagetoolimp.cxx`, and none of it is guessable:

- **`offset` and `length` become `nErrorStart`/`nErrorLength` directly.** They index a UNO
  string, which is UTF-16; Python indexes code points. They agree until a character outside
  the BMP appears — one emoji shifts everything after it by one — so the conversion is
  explicit, through the same `to_utf16_index` the extension uses at the UNO boundary.
- **The underline colour comes from `rule.category.id`**, through a fixed table: `TYPOS`
  and `orth` red, `STYLE` blue, everything else orange. There is no way to send a colour.
  So LAITA's categories are spelled with whichever id yields the colour the extension
  already uses, and `style` is therefore sent as **`GRAMMAR`**. It looks like a
  mistranslation; it is what keeps a style suggestion the same orange in Collabora as in
  LibreOffice. `test_protocol.py` asserts it with that reasoning attached.
- **`aShortComment` is filled from `message`.** `shortMessage` is read into the same
  variable first and then overwritten, so sending only `shortMessage` gives an empty
  tooltip. Both are sent, identical.
- **`aRuleIdentifier` is never set on this path.** The extension puts a suggestion's
  fingerprint there so *Ignore All* silences one suggestion rather than a whole category.
  That cannot work here. The ignore list is server-wide, in the configuration file, and
  there is no per-user equivalent.
- **At most ten replacements** are kept per match.

## Testing

```bash
test/run.sh        # neither Ollama nor LibreOffice; nothing sleeps
```

The debounce and the model are both injected, so the multi-user cases are deterministic
rather than timing-dependent: seventeen keystrokes in one paragraph must ask once, two
typists must both be asked about, and editing the start of a paragraph must stay one
stream. `test_protocol.py` checks the wire format against the facts above, including the
emoji offset, in both directions.

What the tests cannot see is whether Collabora draws the underline. For that, a human still
has to look.

## Security

Everything anyone types passes through this service. It binds to `127.0.0.1` unless told
otherwise, says so in the log when it does not, and has no authentication beyond the
protocol's `apiKey`. The document text goes to Ollama and nowhere else; nothing leaves the
machine unless `endpoint` points off it.
