import { describe, expect, it } from "vitest";
import { HELPER_SCRIPT, UiaHost } from "./uiaHelper";

/**
 * The helper's process handling, against a fake host that speaks the same line protocol ("<id> <command>" -> "@@<id> <json>").
 * (The real UI Automation reader is checked on real windows: see docs/08_AGENT_ARCHITECTURE.md.)
 */
const FAKE = String.raw`
process.stdout.write("@@READY\n");
const rl = require("readline").createInterface({ input: process.stdin });
rl.on("line", (l) => {
  const [id, cmd, arg] = l.split(" ");
  if (cmd === "echo") process.stdout.write("@@" + id + " " + JSON.stringify({ ok: true, arg, pid: process.pid }) + "\n");
  else if (cmd === "bad") process.stdout.write("@@" + id + " not json\n");
  else if (cmd === "die") process.exit(1);
  else if (cmd === "events") {
    process.stdout.write("@@" + id + " " + JSON.stringify({ ok: arg === "on" || arg === "off", on: arg === "on" }) + "\n");
    if (arg === "on") {
      if (!process.env.NO_BEAT) process.stdout.write("@@!H 1\n");
      process.stdout.write('@@!E {"n":1,"e":[["show",42],["name",43]]}\n');
      process.stdout.write("@@!E not json\n");
    }
  }
  else if (cmd === "burst") { process.stdout.write('@@!E {"n":2,"many":true,"e":[]}\n'); process.stdout.write("@@" + id + " {}\n"); }
  /* "hang": never answers */
});
`;
const host = (over: ConstructorParameters<typeof UiaHost>[0] = {}) => new UiaHost({ command: process.execPath, args: () => ["-e", FAKE], ...over });

