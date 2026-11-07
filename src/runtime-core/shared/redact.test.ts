import { describe, expect, it } from "vitest";
import { redactSecrets } from "./redact";
import { cleanScreenText, collectText } from "./screenText";
import { sanitizeTitle } from "../desktop";
import { extractPage } from "../browser";

describe("redactSecrets", () => {
  it("hides payment card numbers that pass the Luhn check, with any separators", () => {
    expect(redactSecrets("Card 4111 1111 1111 1111 expires 12/29")).toBe("Card [card number hidden] expires 12/29");
    expect(redactSecrets("4111-1111-1111-1111")).toBe("[card number hidden]");
    expect(redactSecrets("4111111111111111")).toBe("[card number hidden]");
    expect(redactSecrets("378282246310005")).toBe("[card number hidden]"); // 15-digit
  });
  it("leaves ordinary long numbers alone", () => {
    for (const s of ["Order 1234567890123 shipped", "Total 4111 1111 1111 1112", "Phone 98765 43210", "Invoice 2026-11-05", "build 20261105123456789"]) {
      expect(redactSecrets(s), s).toBe(s);
    }
  });
  it("hides well-known API key and token formats", () => {
    expect(redactSecrets("key sk-abcdefghijklmnopqrstuv")).toBe("key [key hidden]");
    expect(redactSecrets("ghp_abcdefghijklmnopqrstuvwxyz0123456789")).toBe("[key hidden]");
    expect(redactSecrets("AKIAIOSFODNN7EXAMPLE")).toBe("[key hidden]");
    expect(redactSecrets("xoxb-1234567890-abcdefghij")).toBe("[key hidden]");
    expect(redactSecrets("Authorization eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U")).toBe("Authorization [token hidden]");
    expect(redactSecrets("-----BEGIN RSA PRIVATE KEY----- MIIEpAIBAAKCAQEA...")).toBe("[private key hidden]");
  });
  it("hides explicit password / token pairs but not ordinary sentences", () => {
    expect(redactSecrets("password: hunter2")).toBe("password: [hidden]");
    expect(redactSecrets("API_KEY=abc123def")).toBe("API_KEY: [hidden]");
    expect(redactSecrets("token = xyz")).toBe("token: [hidden]");
    expect(redactSecrets("Password is required")).toBe("Password is required");
    expect(redactSecrets("Enter your password")).toBe("Enter your password");
    expect(redactSecrets("Reset your password here")).toBe("Reset your password here");
  });
  it("never alters normal text", () => {
    const s = "Build failed: cannot find module 'foo' (0x80070005) at line 42, 3 files changed";
    expect(redactSecrets(s)).toBe(s);
  });
});

describe("redaction is applied to everything read from other programs", () => {
  it("screen lines, window titles and tab titles", () => {
    expect(cleanScreenText("Pay with 4111 1111 1111 1111 now")).toContain("[card number hidden]");
    expect(sanitizeTitle("Settings - api_key=sk-abcdefghijklmnopqrstuv")).not.toContain("sk-abc");
    const page = extractPage([{ type: "TabItem", name: "Console token: abc.def.ghi", enabled: true, offscreen: false, rid: "1" }]);
    expect(page.tabs[0].name).toBe("Console token: [hidden]");
    expect(collectText([{ type: "Text", name: "Your key is ghp_abcdefghijklmnopqrstuvwxyz0123456789", enabled: true, offscreen: false }])[0]).toContain("[key hidden]");
  });
  it("a secret can't be cut in half by the length cap", () => {
    const long = "x".repeat(150) + " sk-abcdefghijklmnopqrstuvwxyz0123456789";
    const out = cleanScreenText(long);
    expect(out).not.toMatch(/sk-/);
    expect(out).not.toMatch(/sk-abc/);
  });
});
