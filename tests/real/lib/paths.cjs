"use strict";
// Paths shared by the real-Windows acceptance suite. Nothing here touches the disk.
const path = require("path");
const os = require("os");

const REAL = path.resolve(__dirname, "..");            // tests/real
const ROOT = path.resolve(REAL, "..", "..");           // the project root
module.exports = {
  ROOT,
  REAL,
  APPS: path.join(REAL, "apps"),
  CASES: path.join(REAL, "cases"),
  MANUAL: path.join(REAL, "manual"),
  RESULTS: path.join(REAL, "results"),
  /** every run keeps ALL of its files (fixtures' state, Chrome profile, test folders) under one directory here */
  TMP_ROOT: path.join(os.tmpdir(), "momo-real"),
  RUNTIME: path.join(ROOT, "electron", "runtime.cjs"),
  /** the prefix of every window title and command line the suite creates: the cleanup finds its own things by this and nothing else */
  TAG_PREFIX: "momo-real-",
};
