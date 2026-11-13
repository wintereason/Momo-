import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
const { save, load, status } = createRequire(import.meta.url)("./env.cjs");

const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "momo-env-")), "sub", ".env");
const GROQ = "gsk_" + "a".repeat(30);
const GEM = "AIza" + "b".repeat(35);

describe("saving keys from the Settings page", () => {
  it("creates the file, saves a valid key, and the app then sees it (status shows only yes/no)", () => {
    const f = tmp();
    expect(save(f, { GROQ_API_KEY: GROQ, MOMO_AI_ENABLED: "true", MOMO_AI_PROVIDER: "groq" })).toEqual({ ok: true, problems: [] });
    const r = load({ files: [f], processEnv: {} });
    expect(r.values.GROQ_API_KEY).toBe(GROQ);
    const s = status(r.values, r.files);
    expect(s.ai).toMatchObject({ enabled: true, provider: "groq", ready: true, keys: { groq: true, gemini: false } });
    expect(JSON.stringify(s)).not.toContain(GROQ);
  });
  it("replaces a key in place and keeps comments and other lines", () => {
    const f = tmp();
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, "# my notes\nGEMINI_API_KEY=" + GEM + "\nHF_TOKEN=hf_" + "c".repeat(30) + "\nSOMETHING_ELSE=keep\n");
    save(f, { GEMINI_API_KEY: "AIza" + "z".repeat(35) });
    const t = fs.readFileSync(f, "utf8");
    expect(t).toContain("# my notes");
    expect(t).toContain("SOMETHING_ELSE=keep");
    expect(t).toContain("HF_TOKEN=hf_" + "c".repeat(30));
    expect(t).toContain("AIza" + "z".repeat(35));
    expect(t).not.toContain(GEM);
    expect(t.match(/GEMINI_API_KEY/g)).toHaveLength(1);
  });
  it("an empty value removes the key", () => {
    const f = tmp();
    save(f, { GROQ_API_KEY: GROQ });
    save(f, { GROQ_API_KEY: "" });
    expect(fs.readFileSync(f, "utf8")).not.toContain("GROQ_API_KEY");
  });
  it("a bad key is refused with a plain message, nothing is written, and the message never contains the value", () => {
    const f = tmp();
    const r = save(f, { GROQ_API_KEY: "not-a-key-123", GEMINI_API_KEY: GEM });
    expect(r.ok).toBe(false);
    expect(r.problems.join(" ")).toMatch(/GROQ_API_KEY should start with gsk_/);
    expect(r.problems.join(" ")).not.toContain("not-a-key-123");
    expect(fs.existsSync(f)).toBe(false); // all-or-nothing
  });
  it("only the known editable settings can be changed, and values must be one line", () => {
    const f = tmp();
    expect(save(f, { PATH: "x" }).ok).toBe(false);
    expect(save(f, { GROQ_API_KEY: GROQ + "\nEVIL=1" }).ok).toBe(false);
    expect(fs.existsSync(f)).toBe(false);
  });
});
