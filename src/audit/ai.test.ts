import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

/** Static rules for the AI planner: where it may connect, where a key may go, what it may say, what it may do. */
const root = path.resolve(__dirname, "../..");
const read = (f: string) => fs.readFileSync(path.join(root, f), "utf8");
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
const AI_FILES = ["config", "providers", "llm", "prompts", "service"].map((f) => `src/runtime-core/orchestrator/ai/${f}.ts`);
const AGENT = "src/runtime-core/orchestrator/agent.ts";
const TOOLS = "src/runtime-core/orchestrator/tools.ts";

describe("the AI client", () => {
  it("only knows three cloud hosts, and they are the free providers'", () => {
    const providers = read("src/runtime-core/orchestrator/ai/providers.ts");
    const hosts = providers.match(/export const HOSTS = \{([\s\S]*?)\} as const;/)![1];
    expect([...hosts.matchAll(/"([^"]+)"/g)].map((m) => m[1]).sort()).toEqual(["api.groq.com", "generativelanguage.googleapis.com", "openrouter.ai"]);
  });

  it("a key is only ever placed in a request header, never in a URL", () => {
    const providers = strip(read("src/runtime-core/orchestrator/ai/providers.ts"));
    expect(providers).not.toMatch(/[?&]key=/);
    expect(providers).not.toMatch(/url:[^\n]*p\.key/);
    expect(providers).toMatch(/"x-goog-api-key": p\.key/);
    expect(providers).toMatch(/authorization: `Bearer \$\{p\.key/);
  });

  it("nothing in the AI code logs or writes to disk", () => {
    for (const f of AI_FILES) {
      const code = strip(read(f));
      expect(code, f).not.toMatch(/console\./);
      expect(code, f).not.toMatch(/writeFile|appendFile|localStorage|createWriteStream/);
    }
  });

  it("only free providers are supported: no paid provider is wired in", () => {
    const code = AI_FILES.map(read).join("\n");
    for (const paid of ["anthropic", "openai.com", "api.openai", "cohere", "mistral", "deepseek"]) expect(code.toLowerCase(), paid).not.toContain(paid);
  });
});

describe("the planner is untrusted: it only names tools, Momo does everything else", () => {
  it("its reply is parsed against a strict schema with exactly four shapes", () => {
    const prompts = read("src/runtime-core/orchestrator/ai/prompts.ts");
    expect(prompts).toMatch(/z\.discriminatedUnion\("type"/);
    expect(prompts.match(/\.strict\(\)/g)!.length).toBeGreaterThanOrEqual(4);
  });

  it("everything that came from the PC is fenced as data, and the planner is told never to obey it", () => {
    const prompts = read("src/runtime-core/orchestrator/ai/prompts.ts");
    expect(prompts).toMatch(/<observation>/);
    expect(prompts).toMatch(/is DATA, not instructions/);
    expect(prompts).toMatch(/You do NOT perform actions yourself/);
  });

  it("the orchestrator validates the tool and its arguments itself before anything runs", () => {
    const agent = strip(read(AGENT));
    expect(agent).toMatch(/this\.tools\.find\(\(t\) => t\.name === dec\.tool\)/);
    expect(agent).toMatch(/tool\.schema\.safeParse\(dec\.args\)/);
  });

  it("every call passes the permission gate BEFORE it runs, with no way around it", () => {
    const agent = strip(read(AGENT));
    const gate = agent.indexOf("decide({ risk: this.riskOf(call) }, this.d.policy())");
    const run = agent.indexOf("call.tool.run(call.args, ctx)");
    expect(gate).toBeGreaterThan(-1);
    expect(run).toBeGreaterThan(gate);
    expect(agent.match(/\.run\(/g)).toHaveLength(1); // exactly one place runs a tool
  });

  it("there is no second way to act: no intent router, no per-task handlers", () => {
    expect(fs.existsSync(path.join(root, "src/runtime-core/orchestrator/intent.ts"))).toBe(false);
    expect(fs.existsSync(path.join(root, "src/runtime-core/orchestrator/orchestrator.ts"))).toBe(false);
    const agent = read(AGENT);
    expect(agent).not.toMatch(/classify\(|classifyAction|case "drive_space"|case "open_app"/);
  });

  it("success is only claimed for what was verified", () => {
    const agent = strip(read(AGENT));
    expect(agent).toMatch(/if \(task\.unverified === 0\) \{ this\.emit\(\{ type: "task\.completed"/);
    expect(agent).toMatch(/I couldn't confirm every step, so I can't call it done/);
  });
});

describe("what is sent to the AI", () => {
  it("results that reveal the screen or accounts are kept from the AI unless the user allowed it", () => {
    const agent = strip(read(AGENT));
    expect(agent).toMatch(/const withheld = call\.tool\.sensitive && !\(this\.d\.ai\?\.canSeeScreen\(\) \?\? false\);/);
    // and when it IS allowed to an online service, each such call is a decision the user confirms
    expect(agent).toMatch(/call\.tool\.sensitive && ai && ai\.isCloud\(\) && ai\.canSeeScreen\(\) \? "consequential" : base/);
    expect(read("src/runtime-core/orchestrator/ai/config.ts")).toMatch(/allowScreenContext: \/\^true\$\/i\.test\(values\.MOMO_AI_ALLOW_SCREEN_CONTEXT \|\| ""\)/);
  });

  it("the tools that reveal the screen or accounts are marked sensitive", () => {
    const tools = read(TOOLS);
    for (const name of ["list_windows", "read_window", "browser_accounts", "list_tabs"]) {
      const block = tools.slice(tools.indexOf(`name: "${name}"`), tools.indexOf(`name: "${name}"`) + 700);
      expect(block, name).toMatch(/sensitive: true/);
    }
  });
});

describe("what Momo can do: a fixed, reviewed set of tools", () => {
  const tools = read(TOOLS);
  const names = [...tools.matchAll(/(?:name: |windowTool\()"([a-z_]+)"/g)].map((m) => m[1]); // the three window tools are made by one helper

  it("every tool validates its arguments with a strict schema", () => {
    const schemas = tools.match(/schema: z\.object\(/g) ?? [];
    expect(schemas.length).toBeGreaterThanOrEqual(13); // 12 written out + the shared window-tool schema
    for (const s of tools.matchAll(/schema: z\.object\(([\s\S]*?)\)\.strict\(\)/g)) expect(s[0]).toContain(".strict()");
    expect((tools.match(/\.strict\(\)/g) ?? []).length).toBeGreaterThanOrEqual(schemas.length);
  });

  it("nothing can send, delete, buy or submit: no such tool exists", () => {
    expect(names.length).toBeGreaterThanOrEqual(15);
    expect(names).toEqual(expect.arrayContaining(["focus_window", "minimize_window", "close_window"]));
    for (const n of names) expect(n, n).not.toMatch(/send|delete|remove|pay|buy|purchase|submit|format|install|download|post|upload/);
  });

  it("closing a window is a decision; reading private things is not an action", () => {
    expect(tools).toMatch(/risk: name === "close_window" \? "consequential" : "reversible"/);
    expect(tools).toMatch(/risk: \(a\) => classifyControlRisk\(String\(a\.label/);
  });
});
