/**
 * Phase 8b test kit: the REAL planner client, REAL AI service and REAL orchestrator, run against a made-up PC and a RECORDING fake `fetch`.
 *
 * Safety (read this before changing anything):
 *  - nothing here can reach a network: every request goes to the injected `fetchFn`, and the tests also replace the global `fetch` with a stub that throws;
 *  - every key is an obvious fake (FAKE_KEY), the config is built from a plain object and never from a .env file;
 *  - the "PC" is in memory: no real windows, files, screen, pictures, mouse or keyboard. Every private-looking value is a CANARY token, a made-up marker
 *    whose only purpose is to be searched for in what would have been sent;
 *  - results are reported as class names, counts and outcome labels. Request bodies are never printed or stored.
 */
import { Session } from "../runtime-core/orchestrator/session";
import { buildAiConfig } from "../runtime-core/orchestrator/ai/config";
import { LlmClient } from "../runtime-core/orchestrator/ai/llm";
import { createAiService, type AiService } from "../runtime-core/orchestrator/ai/service";
import type { PlanDecision } from "../runtime-core/orchestrator/ai/prompts";
import type { RuntimeEvent } from "../types/runtime-events";
import type { ActResult, BrowserProfile, FsPort, PointerPort, PointerResult, RawWindow, UiNode } from "../runtime-core/shared/ports";
import { popupWorld, tw, me, un } from "../runtime-core/orchestrator/popupWorld";

// ------------------------------------------------------------------------------------------------ canaries
/** Made-up private-looking values. Each class stands for one kind of private thing; a class name in a report means "this kind of thing reached the request". */
export const CANARY = {
  windowTitle: "CANARY-WINTITLE-4f2a",
  tabTitle: "CANARY-TAB-31d8",
  controlName: "CANARY-CTRL-9c1e",
  fieldText: "CANARY-FIELD-77b0",
  uiaText: "CANARY-UIATEXT-52ab",
  accountEmail: "CANARY-EMAIL-8d3f@example.test",
  profileName: "CANARY-PROFILE-5e21",
  fileName: "CANARY-FILE-resume",
  dirName: "CANARY-DIR-a7c4",
  menuItem: "CANARY-MENU-b903",
  dialogText: "CANARY-DIALOG-6d10",
  ocrText: "CANARY-OCR-2e6d",
  processName: "CANARY-PROC-e4f7",
} as const;
export type CanaryClass = keyof typeof CANARY;

/** which canary classes occur in a text (class names only, never values) */
export function leaked(text: string): CanaryClass[] {
  return (Object.keys(CANARY) as CanaryClass[]).filter((k) => text.includes(CANARY[k]));
}

/** an obviously fake key: it only has to appear in a header, and tests check it never appears anywhere else */
export const FAKE_KEY = "TEST-KEY-FAKE-0000-not-a-real-key";

// ------------------------------------------------------------------------------------------------ AI configurations (plain objects, no .env)
export const CLOUD_OFF = { MOMO_AI_ENABLED: "true", MOMO_AI_PROVIDER: "gemini", GEMINI_API_KEY: FAKE_KEY };
export const CLOUD_ON = { ...CLOUD_OFF, MOMO_AI_ALLOW_SCREEN_CONTEXT: "true" };
export const LOCAL_ONLY = { MOMO_AI_ENABLED: "true", MOMO_AI_PROVIDER: "ollama", OLLAMA_HOST: "http://localhost:11434", GEMINI_API_KEY: FAKE_KEY, GROQ_API_KEY: FAKE_KEY };

// ------------------------------------------------------------------------------------------------ the recording provider
export interface Recorded { url: string; body: string; headers: Record<string, string>; kind: "planner" | "vision" }
export interface Provider {
  fetchFn: typeof fetch;
  requests: Recorded[];
  planner: () => Recorded[];
  vision: () => Recorded[];
}

type Reply = { status?: number; body: unknown };
export interface ProviderOpts {
  /** the planner's answer to the n-th planner request (0-based). The args in it must never contain a canary. */
  script?: PlanDecision[] | ((n: number, userText: string) => PlanDecision);
  /** what the visual model answers */
  vision?: unknown;
  /** override every reply (an error status, a hostile body...) */
  override?: (rec: Recorded) => Reply | null;
}

