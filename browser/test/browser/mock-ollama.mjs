// Mock Ollama + static host for the test page. Logs every request header it sees.
import http from "node:http";
import fs from "node:fs";

const CANNED = {
  issues: [
    { type: "error", original: "recieve", replacement: "receive", message: "Spelling." },
    { type: "error", original: "was very interested", replacement: "were very interested", message: "Plural subject." },
    { type: "style", original: "Due to the fact that", replacement: "Since", message: "Wordy." },
    { type: "rephrase", original: "send us a more detailed documentation", replacement: "send us fuller documentation", message: "More natural." },
    { type: "error", original: "NOT IN THE TEXT", replacement: "x", message: "should be dropped" }
  ]
};

/*
 * A transform asks for prose, not JSON, and is recognisable by the absence of `format`.
 * The canned answer wraps the fragment in a preamble and quotes that the extension is
 * supposed to strip, so the round trip exercises cleanTransformOutput as well: the page
 * can predict the final text as simply "every e becomes E".
 */
const transformAnswer = (parsed) => {
  const user = parsed.messages?.[parsed.messages.length - 1]?.content ?? "";
  const m = user.match(/<<<TEXT\n([\s\S]*)\nTEXT>>>/);
  const fragment = m ? m[1] : "";
  return `Here is the polished text:\n"${fragment.replace(/e/g, "E")}"`;
};

/*
 * Text carrying this marker gets one HTTP 500 - the shape Ollama returns when its model
 * runner fails to start - and succeeds from then on, so a harness can prove the retry
 * turns that into an invisible hiccup rather than an error in the user's face.
 */
const RETRY_MARKER = "RETRYME";
/* Text carrying this one gets a reply slower than Firefox's event-page idle timeout, to
 * catch the background being unloaded while its fetch is still outstanding. */
const SLOW_MARKER = "SLOWME";
const alreadyFailed = new Set();

const log = [];
http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const entry = { method: req.method, url: req.url, origin: req.headers.origin ?? null, headers: req.headers };
    if (req.url.startsWith("/api/")) {
      entry.bodyPreview = body.slice(0, 4000);
      log.push(entry);
      fs.writeFileSync(process.env.LOGFILE, JSON.stringify(log, null, 1));
    }
    const cors = {
      "Access-Control-Allow-Origin": req.headers.origin || "*",
      "Access-Control-Allow-Headers": "content-type",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS"
    };
    if (req.method === "OPTIONS") { res.writeHead(204, cors); return res.end(); }
    if (req.url === "/api/tags") {
      res.writeHead(200, { ...cors, "Content-Type": "application/json" });
      return res.end(JSON.stringify({ models: [{ name: "mock:test" }] }));
    }
    if (req.url === "/api/chat") {
      let parsed = null;
      try {
        parsed = JSON.parse(body);
      } catch {
        /* treat unparseable bodies as proofreading, as before */
      }
      const isTransform = parsed && !parsed.format;
      const asked = parsed?.messages?.[parsed.messages.length - 1]?.content ?? "";
      if (asked.includes(RETRY_MARKER) && !alreadyFailed.has(RETRY_MARKER)) {
        alreadyFailed.add(RETRY_MARKER);
        res.writeHead(500, { ...cors, "Content-Type": "application/json" });
        return res.end(JSON.stringify({ error: "timed out waiting for llama-server to start" }));
      }
      res.writeHead(200, { ...cors, "Content-Type": "application/json" });
      const content = isTransform ? transformAnswer(parsed) : JSON.stringify(CANNED);
      const send = () => res.end(JSON.stringify({ message: { content } }));
      // Only proofreading is slowed down, so a harness can catch the "Checking…" pill
      // mid-flight and cancel it while transforms stay instant.
      const delay = asked.includes(SLOW_MARKER)
        ? Number(process.env.SLOW_DELAY_MS) || 45000
        : isTransform ? 0 : Number(process.env.CHAT_DELAY_MS) || 0;
      return delay ? setTimeout(send, delay) : send();
    }
    if (req.url === "/report") {
      fs.writeFileSync(process.env.REPORT, body);
      res.writeHead(200, cors); return res.end("ok");
    }
    if (req.url === "/" || req.url.startsWith("/test")) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(fs.readFileSync(process.env.PAGE));
    }
    res.writeHead(404); res.end();
  });
}).listen(Number(process.env.PORT), "127.0.0.1", () => console.log("mock up on " + process.env.PORT));
