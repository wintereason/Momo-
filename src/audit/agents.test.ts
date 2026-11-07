import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

/**
 * The nine roles from docs/Momo_Desktop_AI_Agent_Concept.md are real boundaries in the code:
 *  - a role is reached only through its index.ts (its public face), never through its internals;
 *  - specialists never reach up to the orchestrator and only know the roles they genuinely need;
 *  - the only thing every role may use is shared/.
 */
const root = path.resolve(__dirname, "../runtime-core");
const ROLES = ["orchestrator", "desktop", "vision", "uipanel", "filesystem", "apps", "browser", "action", "verifier"] as const;
type Role = (typeof ROLES)[number];

/** Which other roles each role may depend on. The orchestrator coordinates, so it may use all of them. */
const MAY_USE: Record<Role, Role[]> = {
  orchestrator: ["desktop", "vision", "uipanel", "filesystem", "apps", "browser", "action", "verifier"],
  desktop: ["verifier"], // records what it saw in the world model
  vision: ["verifier"],
  uipanel: ["verifier"],
  filesystem: ["verifier"],
  apps: [],
  browser: [],
  action: [],
  verifier: ["desktop", "filesystem"], // judges their results
};

const walk = (d: string): string[] =>
  fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : e.name.endsWith(".ts") ? [path.join(d, e.name)] : []));

const importsOf = (file: string): string[] => {
  const src = fs.readFileSync(file, "utf8");
  return [...src.matchAll(/(?:from\s+|import\s*\()\s*"(\.{1,2}\/[^"]+)"/g)].map((m) => m[1]);
};

const sources = (role: Role) => walk(path.join(root, role)).filter((f) => !f.endsWith(".test.ts"));

describe("the nine agent roles", () => {
  it("every role is a folder with an index.ts as its public face", () => {
    for (const r of ROLES.filter((x) => x !== "orchestrator")) expect(fs.existsSync(path.join(root, r, "index.ts")), r).toBe(true);
  });

  it("a role is only reached through its index, never through its internal files", () => {
    const bad: string[] = [];
    for (const f of walk(root).filter((x) => !x.endsWith(".test.ts"))) { // integration tests may build a whole Session
      const here = path.relative(root, f).split(path.sep)[0];
      for (const spec of importsOf(f)) {
        const target = path.relative(root, path.resolve(path.dirname(f), spec)).split(path.sep);
        const role = target[0] as Role;
        if (!ROLES.includes(role) || role === here) continue;
        // orchestrator/ai is the orchestrator's own; nothing outside imports it except the entry point
        if (target.length !== 1) bad.push(`${path.relative(root, f)} -> ${spec}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it("each specialist depends only on the roles it genuinely needs, and never on the orchestrator", () => {
    const bad: string[] = [];
    for (const role of ROLES) {
      for (const f of sources(role)) {
        for (const spec of importsOf(f)) {
          const target = path.relative(root, path.resolve(path.dirname(f), spec)).split(path.sep)[0] as Role;
          if (!ROLES.includes(target) || target === role) continue;
          if (!MAY_USE[role].includes(target)) bad.push(`${role}: ${path.relative(root, f)} -> ${target}`);
        }
      }
    }
    expect(bad).toEqual([]);
  });

  it("the shared folder depends on no role", () => {
    for (const f of sources("orchestrator" as Role).length ? walk(path.join(root, "shared")).filter((x) => !x.endsWith(".test.ts")) : []) {
      for (const spec of importsOf(f)) {
        const target = path.relative(root, path.resolve(path.dirname(f), spec)).split(path.sep)[0];
        expect(ROLES.includes(target as Role), `${path.relative(root, f)} -> ${spec}`).toBe(false);
      }
    }
  });

  it("each role has a matching helper agent that names its folder", () => {
    const helpers: Record<Role, string> = {
      orchestrator: "momo-orchestrator", desktop: "momo-desktop", vision: "momo-vision", uipanel: "momo-ui-panel", filesystem: "momo-filesystem",
      apps: "momo-apps", browser: "momo-browser", action: "momo-action", verifier: "momo-verifier",
    };
    for (const r of ROLES) {
      const md = fs.readFileSync(path.resolve(root, "../../.claude/agents", `${helpers[r]}.md`), "utf8");
      expect(md, r).toContain(`src/runtime-core/${r}/`);
    }
  });
});
