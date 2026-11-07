import { describe, expect, it } from "vitest";
import path from "node:path";
import { createRequire } from "node:module";
const { resolveRequest, INDEX_URL, ORIGIN } = createRequire(import.meta.url)("./appProtocol.cjs");

const DIST = path.resolve("D:/app/dist");
const inside = (p) => p === DIST || p.startsWith(DIST + path.sep);

describe("momo:// serves only the built app", () => {
  it("maps ordinary requests to files inside dist", () => {
    expect(resolveRequest(DIST, INDEX_URL)).toBe(path.join(DIST, "index.html"));
    expect(resolveRequest(DIST, `${ORIGIN}/`)).toBe(path.join(DIST, "index.html"));
    expect(resolveRequest(DIST, `${ORIGIN}/assets/index-abc.js`)).toBe(path.join(DIST, "assets", "index-abc.js"));
    expect(resolveRequest(DIST, `${ORIGIN}/assets/mochi.placeholder-x1.glb`)).toBe(path.join(DIST, "assets", "mochi.placeholder-x1.glb"));
    expect(resolveRequest(DIST, `${ORIGIN}/ort/ort-wasm-simd-threaded.wasm`)).toBe(path.join(DIST, "ort", "ort-wasm-simd-threaded.wasm"));
    expect(resolveRequest(DIST, `${ORIGIN}/a%20b.png`)).toBe(path.join(DIST, "a b.png"));
  });

  it("refuses path traversal in every spelling", () => {
    for (const u of [
      `${ORIGIN}/../secret.txt`, `${ORIGIN}/assets/../../secret.txt`, `${ORIGIN}/%2e%2e/secret.txt`, `${ORIGIN}/%2E%2E%2Fsecret`,
      `${ORIGIN}/assets/..%2f..%2fsecret`, `${ORIGIN}/..%5csecret`, `${ORIGIN}/assets\\..\\..\\secret`,
    ]) {
      const r = resolveRequest(DIST, u);
      expect(r === null || inside(r), u).toBe(true);
      if (r) expect(path.relative(DIST, r).startsWith(".."), u).toBe(false);
    }
  });

  it("refuses drive letters, absolute paths, NULs, other hosts and other schemes", () => {
    for (const u of [`${ORIGIN}/C:/Windows/win.ini`, `${ORIGIN}/c%3A/Windows/win.ini`, `${ORIGIN}/%00`, "momo://evil/index.html",
      "file:///C:/Windows/win.ini", "https://app/index.html", "momo:///index.html", "not a url", ""]) {
      expect(resolveRequest(DIST, u), u).toBeNull();
    }
  });

  it("malformed escapes are rejected, not thrown", () => {
    expect(resolveRequest(DIST, `${ORIGIN}/%E0%A4%A`)).toBeNull();
  });
});
