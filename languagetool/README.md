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
