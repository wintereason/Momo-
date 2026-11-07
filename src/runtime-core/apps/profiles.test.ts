import { describe, expect, it } from "vitest";
import { browserKeyFor, hintWords, isProfileDir, matchProfileHint, parseProfiles, profileLabels, siteUrl } from "./index";

const localState = {
  profile: {
    info_cache: {
      "Profile 2": { name: "Work", user_name: "me@work.example" },
      Default: { name: "Person 1", user_name: "" },
      "Profile 10": { name: "Study", user_name: "me@gmail.example" },
      "../../evil": { name: "Evil" },
      "Profile 3": { name: "Work", user_name: "" },
    },
  },
};

describe("browser profiles", () => {
  it("reads profiles from the browser's Local State, in a sensible order, and ignores odd folder names", () => {
    const p = parseProfiles(localState);
    expect(p.map((x) => x.dir)).toEqual(["Default", "Profile 2", "Profile 3", "Profile 10"]);
    expect(p[1]).toEqual({ dir: "Profile 2", name: "Work", email: "me@work.example" });
    expect(p.find((x) => x.dir.includes(".."))).toBeUndefined();
  });
  it("survives missing or strange data", () => {
    for (const junk of [null, 5, "x", {}, { profile: {} }, { profile: { info_cache: 3 } }, { profile: { info_cache: { Default: null } } }]) expect(parseProfiles(junk)).toEqual([]);
  });
  it("tells same-named profiles apart by email or folder", () => {
    expect(profileLabels(parseProfiles(localState))).toEqual(["Person 1", "me@work.example (Work)", "Work (Profile 3)", "me@gmail.example (Study)"]);
  });
  it("only Default and Profile N are valid profile folders", () => {
    for (const ok of ["Default", "Profile 1", "Profile 12"]) expect(isProfileDir(ok), ok).toBe(true);
    for (const bad of ["", "Profile", "Profile x", "..\\Default", "Default --kiosk", "Profile 1; calc", "System Profile", 5]) expect(isProfileDir(bad), String(bad)).toBe(false);
  });
  it("knows which apps are Chromium browsers", () => {
    expect(browserKeyFor("Google Chrome")).toBe("chrome");
    expect(browserKeyFor("Microsoft Edge")).toBe("msedge");
    expect(browserKeyFor("Brave")).toBe("brave");
    expect(browserKeyFor("Notepad")).toBeNull();
  });
});

const avatars = parseProfiles({ profile: { info_cache: {
  "Profile 4": { name: "Person 2", user_name: "a@x.example", avatar_icon: "chrome://theme/IDR_PROFILE_AVATAR_33", is_using_default_avatar: false },
  "Profile 8": { name: "Study", user_name: "b@x.example", avatar_icon: "chrome://theme/IDR_PROFILE_AVATAR_27", is_using_default_avatar: false },
  "Profile 13": { name: "Auto", user_name: "c@x.example", avatar_icon: "chrome://theme/IDR_PROFILE_AVATAR_33", is_using_default_avatar: true },
  "Profile 14": { name: "Work", user_name: "d@work.example", avatar_icon: "chrome://theme/IDR_PROFILE_AVATAR_26", is_using_default_avatar: true },
} } });

describe("matching a description to an account", () => {
  it("knows a picture the user chose, but not an automatic one", () => {
    expect(avatars.map((p) => [p.dir, p.avatar])).toEqual([["Profile 4", "panda"], ["Profile 8", "cat"], ["Profile 13", undefined], ["Profile 14", undefined]]);
  });
  it("keeps only the words that describe: 'the panda face icon email' is 'panda'", () => {
    expect(hintWords("the panda face icon email")).toEqual(["panda"]);
    expect(hintWords("go to my work account")).toEqual(["work"]);
    expect(hintWords("the icon")).toEqual([]);
  });
  it("matches words in the name or email first, then the picture", () => {
    expect(matchProfileHint(avatars, "work account")).toMatchObject({ by: "text", matches: [{ dir: "Profile 14" }] });
    expect(matchProfileHint(avatars, "panda face icon")).toMatchObject({ by: "avatar", matches: [{ dir: "Profile 4" }] });
    expect(matchProfileHint(avatars, "cat").by).toBe("avatar");
    expect(matchProfileHint(avatars, "unicorn")).toEqual({ matches: [], by: "none" });
    expect(matchProfileHint(avatars, "the icon")).toEqual({ matches: [], by: "none" });
  });
});

describe("well-known websites by name", () => {
  it("youtube, gmail and friends; addresses still work; nonsense does not", () => {
    expect(siteUrl("youtube")).toEqual({ url: "https://www.youtube.com/", host: "youtube.com" });
    expect(siteUrl("the youtube website")?.host).toBe("youtube.com");
    expect(siteUrl("gmail")?.host).toBe("mail.google.com");
    expect(siteUrl("github.com")?.host).toBe("github.com");
    expect(siteUrl("panda face icon")).toBeNull();
  });
});
