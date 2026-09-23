#!/usr/bin/env python3
# -*- encoding: UTF-8 -*-
"""
A LanguageTool API server that answers from a local Ollama, for every client at once.

Why this exists rather than the .oxt: Collabora Online cannot install extensions, and
draws its own interface in the browser, so a toolbar and a dialog have nowhere to appear.
It can be told to call a LanguageTool server, which is server-wide and needs nothing
installed by anybody. doc/roadmap.md rejected the LanguageTool protocol for the DESKTOP
extension because it has no slot for a transform - still true, and it costs nothing on a
surface where the transform was never reachable.

The one hard constraint, and the reason this file is shaped as it is:

    LibreOffice sets CURLOPT_TIMEOUT to 10 seconds on this call, in
    lingucomponent/source/spellcheck/languagetool/languagetoolimp.cxx. It is not
    configurable. A paragraph takes this model 8-50 seconds (doc/roadmap.md).

So a check waits for the answer, but only up to `waitMs` - comfortably under the ceiling -
and falls back to the cache, to the nearest previous answer, or to nothing.

The first draft did not wait at all: answer empty, fill the cache behind, and let the next
keystroke collect it. That is what the extension does, and here it does not work. Measured
against a real Collabora: 75 checks, 25 of them answered "queued", and not one non-empty
answer ever reached a user. The reason is that **the client stops asking the moment the
user stops typing**, and there is no PROOFREAD_AGAIN on this path to tell it to look
again. The last check of a paragraph is always the one that matters, and it is always the
one there is no answer for yet.

Waiting is affordable because the numbers that argued against it were measured on a laptop
GPU. On a server with the model resident, a real paragraph comes back in 0.7-2.2 s, and
LibreOffice never calls a proofreader concurrently for one document (measured -
doc/roadmap.md), so a call that waits simply throttles that document instead of queueing.

What is still lost against the extension, and cannot be got back:

  * A paragraph slower than `waitMs` - a long one, or one behind a queue of other people's
    - still answers empty, and its answer then sits in the cache until the client happens
    to ask again. The debounce and the cache are what keep that rare.
  * "Ignore All" cannot be per-suggestion, because the reader never sets aRuleIdentifier
    on this path. The ignore list is server-wide.

And what it must do that the extension never had to: serve several people at once. The
protocol carries no session, no document and no user - two requests are indistinguishable
except by their text. StreamDebouncer below is the whole answer to that.
"""
import argparse
import json
import os
import sys
import threading
import time
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import laita_lt_config                                      # noqa: E402
import laita_lt_protocol as protocol                        # noqa: E402
import laita_lt_typing as typing_                            # noqa: E402
import laita_lt_shared                                      # noqa: E402

laita_lt_shared.install()
import laita_anchor as anchor                               # noqa: E402
import laita_engine                                         # noqa: E402
import laita_ollama as ollama                               # noqa: E402
import laita_segment as segment                             # noqa: E402

VERSION = "0.1.0"

# A stream that nobody has typed into for this long is forgotten. Only bounds memory;
# the cache of answers is separate and is the Engine's business.
STREAM_TTL = 300.0
MAX_STREAMS = 400


def make_log(path):
    lock = threading.Lock()

    def log(msg):
        line = "%s  %s" % (time.strftime("%Y-%m-%d %H:%M:%S"), msg)
        with lock:
            if path:
                try:
                    with open(path, "a", encoding="utf-8") as fh:
                        fh.write(line + "\n")
                    return
                except Exception:
                    pass          # fall through to stderr rather than lose the line
            sys.stderr.write(line + "\n")
            sys.stderr.flush()
    return log


