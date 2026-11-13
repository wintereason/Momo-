import { describe, expect, it } from "vitest";
import { LANGUAGES, languageName, wrongScript } from "./languages";

describe("languages", () => {
  it("has unique codes that the settings accept", () => {
    const codes = LANGUAGES.map((l) => l.code);
    expect(new Set(codes).size).toBe(codes.length);
    expect(codes.every((c) => /^[a-z]{2,3}$/.test(c))).toBe(true);
    expect(languageName("hi")).toBe("Hindi");
    expect(languageName("auto")).toBe("Detect automatically");
  });
  it("flags Hindi that came back in Urdu letters, and nothing else", () => {
    expect(wrongScript("hi", "میں بازار گیا تھا")).toBe(true);
    expect(wrongScript("hi", "मैं बाज़ार गया था")).toBe(false);
    expect(wrongScript("hi", "main bazaar gaya tha")).toBe(false); // Hinglish is fine
    expect(wrongScript("hi", "मैं office गया")).toBe(false);
    expect(wrongScript("ur", "میں بازار گیا تھا")).toBe(false);
    expect(wrongScript("en", "hello")).toBe(false);
    expect(wrongScript("mr", "")).toBe(false);
    expect(wrongScript("ta", "मैं बाज़ार")).toBe(true);
  });
});
