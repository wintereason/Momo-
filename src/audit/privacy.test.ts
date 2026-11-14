import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

/**
 * A static audit of Momo's own source. It turns the privacy and safety promises into tests so they
 * cannot silently regress: what is written to disk, what touches the network, how programs are started,
 * what is logged, and what the UI is allowed to ask the desktop shell to do.
 */

const root = path.resolve(__dirname, "../..");
const SKIP_DIRS = new Set(["node_modules", "dist", ".git"]);

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}
const rel = (p: string) => path.relative(root, p).replace(/\\/g, "/");

const isTest = (f: string) => /\.test\.(ts|mjs)$/.test(f) || f.startsWith("src/audit/");
const SOURCE = [...walk(path.join(root, "src")), ...walk(path.join(root, "electron"))]
  .map(rel)
  .filter((f) => /\.(ts|tsx|cjs|mjs)$/.test(f) && !isTest(f) && f !== "electron/runtime.cjs"); // runtime.cjs is a bundle of src
const read = (f: string) => fs.readFileSync(path.join(root, f), "utf8");
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1"); // ignore comments

function hits(re: RegExp): { file: string; line: string }[] {
  const out: { file: string; line: string }[] = [];
  for (const f of SOURCE) {
    for (const line of strip(read(f)).split("\n")) if (re.test(line)) out.push({ file: f, line: line.trim() });
  }
  return out;
}
const files = (h: { file: string }[]) => [...new Set(h.map((x) => x.file))].sort();