class StreamDebouncer:
    """One debounce timer per paragraph being typed, rather than one for the server.

    The extension has a single pending slot, which is right when there is one cursor: a
    new keystroke should always cancel the last. Here it is wrong, and quietly so. Two
    people typing at once would cancel each other, and the timer would only ever fire for
    whoever paused last - with enough typists, for nobody at all.

    Nothing in the request identifies who sent it, so the texts themselves are used:
    laita_engine.same_stream answers "is this the same paragraph, one edit apart", which
    is exactly the question. It counts characters shared at BOTH ends, so editing at the
    start of a paragraph still recognises it - a shared-prefix test would have treated
    every keystroke there as a new person and fired a request for each.
    """

    def __init__(self, delay, fire, log=None, timer_factory=None):
        self._delay = delay
        self._fire = fire
        self._log = log or (lambda msg: None)
        # Injected by the tests, so they need not sleep in real time - the same reason
        # laita_engine.Engine takes one.
        self._timer_factory = timer_factory or threading.Timer
        self._lock = threading.Lock()
        self._streams = {}          # id -> {"text", "timer", "seen"}
        self._next_id = 0

    def note(self, text, lang, settings):
        """This text wants checking once it has stopped changing."""
        with self._lock:
            self._reap()
            sid = self._find(text)
            if sid is None:
                self._next_id += 1
                sid = self._next_id
            else:
                self._streams[sid]["timer"].cancel()
            timer = self._timer_factory(self._delay, self._ring,
                                         [sid, text, lang, settings])
            timer.daemon = True
            self._streams[sid] = {"text": text, "timer": timer, "seen": time.time()}
            timer.start()
            return sid

    def _find(self, text):
        best, best_shared = None, 0
        for sid, stream in self._streams.items():
            shared = laita_engine.same_stream(stream["text"], text)
            if shared > best_shared:
                best, best_shared = sid, shared
        return best

    def _ring(self, sid, text, lang, settings):
        with self._lock:
            stream = self._streams.get(sid)
            if stream is None or stream["text"] != text:
                return              # superseded while the timer was running
            del self._streams[sid]
        self._fire(text, lang, settings)

    def _reap(self):
        """Caller holds the lock. Drop streams nobody has touched in a while, and if
        something has gone wrong enough to leak them, drop the oldest."""
        cutoff = time.time() - STREAM_TTL
        for sid in [s for s, v in self._streams.items()
                    if v["seen"] < cutoff and not v["timer"].is_alive()]:
            del self._streams[sid]
        if len(self._streams) > MAX_STREAMS:
            oldest = sorted(self._streams, key=lambda s: self._streams[s]["seen"])
            for sid in oldest[:len(self._streams) - MAX_STREAMS]:
                self._streams.pop(sid)["timer"].cancel()

    @property
    def pending(self):
        with self._lock:
            return len(self._streams)


