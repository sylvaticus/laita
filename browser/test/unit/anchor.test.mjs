import { anchorIssues, locate } from "../../src/background/anchor.js";
let pass = 0, fail = 0;
const eq = (name, got, want) => {
  const a = JSON.stringify(got), b = JSON.stringify(want);
  if (a === b) pass++; else { fail++; console.log("FAIL " + name + "\n  got  " + a + "\n  want " + b); }
};

eq("exact single", locate("I have recieve your email", "recieve"), [[7, 14]]);
eq("two occurrences", locate("the the cat", "the"), [[0,3],[4,7]]);
eq("curly apostrophe folded", locate("it’s fine", "it's"), [[0,4]]);
eq("nbsp folded", locate("bonjour monde", "bonjour monde"), [[0,13]]);
eq("double space folded", locate("bonjour  monde", "bonjour monde"), [[0,14]]);
eq("newline folded to space", locate("a wordy\nphrase here", "wordy phrase"), [[2,14]]);
eq("case-insensitive fallback", locate("Due to the fact that", "due to the fact that"), [[0,20]]);
eq("absent", locate("hello world", "goodbye"), []);

const text = "I have recieve you're email yesterday and me and my colleague was interested.";
const raw = [
  { type: "error", original: "recieve", replacement: "received", message: "spelling" },
  { type: "error", original: "you're email", replacement: "your email", message: "possessive" },
  { type: "rephrase", original: "recieve you're email", replacement: "got your message", message: "nicer" },
  { type: "style", original: "NOT PRESENT", replacement: "x", message: "ghost" },
  { type: "error", original: "was", replacement: "was", message: "no-op" },
  { type: "bogus", original: "email", replacement: "mail", message: "bad category" }
];
const out = anchorIssues(text, raw);
eq("overlap resolved, ghosts dropped", out.map(i => text.slice(i.start, i.end)), ["recieve", "you're email"]);
eq("sorted by position", out.map(i => i.start), [7, 15]);
eq("offset applied", anchorIssues("bad wrod here", [{type:"error",original:"wrod",replacement:"word",message:"m"}], {offset:100})[0].start, 104);
eq("category filter", anchorIssues(text, raw, {categories:{error:false,style:true,rephrase:true}}).map(i=>i.type), ["rephrase"]);
eq("ignore list", anchorIssues(text, raw, {ignored:[out[0].fp]}).length, 1);
const long = "x".repeat(200);
eq("whole-chunk rewrite dropped", anchorIssues(long, [{type:"rephrase",original:long,replacement:"y",message:"m"}]).length, 0);
eq("original re-read from document", anchorIssues("it’s ok", [{type:"error",original:"it's",replacement:"it is",message:"m"}])[0].original, "it’s");

// ---------------------------------------------------------------- already there
// Models quote a substring that stops short of the character they want to add. Asked
// about a sentence that already ends in a full stop, qwen3.5:9b reliably answers
// original "English", replacement "English." - and applying it gives "English..".

const A = (text, raw) => anchorIssues(text, [raw], { categories: { error: true, style: true }, ignored: [] });
const one = (text, raw) => { const [i] = A(text, raw); return i ? text.slice(0, i.start) + i.replacement + text.slice(i.end) : null; };

const SENT = "Sorry, I don't speak very well English.";
eq("the reported case is dropped",
   A(SENT, { original: "English", replacement: "English.", type: "error", message: "full stop" }).length, 0);
eq("a prefix already present is dropped too",
   A("Good morning everyone", { original: "morning", replacement: "Good morning", type: "error", message: "x" }).length, 0);
eq("both sides at once",
   A("He said (yes) today", { original: "yes", replacement: "(yes)", type: "error", message: "x" }).length, 0);

// but real corrections must survive, including ones that genuinely add punctuation
eq("a real spelling fix still applies",
   one("I have recieve it", { original: "recieve", replacement: "received", type: "error", message: "sp" }),
   "I have received it");
eq("a genuinely missing full stop still applies",
   one("I speak English", { original: "English", replacement: "English.", type: "error", message: "fs" }),
   "I speak English.");
eq("a comma that is not already there still applies",
   one("Finally the loops", { original: "Finally the", replacement: "Finally, the", type: "error", message: "c" }),
   "Finally, the loops");
eq("adding a word still applies",
   one("speak well English", { original: "well English", replacement: "English well", type: "style", message: "order" }),
   "speak English well");
eq("a different trailing character is not a duplicate",
   one("I speak English.", { original: "English", replacement: "English!", type: "style", message: "x" }),
   "I speak English!.");

console.log(pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
