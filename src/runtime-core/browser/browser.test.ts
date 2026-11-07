import { describe, expect, it } from "vitest";
import { extractPage, hostOf, isPrivateWindow, matchTabs, type TabInfo } from "./browserAgent";
import type { UiNode } from "../shared/ports";

const node = (o: Partial<UiNode>): UiNode => ({ type: "Text", name: "", enabled: true, ...o }) as UiNode;
const tab = (name: string): TabInfo => ({ name, selected: false, enabled: true });

describe("private windows are recognised in every browser's wording", () => {
  it("Chrome, Edge, Firefox, Opera and Vivaldi style titles", () => {
    for (const t of ["New Tab - Google Chrome (Incognito)", "Bing - InPrivate - Microsoft Edge", "Mozilla Firefox Private Browsing", "Speed Dial (Private) - Opera", "Start Page - Private - Vivaldi", "Private Window"]) {
      expect(isPrivateWindow(t), t).toBe(true);
    }
  });
  it("ordinary titles are not private", () => {
    for (const t of ["GitHub - Google Chrome", "Inbox - Gmail", "Momo project - Microsoft Edge"]) expect(isPrivateWindow(t), t).toBe(false);
  });
});

describe("the address bar", () => {
  it("is found by the browser's own names, not by an in-page field called 'URL'", () => {
    const items = [node({ type: "Edit", name: "URL", value: "https://evil.example/phish" }), node({ type: "Edit", name: "Address and search bar", value: "github.com" })];
    expect(extractPage(items).address).toBe("github.com");
    expect(extractPage([node({ type: "Edit", name: "Location", value: "somewhere" })]).address).toBeUndefined();
  });
});

describe("hostOf reads only real web addresses", () => {
  it("accepts web addresses", () => {
    expect(hostOf("https://www.github.com/a/b?token=1")).toBe("github.com");
    expect(hostOf("github.com")).toBe("github.com");
    expect(hostOf("localhost:3000")).toBe("localhost");
  });
  it("refuses search phrases, odd schemes and bare words", () => {
    for (const a of ["cats and dogs", "javascript:alert(1)", "file:///C:/x", "chrome://settings", "about:blank", "ftp://x.com", "intranet", ""]) expect(hostOf(a), a).toBeUndefined();
  });
});

describe("matching tabs", () => {
  const tabs = [tab("Gmail - Inbox"), tab("Mailchimp"), tab("GitHub")];
  it("an exact title wins, several partial matches are all returned so the caller asks", () => {
    expect(matchTabs(tabs, "github")).toHaveLength(1);
    expect(matchTabs(tabs, "mail").map((t) => t.name)).toEqual(["Gmail - Inbox", "Mailchimp"]);
  });
  it("a one-letter query matches nothing instead of nearly everything", () => {
    expect(matchTabs(tabs, "g")).toEqual([]);
    expect(matchTabs(tabs, "")).toEqual([]);
  });
});