describe("what Momo writes to disk", () => {
  it("writes only preferences, the AI request counter, the online-voice character counter, and the speech-model cache", () => {
    const writes = hits(/\b(writeFile|writeFileSync|appendFile|appendFileSync|createWriteStream|localStorage\.setItem|\.setItem\(|sessionStorage|indexedDB|document\.cookie|openDatabase)\b/);
    expect(files(writes)).toEqual(["electron/env.cjs", "electron/main.cjs", "src/learning/store.ts", "src/state/settings.ts"]);
    // electron/env.cjs: exactly one write, inside save(): the keys the user typed into Settings, into Momo's own .env
    const envWrites = writes.filter((w) => w.file === "electron/env.cjs");
    expect(envWrites).toHaveLength(1);
    expect(envWrites[0].line).toContain("fs.writeFileSync(file, out.join(");
    // electron/main.cjs: exactly three writes: the AI's daily request counter (a date and a number), the online-voice daily character
    // counter (a date and a number, only used while the optional online-voice key is set), and the one-byte marker
    // that says "start-with-Windows was already offered" (so it is only switched on once, on first run)
    const mainWrites = writes.filter((w) => w.file === "electron/main.cjs");
    expect(mainWrites).toHaveLength(3);
    const voiceUsage = mainWrites.find((w) => w.line.includes("voiceUsageFile()"))!;
    expect(voiceUsage.line).toContain("JSON.stringify({ date: localDate(), chars: used + n })");
    const usage = mainWrites.find((w) => w.line.includes("usageFile()"))!;
    expect(usage.line).toContain("JSON.stringify({ date: String(u.date), count: Number(u.count) })");
    const marker = mainWrites.find((w) => w.line.includes("mark"))!;
    expect(marker.line).toContain('fs.writeFileSync(mark, "1")');
    // settings.ts: preferences only
    expect(writes.filter((w) => w.file === "src/state/settings.ts").every((w) => /PREFS_KEY/.test(w.line))).toBe(true);
    // src/learning/store.ts: the language-learning progress (per learner profile, this PC only, removed by "Delete my data"): one write, under its own key
    const learn = writes.filter((w) => w.file === "src/learning/store.ts");
    expect(learn).toHaveLength(1);
    expect(learn[0].line).toContain("LEARNING_KEY");
  });

  it("the clipboard is written only with text the user dictated (never read from the screen)", () => {
    const hitsClip = hits(/clipboard\.writeText/);
    expect(files(hitsClip)).toEqual(["electron/insert.cjs", "electron/main.cjs"]);
    // main.cjs: one helper, copyDictated(), only ever called with dictated text (runtime.dictate() output or a held dictation)
    const mainClip = hitsClip.filter((h) => h.file === "electron/main.cjs");
    expect(mainClip).toHaveLength(1);
    expect(mainClip[0].line).toContain("function copyDictated(dictatedText) { clipboard.writeText(dictatedText); }");
    const calls = (read("electron/main.cjs").match(/copyDictated\([^)]*\)/g) ?? []).filter((c) => !c.includes("dictatedText"));
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((c) => /^copyDictated\((out|t)\.text\)$/.test(c))).toBe(true);
  });

  it("the only use of the Cache API is the speech model (never user content)", () => {
    const cache = hits(/\bcaches\.(open|put|add)\b/);
    expect(files(cache)).toEqual(["src/voice/whisperClient.ts"]);
  });

  it("no code reads or stores raw audio, screenshots or transcripts on disk", () => {
    // (the cloud speech client names its in-memory upload "speech.wav": a multipart label, never a file on disk)
    expect(hits(/\.(wav|mp3|webm|ogg|flac)['"`]/i).map((h) => h.file)).toEqual(["electron/cloudStt.cjs"]);
    expect(read("electron/cloudStt.cjs")).not.toMatch(/node:fs|require\("fs"\)|writeFile|createWriteStream/);
    expect(hits(/\b(MediaRecorder|toDataURL|canvas\.toBlob|URL\.createObjectURL)\b/)).toEqual([]);
    // screenshots exist only inside the PowerShell process that OCRs them, in a MemoryStream
    const script = read("src/runtime-core/shared/nodePorts.ts");
    expect(script).toMatch(/MemoryStream/);
    expect(script).not.toMatch(/\.Save\([^)]*\$[A-Za-z]*[Pp]ath|\.Save\(\s*['"][A-Za-z]:/);
  });
});

describe("what is read from other programs", () => {
  it("the window reader recognises legacy password boxes (ES_PASSWORD or a password character)", () => {
    const src = read("src/runtime-core/shared/nodePorts.ts");
    const uia = src.match(/const UIA_SCRIPT = String\.raw`([\s\S]*?)`;/)![1];
    expect(uia).toContain("GetWindowLongW");
    expect(uia).toContain("0x00D2"); // EM_GETPASSWORDCHAR
    expect(uia).toMatch(/0x20/); // ES_PASSWORD
    expect(uia).toContain("IsPassword");
  });
  it("password fields are dropped in code too, not only in the script", () => {
    expect(read("src/runtime-core/shared/screenText.ts")).toMatch(/!n\.password/);
  });
});

describe("what touches the network", () => {
  it("no application code makes network requests of its own", () => {
    // any use of fetch (including indirect calls like `(x ?? fetch)(...)`), and every other way to open a connection
    const net = hits(/(^|[^\w"'])fetch\b(?!Fn)|\b(XMLHttpRequest|WebSocket\(|EventSource\(|sendBeacon|https?\.request|https?\.get\(|net\.connect|dgram|axios)\b/).filter((n) => !/typeof fetch/.test(n.line));
    // The only other network client is the speech-model loader inside @huggingface/transformers (a dependency).
    // Exactly two places use fetch: one reads the app's OWN bundled files, and the AI client talks to pinned hosts only.
    expect([...new Set(net.map((n) => n.file))].sort()).toEqual(["electron/appProtocol.cjs", "electron/cloudStt.cjs", "electron/onlineVoice.cjs", "electron/stt.worker.cjs", "src/runtime-core/orchestrator/ai/llm.ts"]);
    // Online avatar voices (optional, used only while an ElevenLabs key is saved): ONE pinned HTTPS destination, the key only in a header,
    // only text and a voice id in the body, and the shell's handler is the single caller
    const online = read("electron/onlineVoice.cjs");
    expect(online).toMatch(/const URL_BASE = "https:\/\/api\.elevenlabs\.io\/v1\/text-to-speech\/";/);
    expect(online.match(/fetchFn\(/g)).toHaveLength(1);
    expect(online).toMatch(/fetchFn\(URL_BASE \+ voiceId/);
    expect(online).toMatch(/headers: \{ "xi-api-key": key,/);
    expect(online).toMatch(/body: JSON\.stringify\(\{ text, model_id: /);
    expect(online).not.toMatch(/node:fs|require\("fs"\)|writeFile|console\./); // it writes nothing and logs nothing
    expect(strip(read("electron/main.cjs")).match(/synthOnline\(/g)).toHaveLength(1);
    // Cloud speech (optional, off unless the user picks it): ONE pinned HTTPS destination, the key only in the header,
    // and the shell calls it only when the page asked for the cloud engine
    const cloud = read("electron/cloudStt.cjs");
    expect(cloud).toMatch(/const URL_GROQ = "https:\/\/api\.groq\.com\/openai\/v1\/audio\/transcriptions";/);
    expect(cloud.match(/fetchFn\(/g)).toHaveLength(1);
    expect(cloud).toMatch(/fetchFn\(URL_GROQ,/);
    expect(strip(read("electron/main.cjs"))).toMatch(/if \(p\.engine === "cloud"\) \{\s*try \{\s*const text = await transcribeCloud\(/);
    // the speech worker never sends anything itself: it only puts the model hub allowlist in front of the library's own download
    const sttWorker = read("electron/stt.worker.cjs");
    expect(sttWorker).toMatch(/makeAllowedRequest\(null\)/);
    expect(sttWorker).toMatch(/if \(!allowed\(url\)\) return Promise\.reject\(new TypeError\("blocked destination"\)\);/);
    expect(sttWorker).toMatch(/env\.allowLocalModels = false/);
    // 3) the AI client: every destination is checked against the pinned hosts BEFORE sending, and it is the only call site
    const llm = read("src/runtime-core/orchestrator/ai/llm.ts");
    expect(llm.indexOf("assertAllowedUrl(built.url)")).toBeGreaterThan(-1);
    expect(llm.indexOf("assertAllowedUrl(built.url)")).toBeLessThan(llm.indexOf("this.o.fetchFn ?? fetch"));
    expect(llm.match(/this\.o\.fetchFn \?\? fetch/g)).toHaveLength(1);
    // the momo:// handler, which only ever reads file: URLs inside dist (traversal-proof, see appProtocol.test.mjs)
    const proto = net.find((n) => n.file === "electron/appProtocol.cjs")!;
    expect(proto.line).toContain("net.fetch(pathToFileURL(file).toString())");
  });

  it("the desktop shell enforces an allowlist for outgoing requests", () => {
    const main = read("electron/main.cjs");
    expect(main).toMatch(/webRequest\.onBeforeRequest\(\(details, callback\) => \{\s*callback\(\{ cancel: !allowedRequest\(details\.url\) \}\)/);
    expect(main).toMatch(/makeAllowedRequest\(DEV_URL\)/);
    // the allowlist itself (netpolicy.cjs) is tested separately, including look-alike hosts
    const policy = read("electron/netpolicy.cjs");
    const allowed = [...policy.matchAll(/ALLOWED_HOSTS\s*=\s*\[([^\]]*)\]/g)].flatMap((m) => m[1].match(/"[^"]+"/g) ?? []);
    expect(allowed.sort()).toEqual(['".hf.co"', '".huggingface.co"', '"huggingface.co"']);
  });

  it("the production page carries a strict Content-Security-Policy", () => {
    const cfg = read("vite.config.ts");
    const csp = cfg.match(/http-equiv="Content-Security-Policy" content="([^"]*)"/)?.[1] ?? "";
    expect(csp).not.toBe("");
    const d = Object.fromEntries(csp.split(";").map((s) => s.trim().split(/\s+/)).filter((p) => p[0]).map((p) => [p[0], p.slice(1)]));
    expect(d["default-src"]).toEqual(["'self'"]);
    // scripts: our own files and WebAssembly only (no inline code, no eval)
    expect(d["script-src"]).toEqual(["'self'", "'wasm-unsafe-eval'"]);
    // outgoing connections: the page itself and the speech-model host, nothing else
    expect(d["connect-src"].sort()).toEqual(["'self'", "https://*.hf.co", "https://*.huggingface.co", "https://huggingface.co"]);
    expect(csp).not.toMatch(/\*\s*;|\s\*\s/); // no wildcard source
    expect(csp).not.toContain("'unsafe-eval'");
  });
});

describe("how programs are started", () => {
  it("child processes are created in only three places, and never through a shell", () => {
    const spawns = hits(/\b(spawn|execFile|execFileSync|exec|execSync|fork)\(/);
    expect(files(spawns)).toEqual(["src/runtime-core/apps/launchPorts.ts", "src/runtime-core/shared/nodePorts.ts"]);
    expect(hits(/shell\s*:\s*true/)).toEqual([]);
    expect(hits(/\b(exec|execSync)\(/)).toEqual([]); // exec() goes through a shell
  });

  it("PowerShell scripts are fixed text: no template interpolation of data into them", () => {
    for (const f of ["src/runtime-core/shared/nodePorts.ts", "src/runtime-core/action/inputPorts.ts", "src/runtime-core/apps/launchPorts.ts"]) {
      const src = read(f);
      for (const m of src.matchAll(/String\.raw`([\s\S]*?)`;/g)) {
        expect(m[1], `${f}: script contains \${...}`).not.toMatch(/\$\{/);
      }
    }
  });

  it("nothing evaluates strings as code or injects raw HTML", () => {
    expect(hits(/\beval\(|new Function\(|dangerouslySetInnerHTML|\.innerHTML\s*=|document\.write\(/)).toEqual([]);
  });
});

describe("what is logged", () => {
  it("logs never contain what the user said or what was on screen", () => {
    const logs = hits(/\bconsole\.(log|info|debug|warn|error)\(/);
    // only the shell's own startup/error messages, built from error.message
    for (const l of logs) {
      expect(l.file, l.line).toBe("electron/main.cjs");
      expect(l.line, l.line).not.toMatch(/transcript|text|summary|title|question|utterance|audio|screen/i);
    }
  });
});

describe("the UI may only ask the shell for a fixed set of things", () => {
  const preload = strip(read("electron/preload.cjs"));
  const main = strip(read("electron/main.cjs"));
  const fromPreload = new Set([...preload.matchAll(/ipcRenderer\.(?:send|invoke)\("(momo:[\w-]+)"/g)].map((m) => m[1]));
  const handled = new Set([...main.matchAll(/ipcMain\.(?:on|handle)\("(momo:[\w-]+)"/g)].map((m) => m[1]));

  it("every channel the preload can call has a handler, and no handler is hidden from review", () => {
    expect([...fromPreload].sort()).toEqual([...handled].sort());
    expect(fromPreload.size).toBeGreaterThan(10);
  });

  it("every handler only trusts Momo's own window", () => {
    // split the file at every handler so that neighbouring handlers can never hide each other
    const parts = main.split(/(?=ipcMain\.(?:on|handle)\("momo:)/).filter((p) => p.startsWith("ipcMain."));
    expect(parts.length).toBe(handled.size);
    for (const part of parts) {
      const channel = part.match(/^ipcMain\.(?:on|handle)\("(momo:[\w-]+)"/)![1];
      // the very first statement of the handler must be the sender check
      const body = part.slice(0, 320);
      expect(body, `handler ${channel} does not check the sender first`).toMatch(/fromOurWindow\(e\)|fromBar\(e\)/);
    }
  });

  it("the renderer gets no Node access and no generic IPC", () => {
    expect(main).toMatch(/contextIsolation:\s*true/);
    expect(main).toMatch(/nodeIntegration:\s*false/);
    expect(main).toMatch(/sandbox:\s*true/);
    expect(preload).not.toMatch(/exposeInMainWorld\([^)]*ipcRenderer\b(?!\.)/);
    expect(preload).not.toMatch(/require\("(fs|child_process|path|os)"\)/);
    // events from the shell to the page are an explicit, short list
    const toPage = new Set([...main.matchAll(/(?:webContents\.send|sendToSettings|sender\.send)\("(momo:[\w-]+)"/g)].map((m) => m[1]));
    expect([...toPage].sort()).toEqual(["momo:runtime-event", "momo:shortcut", "momo:stt-progress"]);
    // the one more channel, momo:cursor (where the shadow cursor draws), is sent from its own small window file only; the
    // preload re-checks its fixed shapes and it carries only a control's or window's name
    const cursorSends = [...read("electron/cursorWindow.cjs").matchAll(/webContents\.send\("(momo:[\w-]+)"/g)].map((m) => m[1]);
    expect(cursorSends).toEqual(["momo:cursor"]);
  });

  it("only the microphone permission is ever granted", () => {
    expect(main).toMatch(/permission === "media"/);
    expect(main).not.toMatch(/permission === "(geolocation|notifications|clipboard|midi|camera)/);
  });
});

describe("API keys from .env stay inside the desktop shell", () => {
  // the web page = everything under src/ except the Node-side runtime (src/runtime-core runs inside the desktop shell)
  const uiFiles = SOURCE.filter((f) => f.startsWith("src/") && !f.startsWith("src/runtime-core/"));

  it("the web page never reads environment variables or the .env file", () => {
    for (const f of uiFiles) {
      const code = strip(read(f));
      expect(code, f).not.toMatch(/process\.env/);
      expect(code, f).not.toMatch(/from ['"](node:)?(fs|path|os)['"]|readFile/); // the page has no file access at all
      // import.meta.env may only be used for the harmless build flags
      for (const m of code.matchAll(/import\.meta\.env\.(\w+)/g)) expect(["DEV", "PROD", "MODE", "BASE_URL"], `${f}: import.meta.env.${m[1]}`).toContain(m[1]);
    }
  });

  it("the build can only ever expose VITE_-prefixed variables, and no key uses that prefix", () => {
    expect(read("vite.config.ts")).toMatch(/envPrefix:\s*"VITE_"/);
    expect(read(".env.example")).not.toMatch(/^\s*VITE_/m);
  });

  it("the shell hands the page only the status object (booleans), never the values", () => {
    const main = strip(read("electron/main.cjs"));
    const handler = main.match(/ipcMain\.handle\("momo:env-status"[^\n]*\n/)![0];
    expect(handler).toContain("readEnv()");
    // readEnv returns envConfig.status(...), and the raw values are used nowhere that talks to the page
    expect(main).toMatch(/const s = envConfig\.status\(envValues, envFiles\);/);
    expect(main).toMatch(/\n  return s;\n\}/);
    const sends = [...main.matchAll(/webContents\.send\([^)]*\)/g)].map((m) => m[0]).join("\n");
    expect(sends).not.toMatch(/envValues|process\.env/);
    // every mention of the raw values is one of these uses: nothing else touches them
    const allowed = [/^let envValues = \{\};$/, /^const text = await transcribeCloud\(\{ key: envValues\.GROQ_API_KEY, audio: p\.audio\.slice\(\), language: p\.language \}\);$/, /^return synthOnline\(\{ key: envValues\.ELEVENLABS_API_KEY, text: p\.text, voiceId: p\.voiceId, budget: voiceBudget\(envValues\.MOMO_VOICE_MAX_CHARS_PER_DAY\) \}\);$/, /^envValues = r\.values;$/, /envConfig\.status\(envValues, envFiles\)/, /buildAiConfig\(envValues\)/];
    for (const line of main.split("\n").map((l) => l.trim()).filter((l) => l.includes("envValues"))) {
      expect(allowed.some((a) => a.test(line)), "unexpected use of envValues: " + line).toBe(true);
    }
    expect(strip(read("electron/preload.cjs"))).not.toMatch(/process\.env|envValues/);
  });

  it("the env loader neither logs nor writes anything (only save() writes, and only the keys the user typed)", () => {
    const env = strip(read("electron/env.cjs"));
    expect(env).not.toMatch(/console\./);
    expect(env).not.toMatch(/appendFile|createWriteStream|unlink/);
    // the only write is inside save(); load/parse/status are read-only
    expect(env.slice(0, env.indexOf("function save("))).not.toMatch(/writeFile/);
    // save() writes only whitelisted keys, validated first
    expect(env).toMatch(/if \(!EDITABLE\.includes\(k\)\)/);
    expect(env).not.toMatch(/fetch\(|require\(['"](node:)?(https?|net|dgram|tls)['"]\)|XMLHttpRequest|WebSocket/); // it never contacts anything
  });

  it("the keys screen is typed to booleans, so a value cannot be rendered", () => {
    const d = read("src/desktop.ts");
    const iface = d.match(/export interface EnvStatus \{[\s\S]*?\n\}/)![0];
    expect(iface).not.toMatch(/apiKey|token\s*:\s*string|secret|key\s*:\s*string/i);
    expect(iface.match(/string/g)!.length).toBeLessThanOrEqual(6); // provider names, file names, problem sentences only
  });
});

describe("secrets never live in the app", () => {
  it("no API keys or tokens in source or config", () => {
    const secretish = /\b(sk-[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,}|xox[baprs]-[A-Za-z0-9-]{10,})\b/;
    for (const f of [...SOURCE, "package.json", "vite.config.ts", ".gitignore"]) {
      expect(read(f), f).not.toMatch(secretish);
    }
  });
  it(".gitignore keeps keys, env files and the generated bundle out of git", () => {
    const g = read(".gitignore");
    for (const needle of [".env", "*.key", "*.pem", "secrets/", "electron/runtime.cjs"]) expect(g).toContain(needle);
  });
});
