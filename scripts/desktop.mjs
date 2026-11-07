// Starts the Vite dev server (if not already up) and launches the Electron shell against it.
import { spawn } from "node:child_process";
import http from "node:http";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const url = "http://localhost:5173";

const isUp = () => new Promise((r) => {
  http.get(url, (res) => { res.resume(); r(true); }).on("error", () => r(false));
});

let vite = null;
if (!(await isUp())) {
  // (vite's package "exports" hides bin/vite.js from require.resolve, so use the file's real location)
  vite = spawn(process.execPath, [path.join(root, "node_modules", "vite", "bin", "vite.js"), "--port", "5173", "--strictPort"], { cwd: root, stdio: "inherit" });
  for (let i = 0; i < 60 && !(await isUp()); i++) await new Promise((r) => setTimeout(r, 500));
  if (!(await isUp())) { console.error("The dev server did not start."); vite.kill(); process.exit(1); }
}

const electronPath = require("electron");
const app = spawn(electronPath, ["."], { cwd: root, stdio: "inherit", env: { ...process.env, MOMO_DEV_URL: url } });
app.on("exit", (code) => { vite?.kill(); process.exit(code ?? 0); });
