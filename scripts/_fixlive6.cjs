const fs = require("fs");
const p = "scripts/live-understand-act.cjs";
let s = fs.readFileSync(p, "utf8");
const a = "act: { openPath: async () => \"no\" }, emit: (e) => { if (/^task\.(failed|clarification|confirmation|completed)/.test(e.type)) console.log(\"EVENT\", e.type, (e.summary || e.question || \"\").slice(0, 300)); },";
if (!s.includes(a)) throw new Error("anchor");
s = s.replace(a, "act: { openPath: async () => \"no\" }, emit: (e) => { if (/^cursor\./.test(e.type)) console.log(\"  ghost <-\", e.type, e.say || e.state || e.action || \"\", e.text || e.label || \"\"); if (/^task\.(failed|clarification|confirmation|completed)/.test(e.type)) console.log(\"EVENT\", e.type, (e.summary || e.question || \"\").slice(0, 300)); },");
s = s.replace("selfPids: () => [], ai, cursorLeadMs: () => 800, pointer: () => pointer, verifyAttempts: 3,", "selfPids: () => [], ai, cursorLeadMs: () => 800, pointer: () => pointer, verifyAttempts: 3,");
fs.writeFileSync(p, s);