/** the text of the LAST user message in a request body, whatever the provider's shape */
export function userText(body: string): string {
  try {
    const b = JSON.parse(body) as Record<string, unknown>;
    if (Array.isArray(b.contents)) { const c = b.contents[b.contents.length - 1] as { parts?: Array<{ text?: string }> }; return (c.parts ?? []).map((p) => p.text ?? "").join(""); }
    if (Array.isArray(b.messages)) { const m = b.messages[b.messages.length - 1] as { content?: unknown }; return typeof m.content === "string" ? m.content : JSON.stringify(m.content); }
  } catch { /* not JSON */ }
  return body;
}

const shape = (url: string, text: string): unknown => (url.includes("11434") ? { message: { content: text } } : { candidates: [{ content: { parts: [{ text }] }, finishReason: "STOP" }] });

export function makeProvider(o: ProviderOpts = {}): Provider {
  const requests: Recorded[] = [];
  let planned = 0;
  const fetchFn = (async (url: string, init: RequestInit) => {
    const body = String(init?.body ?? "");
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>)) headers[k.toLowerCase()] = String(v);
    const kind: Recorded["kind"] = /inlineData|image_url|"images"/.test(body) ? "vision" : "planner";
    const rec: Recorded = { url: String(url), body, headers, kind };
    requests.push(rec);
    const forced = o.override?.(rec);
    if (forced) return new Response(JSON.stringify(forced.body), { status: forced.status ?? 200 });
    if (kind === "vision") return new Response(JSON.stringify(shape(rec.url, JSON.stringify(o.vision ?? { kind: "icon_button", purpose: "opens settings", scope: null, confident: true, seen: "a gear" }))), { status: 200 });
    const n = planned++;
    const decision: PlanDecision = typeof o.script === "function" ? o.script(n, userText(body)) : (o.script ?? [{ type: "done", answer: "ok" }])[Math.min(n, (o.script ?? [0]).length - 1)] ?? { type: "done", answer: "ok" };
    return new Response(JSON.stringify(shape(rec.url, JSON.stringify(decision))), { status: 200 });
  }) as unknown as typeof fetch;
  return { fetchFn, requests, planner: () => requests.filter((r) => r.kind === "planner"), vision: () => requests.filter((r) => r.kind === "vision") };
}

export function makeService(values: Record<string, string>, fetchFn: typeof fetch): AiService {
  const config = () => buildAiConfig(values);
  const llm = new LlmClient({ config, usage: { load: () => ({ date: "", count: 0 }), save: () => {} }, fetchFn });
  return createAiService(llm, config);
}

// ------------------------------------------------------------------------------------------------ the made-up PC
const FILE_DIR = `C:\\Users\\me\\${CANARY.dirName}`;
export const FILE_PATH = (name: string) => `${FILE_DIR}\\${name}`;
const FILES = [`${CANARY.fileName}.docx`, `${CANARY.fileName}-old.docx`];

export interface WorldOpts {
  /** the made-up icon-only control sits on a window that also has a password field */
  password?: boolean;
  /** only one file matches the query (so open_path does not need to ask) */
  oneFile?: boolean;
  /** a richer PC: a real pointer with wheel and drag, a field that takes the cursor, a context menu, a file list, readable words, and the screen REACTS to what is done to it */
  rich?: boolean;
  /** (rich) the Body field already has the cursor */
  bodyFocused?: boolean;
}