class Checker:
    """Everything that is not HTTP: the cache, the debounce and the model."""

    def __init__(self, settings, log, timer_factory=None, ask=None):
        self.settings = settings
        self.log = log
        # One event per text somebody is waiting on, reference counted because two people
        # can be editing the same paragraph of the same document.
        self._waiters = {}
        self._waiters_lock = threading.Lock()
        # `ask` is the seam the tests use. It has to be a constructor argument: the
        # Engine binds the callable it is given, so replacing the attribute afterwards
        # changes nothing and the test quietly exercises the real Ollama path instead.
        self.engine = laita_engine.Engine(ask or self._ask_the_model, log=log,
                                          on_ready=self._answer_ready,
                                          timer_factory=timer_factory)
        self.debouncer = StreamDebouncer(
            max(0.0, float(settings["debounceMs"]) / 1000.0), self._settled, log,
            timer_factory=timer_factory)
        self.checks = 0
        self.hits = 0

    # --- the model ------------------------------------------------------------------
    def _ask_the_model(self, text, lang):
        """Runs on the Engine's drain thread, one at a time. Returns the RAW answer;
        anchoring happens against whatever the text says when it is asked for."""
        s = self.settings
        started = time.time()
        timeout = float(s["requestTimeoutMs"]) / 1000.0
        # One request per chunk. The chunks' answers are simply concatenated: the model
        # answers with quotes rather than offsets, so a quote from chunk three is still a
        # quote from the paragraph and anchoring finds it. No offset arithmetic is needed.
        # Never ask about the word the user is still typing. The model answers "missing
        # letter, incomplete word" - correctly, and uselessly - and that answer then
        # outlives the keystroke in the cache. See laita_lt_typing.
        asked = typing_.without_part_typed_word(text)
        chunks = segment.chunk_text(asked, s["chunkMaxChars"])
        raw = []
        for _, chunk in chunks:
            raw.extend(ollama.request_issues(chunk, lang, s, timeout=timeout))
        self.log("model: %d chars in %d chunk(s), %d issues, %.1fs  %r"
                 % (len(text), len(chunks), len(raw), time.time() - started, text[:60]))
        return raw

    def _answer_ready(self, text):
        """An answer has been cached. Wake anyone holding a request open for it."""
        with self._waiters_lock:
            entry = self._waiters.get(text)
        if entry is not None:
            entry[0].set()

    def _wait_for(self, text, timeout):
        """Block until an answer for exactly this text is cached, or the budget runs out.

        Safe to hold a request open here: LibreOffice never proofreads one document
        concurrently, so this throttles that document rather than queueing behind itself,
        and every other document has its own connection.
        """
        with self._waiters_lock:
            entry = self._waiters.get(text)
            if entry is None:
                entry = [threading.Event(), 0]
                self._waiters[text] = entry
            entry[1] += 1
        try:
            entry[0].wait(timeout)
        finally:
            with self._waiters_lock:
                entry[1] -= 1
                if entry[1] <= 0:
                    self._waiters.pop(text, None)

    def _settled(self, text, lang, settings):
        """A paragraph has stopped changing. enqueue(), not request(): the Engine's own
        debounce is global, and this class has already done the debouncing per stream."""
        self.engine.enqueue(text, lang, settings)

    # --- the hot path ---------------------------------------------------------------
    def check(self, text, lang):
        """Anchored issues for this text, right now. Must never wait for the model."""
        s = self.settings
        self.checks += 1
        if not s["enabled"]:
            return [], "disabled"
        stripped = text.strip()
        if len(stripped) < s["minChars"] or len(text) > s["maxChars"]:
            return [], "out of range"

        raw = self.engine.lookup(text)
        source = "cache"
        if raw is not None:
            self.hits += 1
        else:
            self.debouncer.note(text, lang, s)
            # Answer NOW if there is anything at all to answer with, and only wait when
            # there is not. Order matters, and it is the whole of this method.
            #
            # Waiting unconditionally was measured and was worse than not waiting: every
            # answer arrived about three seconds after the keystroke that asked for it,
            # by which time the paragraph had moved on, and not one underline appeared -
            # although the log showed matches going out on every request. Answering in
            # 0 ms from the previous answer put them back. A result that describes text
            # the user has already edited is no result at all.
            #
            # Anchoring below is against the CURRENT text, so whatever the edit
            # invalidated falls out by itself. That is why the cache holds the model's
            # raw answer and not ranges.
            raw = self.engine.provisional(text)
            source = "provisional"
            if raw is None:
                # Nothing to show. Now waiting is strictly better than an empty answer:
                # a cold paragraph would otherwise never be underlined at all, because
                # the client stops asking the moment the user stops typing.
                budget = float(s["waitMs"]) / 1000.0
                if budget > 0:
                    self._wait_for(text, budget)
                    raw = self.engine.lookup(text)
                    source = "waited"
                if raw is None:
                    return [], "queued"
        issues = anchor.anchor_issues(text, raw, categories=s["categories"],
                                      ignored=s["ignored"])
        # A quote from an older snapshot of this paragraph can still be found in the
        # current one, as a fragment of a longer word - `spea` inside a correctly spelled
        # `speak`, and not even the same one. Anchoring locates substrings; it is this
        # that requires them to be whole words.
        kept = [i for i in issues if not typing_.inside_a_word(text, i["start"], i["end"])]
        dropped = len(issues) - len(kept)
        return kept, "%s, %d raw -> %d anchored%s" % (
            source, len(raw), len(kept),
            (" (%d part-word dropped)" % dropped) if dropped else "")

    def status(self):
        return {
            "version": VERSION,
            "model": self.settings["model"],
            "endpoint": self.settings["endpoint"],
            "checks": self.checks,
            "cacheHits": self.hits,
            "cached": len(self.engine._cache),
            "streamsPending": self.debouncer.pending,
            "busy": self.engine.busy,
            "lastError": str(self.engine.last_error) if self.engine.last_error else None,
        }


