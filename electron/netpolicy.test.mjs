import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
const { makeAllowedRequest, ALLOWED_HOSTS } = createRequire(import.meta.url)("./netpolicy.cjs");

describe("network allowlist (production)", () => {
  const ok = makeAllowedRequest(null);
  it("allows the app's own files and the speech-model host", () => {
    for (const u of ["file:///D:/app/dist/index.html", "momo://app/index.html", "momo://app/assets/mochi.glb", "data:image/png;base64,AAAA", "blob:file:///abc",
      "https://huggingface.co/Xenova/whisper-base/resolve/main/tokenizer.json",
      "https://cdn-lfs.huggingface.co/x", "https://cas-bridge.xethub.hf.co/y"]) {
      expect(ok(u), u).toBe(true);
    }
  });
  it("blocks everything else: analytics, trackers, other sites, plain http", () => {
    for (const u of ["https://www.google-analytics.com/collect", "https://example.com/", "http://huggingface.co/x",
      "https://api.openai.com/v1", "wss://evil.example/socket", "ftp://huggingface.co/x", "http://localhost:5173/",
      "https://localhost:8443/", "momo://evil/index.html", "momo://app.evil.com/x"]) {
      expect(ok(u), u).toBe(false);
    }
  });
  it("is not fooled by look-alike hosts", () => {
    for (const u of ["https://huggingface.co.attacker.io/", "https://evilhuggingface.co/", "https://hf.co.evil.com/",
      "https://nothf.co/", "https://huggingface.com/", "https://x.huggingface.co.evil.net/", "https://huggingface.co@evil.com/"]) {
      expect(ok(u), u).toBe(false);
    }
  });
  it("rejects garbage", () => {
    for (const u of ["", "not a url", "javascript:alert(1)", "//evil.com"]) expect(ok(u), u).toBe(false);
  });
  it("the allowlist is exactly the speech-model host family", () => {
    expect([...ALLOWED_HOSTS].sort()).toEqual([".hf.co", ".huggingface.co", "huggingface.co"]);
  });
});

describe("network allowlist (development)", () => {
  const ok = makeAllowedRequest("http://localhost:5173");
  it("also allows only the local dev server and its hot-reload socket", () => {
    expect(ok("http://localhost:5173/src/main.tsx")).toBe(true);
    expect(ok("ws://localhost:5173/?token=x")).toBe(true);
    expect(ok("http://localhost:9999/")).toBe(false);
    expect(ok("http://127.0.0.1:5173/")).toBe(false);
    expect(ok("https://example.com/")).toBe(false);
  });
});