describe("the long-lived UI Automation helper process", () => {
  it("answers requests one at a time over a single long-lived process", async () => {
    const h = host();
    const [a, b, c] = await Promise.all([h.request<{ arg: string; pid: number }>("echo one", 5000), h.request<{ arg: string; pid: number }>("echo two", 5000), h.request<{ arg: string; pid: number }>("echo three", 5000)]);
    expect([a.arg, b.arg, c.arg]).toEqual(["one", "two", "three"]);
    expect(new Set([a.pid, b.pid, c.pid]).size).toBe(1); // the same process served all three: no new start per request
    expect(h.stats()).toMatchObject({ starts: 1, requests: 3, failures: 0, running: true });
    h.stop();
  });

  it("a hung request is rejected on time and takes the helper down, and the next request starts a fresh one", async () => {
    const h = host();
    const first = await h.request<{ pid: number }>("echo x", 5000);
    await expect(h.request("hang", 300)).rejects.toThrow(/timeout/);
    expect(h.stats().running).toBe(false); // a stuck UI Automation call cannot be cancelled from outside: the process is stopped
    const second = await h.request<{ pid: number }>("echo y", 5000);
    expect(second.pid).not.toBe(first.pid);
    expect(h.stats().starts).toBe(2);
    h.stop();
  });

  it("a helper that crashes rejects what was waiting, and recovers on the next request", async () => {
    const h = host();
    await h.request("echo warm", 5000);
    await expect(h.request("die", 5000)).rejects.toThrow();
    await expect(h.request<{ arg: string }>("echo back", 5000)).resolves.toMatchObject({ arg: "back" });
    h.stop();
  });

  it("an unreadable answer is a failure, not a crash", async () => {
    const h = host();
    await expect(h.request("bad", 5000)).rejects.toThrow(/unreadable/);
    await expect(h.request<{ arg: string }>("echo ok", 5000)).resolves.toMatchObject({ arg: "ok" });
    h.stop();
  });

  it("a helper that cannot start cools off: requests fail fast (callers use the one-shot script) instead of retrying every time", async () => {
    const h = new UiaHost({ command: process.execPath, args: () => ["-e", "process.exit(3)"] });
    await expect(h.request("echo x", 5000)).rejects.toThrow();
    expect(h.usable()).toBe(false);
    const t0 = Date.now();
    await expect(h.request("echo x", 5000)).rejects.toThrow(/unavailable/);
    expect(Date.now() - t0).toBeLessThan(200);
  });

  it("can be switched off, and then never starts a process", async () => {
    const h = host({ enabled: () => false });
    expect(h.usable()).toBe(false);
    await expect(h.request("echo x", 5000)).rejects.toThrow(/unavailable/);
    expect(h.stats().starts).toBe(0);
  });

  it("change events: the hook is switched on only while something waits, events arrive as handles only, health needs a heartbeat", async () => {
    const h = host();
    expect(h.healthy()).toBe(false); // nothing asked for events yet
    const release = h.acquire();
    await new Promise((r) => setTimeout(r, 400));
    expect(h.healthy()).toBe(true);
    const got = await h.next(0, 1000);
    expect(got.events).toEqual([{ kind: "show", root: 42 }, { kind: "name", root: 43 }]); // an unreadable event line is ignored, not fatal
    expect(h.seq()).toBe(1);
    release();
    h.stop();
    expect(h.healthy()).toBe(false); // a stopped helper never counts as healthy
  });

  it("without a heartbeat events are NOT trusted (the message loop may be stuck): waits poll instead", async () => {
    process.env.NO_BEAT = "1";
    try {
      const h = host();
      const release = h.acquire();
      await new Promise((r) => setTimeout(r, 400));
      expect(h.healthy()).toBe(false);
      release(); h.stop();
    } finally { delete process.env.NO_BEAT; }
  });

  it("a crashed or hung helper makes events unhealthy at once, and a restart does not pretend events are still on", async () => {
    const h = host();
    h.acquire();
    await new Promise((r) => setTimeout(r, 400));
    expect(h.healthy()).toBe(true);
    await expect(h.request("die", 3000)).rejects.toThrow();
    expect(h.healthy()).toBe(false);
    await h.request("echo again", 5000); // restarted for a normal request: events stay off until someone waits again
    expect(h.healthy()).toBe(false);
    h.stop();
  });

  it("dropped events (the helper's overflow flag) become a visible 'many' change, never silence", async () => {
    const h = host();
    await h.request("burst", 5000);
    const got = await h.next(0, 500);
    expect(got.events.map((e) => e.kind)).toContain("many");
    h.stop();
  });

  it("next() with nothing happening returns empty after its time, never hangs", async () => {
    const h = host();
    const t0 = Date.now();
    const r = await h.next(h.seq(), 150);
    expect(r.events).toEqual([]);
    expect(Date.now() - t0).toBeLessThan(600);
  });

  it("the event hook code reports kinds and window handles only: it never reads titles, text or pixels, and never touches the network", () => {
    const part = HELPER_SCRIPT.slice(HELPER_SCRIPT.indexOf("public static class MomoEvents"), HELPER_SCRIPT.indexOf("@@READY"));
    expect(part.length).toBeGreaterThan(500);
    expect(part).not.toMatch(/GetWindowText|AutomationElement|CopyFromScreen|Bitmap|BitBlt|WebClient|System.Net|File.|Process.GetProcesses/);
    expect(part).toContain("SetWinEventHook");
    expect(part).toContain("@@!H"); // the heartbeat that lets the Node side distrust a stuck loop
  });

  it("the real host script reads UI Automation through the same cached reader and lists windows (checked on Windows PCs only)", () => {
    // the protocol commands the Node side depends on
    for (const cmd of ["'uia'", "'windows'", "'state'", "'ping'", "'events'"]) expect(HELPER_SCRIPT).toContain(cmd);
    expect(HELPER_SCRIPT).toContain("@@READY");
    // never reads or sends anything over the network, never writes files
    expect(HELPER_SCRIPT).not.toMatch(/Invoke-WebRequest|Invoke-RestMethod|WebClient|System.Net|Out-File|Set-Content|WriteAllText/);
    // nothing that looks like an obfuscated launcher (Windows Defender refuses to start those)
    expect(HELPER_SCRIPT).not.toMatch(/FromBase64String|Invoke-Expression|iex/i);
  });
});