/** A small PC: Notepad and Chrome windows, controls, tabs, browser accounts, a context menu, a file tree. Every private-looking value is a CANARY. */
export function makeWorld(o: WorldOpts = {}) {
  const NOTE = 20, CHROME = 21;
  const windows: RawWindow[] = [
    { hwnd: 999, pid: 999, process: "electron", title: "Momo", z: 9 },
    { hwnd: NOTE, pid: 20, process: "notepad", title: `${CANARY.windowTitle} - Notepad`, z: 0 },
    { hwnd: CHROME, pid: 21, process: "chrome", title: `${CANARY.tabTitle} - Google Chrome`, z: 1 },
  ];
  const node = (over: Partial<UiNode>): UiNode => ({ type: "Button", name: "", enabled: true, offscreen: false, rid: "r" + Math.random().toString(36).slice(2, 7), rect: { l: 100, t: 100, w: 100, h: 30 }, ...over });
  const pane = node({ type: "Pane", name: "", rid: undefined, rect: { l: 0, t: 0, w: 1920, h: 1000 } });
  const iconOnly = node({ type: "Button", name: "", rid: "icon1", rect: { l: 1850, t: 20, w: 40, h: 40 } });
  const ui: Record<number, UiNode[]> = {
    [NOTE]: [
      pane,
      node({ type: "Button", name: `Send ${CANARY.controlName}`, rid: "b1", rect: { l: 100, t: 100, w: 100, h: 30 } }),
      node({ type: "Edit", name: "Body", rid: "e1", value: CANARY.fieldText, rect: { l: 100, t: 200, w: 600, h: 200 } }),
      node({ type: "Text", name: CANARY.uiaText, rid: "t1", rect: { l: 100, t: 450, w: 300, h: 20 } }),
      iconOnly,
      ...(o.password ? [node({ type: "Edit", name: "Password", rid: "pw", password: true, rect: { l: 100, t: 500, w: 200, h: 24 } })] : []),
    ],
    [CHROME]: [
      pane,
      node({ type: "TabItem", name: CANARY.tabTitle, rid: "tab1", state: "selected", rect: { l: 10, t: 5, w: 200, h: 30 } }),
      node({ type: "TabItem", name: "Second tab", rid: "tab2", rect: { l: 220, t: 5, w: 200, h: 30 } }),
      node({ type: "Edit", name: "Address and search bar", rid: "addr", value: "https://example.test/", rect: { l: 100, t: 45, w: 800, h: 30 } }),
    ],
  };
  let active = NOTE;
  const rich = { hits: [] as string[], scrolls: [] as Array<{ x: number; y: number; notches: number }>, drags: [] as Array<{ from: { x: number; y: number }; to: { x: number; y: number } }>, submits: [] as Array<{ rid: string; name: string }>, focusCalls: [] as string[] };
  const log = { rich, captures: 0, openPaths: [] as string[], launches: [] as string[], focused: [] as number[], apps: [] as string[], urls: [] as string[] };

  const profiles: BrowserProfile[] = [{ dir: "Default", name: CANARY.profileName, email: CANARY.accountEmail }, { dir: "Profile 1", name: "Work", email: "other@example.test" }];
  const tree: Record<string, Array<{ name: string; isDir: boolean }>> = {
    "C:\\Users\\me": [{ name: CANARY.dirName, isDir: true }],
    [FILE_DIR]: (o.oneFile ? FILES.slice(0, 1) : FILES).map((name) => ({ name, isDir: false })),
  };
  const fs = {
    homeDir: () => "C:\\Users\\me",
    listDriveRoots: async () => ["C:\\", "D:\\"],
    statfs: async (root: string) => (root.startsWith("D") ? { total: 300 * 1024 ** 3, free: 200 * 1024 ** 3 } : { total: 100 * 1024 ** 3, free: 20 * 1024 ** 3 }),
    readDirs: async (p: string) => (tree[p] ?? []).filter((e) => e.isDir).map((e) => e.name),
    readEntries: async (p: string) => tree[p] ?? [],
    stat: async (p: string) => (p === FILE_DIR || p === "C:\\Users\\me" ? { isDir: true } : FILES.some((f) => p === FILE_PATH(f)) ? { isDir: false } : null),
  } as unknown as FsPort;

  // ---- the rich PC: what is on screen depends on what was done to it
  const rs = { scrolled: false, menu: false, focused: (o.bodyFocused ? "e1" : null) as string | null, dropped: false, textClicked: false };
  const FILE_NODE = node({ type: "ListItem", name: `${CANARY.fileName}-notes.txt`, rid: "f1", rect: { l: 100, t: 520, w: 300, h: 30 } });
  const DIR_NODE = node({ type: "ListItem", name: `${CANARY.dirName}-archive`, rid: "d1", rect: { l: 100, t: 560, w: 300, h: 30 } });
  const WORDS = [{ text: "Send", rect: { l: 900, t: 100, w: 60, h: 20 } }, { text: CANARY.ocrText, rect: { l: 900, t: 150, w: 120, h: 20 } }];
  const baseNotepad = ui[NOTE];
  const richNotepad = (): UiNode[] => [
    ...baseNotepad.map((n) => (n.rid === "e1" ? { ...n, focused: rs.focused === "e1" } : n.rid === "t1" && rs.scrolled ? { ...n, name: "Scrolled content" } : n)),
    ...(rs.dropped ? [] : [{ ...FILE_NODE, focused: rs.focused === "f1" }]), DIR_NODE,
    ...(rs.menu ? [node({ type: "MenuItem", name: "Open", rid: "m1", rect: { l: 160, t: 130, w: 100, h: 24 } }), node({ type: "MenuItem", name: "Delete", rid: "m2", rect: { l: 160, t: 154, w: 100, h: 24 } })] : []),
    ...(rs.textClicked ? [node({ type: "Text", name: "Opened", rid: "t9", rect: { l: 0, t: 0, w: 10, h: 10 } })] : []),
  ];
  if (o.rich) Object.defineProperty(ui, NOTE, { get: richNotepad, enumerable: true, configurable: true });
  const inRect = (r: { l: number; t: number; w: number; h: number } | undefined, x: number, y: number) => !!r && x >= r.l && x <= r.l + r.w && y >= r.t && y <= r.t + r.h;
  const hitRid = (x: number, y: number): string | undefined => { const hit = richNotepad().filter((n) => n.type !== "Pane" && inRect(n.rect, x, y)); return hit[hit.length - 1]?.rid; };

  const popups = [{ win: tw(50, "menu", { owner: NOTE, rootOwner: NOTE }), menu: [me(CANARY.menuItem), me("Copy")] }, { win: tw(51, "dialog", { owner: NOTE, rootOwner: NOTE }), ui: [un("Text", CANARY.dialogText), un("Button", "OK")] }];
  const w = popupWorld({ popups: () => (o.rich ? (rs.menu ? [popups[0]] : []) : popups) });
  const d = w.deps as unknown as Record<string, unknown> & { screen: Record<string, unknown>; input: Record<string, unknown>; launch: Record<string, unknown> };
  d.fs = fs;
  d.win = { query: async () => ({ activePid: windows.find((x) => x.hwnd === active)?.pid ?? null, activeHwnd: active, windows: windows.map((x) => ({ ...x })) }) };
  d.apps = { list: async () => [{ name: "Google Chrome", id: "Chrome" }, { name: "Calculator", id: "Calculator" }] };
  d.act = { openPath: async (p: string): Promise<string> => { log.openPaths.push(p); const h = 300 + log.openPaths.length; windows.push({ hwnd: h, pid: h, process: "winword", title: `${p.split("\\").pop()} - Word`, z: 0 }); active = h; return ""; } };
  d.launch = {
    launchApp: async (id: string): Promise<ActResult> => { log.apps.push(id); return { ok: true }; }, openFolderInVsCode: async () => ({ ok: true }), openUrl: async (u: string): Promise<ActResult> => { log.urls.push(u); return { ok: true }; },
    browserProfiles: async () => profiles,
    openBrowserProfile: async (): Promise<ActResult> => { log.launches.push("browser"); return { ok: true }; },
  };
  const baseScreen = d.screen;
  d.screen = {
    ...baseScreen,
    readUi: async (h: number) => (ui[h] ? { ok: true, items: ui[h].map((i) => ({ ...i })), truncated: false, hadPasswordField: !!o.password } : (baseScreen.readUi as (h: number) => Promise<unknown>)(h)),
    ocrRegion: async () => ({ ok: true, lines: [] }),
    ...(o.rich ? { ocrWords: async () => ({ ok: true, words: WORDS.map((x) => ({ text: x.text, rect: { ...x.rect } })) }) } : {}),
    capture: async () => { log.captures++; return { ok: true, png: "AAAA", width: 10, height: 10 }; },
  };
  const baseInput = d.input;
  d.input = {
    ...baseInput,
    focusWindow: async (h: number): Promise<ActResult> => { log.focused.push(h); active = h; return { ok: true }; },
    windowState: async (h: number) => { const x = windows.find((q) => q.hwnd === h); return { exists: !!x, minimized: false, pid: x?.pid ?? 0, foregroundPid: windows.find((q) => q.hwnd === active)?.pid ?? null, hung: false, modal: false }; },
  };
  if (o.rich) {
    const ok = { ok: true } as PointerResult;
    const baseInp = d.input as Record<string, unknown>;
    d.input = {
      ...baseInp,
      focusControl: async (_h: number, rid: string, name: string): Promise<ActResult> => { rich.focusCalls.push(`${rid}:${name}`); rs.focused = rid; return { ok: true }; },
      submitControl: async (_h: number, rid: string, name: string) => { rich.submits.push({ rid, name }); return { ok: true, changed: true }; },
    };
    const basePtr = (d.pointer as () => PointerPort)();
    const ptr: PointerPort = {
      ...basePtr,
      click: async (x, y, opts) => {
        const r = await basePtr.click(x, y, opts);
        if (!r.ok) return r;
        const rid = hitRid(x, y);
        rich.hits.push(rid ?? "none");
        if (opts.button === "right") rs.menu = true;
        else if (rid === "e1" || rid === "f1") rs.focused = rid;
        else if (!rid && inRect(WORDS[0].rect, x, y)) rs.textClicked = true;
        return r;
      },
      scroll: async (x, y, notches) => { rich.scrolls.push({ x, y, notches }); rs.scrolled = true; return ok; },
      drag: async (from, to) => { rich.drags.push({ from: { ...from }, to: { ...to } }); if (hitRid(from.x, from.y) === "f1" && hitRid(to.x, to.y) === "d1") rs.dropped = true; return ok; },
    };
    d.pointer = () => ptr;
  }
  return { deps: d, windows, ui, log, popupLog: w.log, NOTE, CHROME, setActive: (h: number) => { active = h; } };
}
export type World = ReturnType<typeof makeWorld>;

