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

console.log(pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
