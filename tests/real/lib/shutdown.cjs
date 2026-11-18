"use strict";
// Emergency shutdown for the acceptance suite: on Ctrl+C, a termination signal, an uncaught error or a normal exit, everything the run created is cleaned up
// (held input released, its processes ended, its directory removed) - exactly once. Kept apart from run.cjs so a self-check can drive the same code path.
function installShutdown({ ledger, getHarness = () => null, proc = process, exit = (c) => process.exit(c), log = (...a) => console.error(...a) }) {
  let cleaned = false;
  function emergency(why) {
    if (cleaned) return false;
    cleaned = true;
    try { const h = getHarness(); if (h) h.pointer.releaseAll(); } catch { /* nothing held */ }
    try { ledger.sweep(); } catch { /* the next run sweeps stale runs */ }
    if (why !== "exit") { log(`\nStopped (${why}): everything this run created was cleaned up.`); exit(why === "crash" ? 1 : 130); }
    return true;
  }
  proc.on("SIGINT", () => emergency("Ctrl+C"));
  proc.on("SIGTERM", () => emergency("terminated"));
  proc.on("uncaughtException", (e) => { log("Runner crashed:", (e && e.stack) || e); emergency("crash"); });
  proc.on("unhandledRejection", (e) => { log("Runner crashed:", (e && e.stack) || e); emergency("crash"); });
  proc.on("exit", () => emergency("exit"));
  return { emergency, markClean() { cleaned = true; }, isClean: () => cleaned };
}
module.exports = { installShutdown };