// ------------------------------------------------------------------------------------------------ running a goal
export function run(world: World, ai: AiService, extra: Record<string, unknown> = {}) {
  const events: RuntimeEvent[] = [];
  const session = new Session({ ...world.deps, emit: (e: RuntimeEvent) => events.push(e), selfPids: () => [999], ai, sleep: async () => {}, cursorLeadMs: () => 0, verifyAttempts: 2, ...extra } as never);
  session.setPolicy({ confirmReversible: false, confirmScreenRead: false });
  const taskId = () => { const e = [...events].reverse().find((x) => "taskId" in x) as { taskId: string } | undefined; return e?.taskId ?? ""; };
  const last = () => events[events.length - 1];
  const asked = () => events.filter((e) => e.type === "task.confirmation_required") as Array<{ taskId: string; summary: string }>;
  return { session, events, taskId, last, asked, say: (t: string) => session.handleTranscript("s", t), approve: (yes: boolean) => session.respondConfirmation(taskId(), yes) };
}

/** the outcome label the planner was shown for the first step, e.g. "OK (verified)", "FAILED": a label only, never the text */
export function firstOutcome(planner: Recorded[]): string {
  for (const r of planner.slice(1)) {
    const m = /\n1\. [a-z_]+ .*? -> (OK \(verified\)|done but NOT verified|FAILED|the user declined):/.exec(userText(r.body));
    if (m) return m[1];
  }
  return "no step reached the planner";
}

export const tool = (name: string, args: Record<string, unknown> = {}): PlanDecision => ({ type: "tool", tool: name, args });
export const done = (answer = "ok"): PlanDecision => ({ type: "done", answer });
export const WITHHELD_MARK = "Private result: not shown to the AI";