def handler_class(checker, settings, log):
    key = str(settings.get("apiKey") or "")
    languages = protocol.languages_response(settings["languages"],
                                            ollama.LANGUAGE_NAMES)

    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"
        server_version = "LAITA/" + VERSION
        sys_version = ""

        def log_message(self, fmt, *args):
            pass                     # the access log is ours, below, with the outcome

        def _send(self, payload, status=200):
            body = json.dumps(payload).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=UTF-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            try:
                self.wfile.write(body)
            except (BrokenPipeError, ConnectionResetError):
                pass                 # the client gave up; nothing to do and nothing wrong

        def _fields(self):
            if self.command == "GET":
                return urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            length = int(self.headers.get("Content-Length") or 0)
            return urllib.parse.parse_qs(self.rfile.read(length).decode("utf-8", "replace"))

        def _route(self):
            path = urllib.parse.urlparse(self.path).path.rstrip("/")
            if path.endswith("/check"):
                return self._check()
            if path.endswith("/languages"):
                return self._send(languages)
            if path in ("", "/status"):
                return self._send(checker.status())
            self._send({"error": "not found"}, 404)

        def _check(self):
            fields = self._fields()
            if key and (fields.get("apiKey") or [""])[0] != key:
                log("check refused: wrong or missing apiKey")
                return self._send({"error": "bad apiKey"}, 401)

            text = (fields.get("text") or [""])[0]
            lang = protocol.language_tag((fields.get("language") or [""])[0])
            started = time.time()
            try:
                issues, why = checker.check(text, lang)
            except Exception as err:
                # Answer 200 with nothing found rather than 5xx. A client that decides
                # the grammar service is broken may stop asking for the rest of the
                # session, and a transient Ollama failure must not cost that.
                log("check failed: %r" % (err,))
                issues, why = [], "failed"
            elapsed = time.time() - started
            log("check: %d chars, lang=%s, %s, %.0fms"
                % (len(text), lang or "auto", why, elapsed * 1000))
            if elapsed > (float(settings["waitMs"]) / 1000.0) + 1.0:
                # The reader gives up at 10s, and we promised to answer within waitMs.
                # Overrunning our own budget means something is blocking that should not.
                log("WARNING: a check took %.1fs, over its %sms budget; the client gives "
                    "up at 10s" % (elapsed, settings["waitMs"]))
            self._send(protocol.check_response(text, issues, lang, anchor.to_utf16_index,
                                               name="LAITA", version=VERSION))

        def do_GET(self):
            self._route()

        def do_POST(self):
            self._route()

    return Handler


def main(argv=None):
    ap = argparse.ArgumentParser(
        description="A LanguageTool API server answering from a local Ollama.")
    ap.add_argument("-c", "--config", help="JSON configuration file")
    ap.add_argument("--host", help="address to bind (default 127.0.0.1)")
    ap.add_argument("--port", type=int, help="port to bind (default 8181)")
    ap.add_argument("--version", action="version", version="LAITA LanguageTool " + VERSION)
    args = ap.parse_args(argv)

    settings = laita_lt_config.from_env(laita_lt_config.load(args.config))
    if args.host:
        settings["host"] = args.host
    if args.port:
        settings["port"] = args.port

    log = make_log(settings["logFile"])
    checker = Checker(settings, log)

    log("LAITA LanguageTool %s starting on %s:%d"
        % (VERSION, settings["host"], settings["port"]))
    log("model %s at %s, chunk %s, debounce %sms"
        % (settings["model"], settings["endpoint"], settings["chunkMaxChars"],
           settings["debounceMs"]))
    # Say at start whether the model is actually there. The alternative is a server that
    # looks healthy and answers every check with nothing, for a reason only visible one
    # request deep in the log.
    try:
        found = ollama.probe(settings)
        if not found["hasModel"]:
            log("WARNING: Ollama has no model %r. Run: ollama pull %s"
                % (settings["model"], settings["model"]))
        else:
            log("Ollama reachable, model present")
    except Exception as err:
        log("WARNING: %s" % ollama.describe_error(err))

    if settings["host"] not in ("127.0.0.1", "localhost", "::1"):
        log("NOTE: bound to %s, which is not loopback. Everything anyone types passes "
            "through here; make sure only the intended clients can reach it."
            % settings["host"])

    httpd = ThreadingHTTPServer((settings["host"], settings["port"]),
                                handler_class(checker, settings, log))
    httpd.daemon_threads = True
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        checker.engine.stop()
        httpd.server_close()
        log("stopped")
    return 0


if __name__ == "__main__":
    sys.exit(main())
