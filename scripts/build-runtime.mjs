// Bundles the TypeScript runtime (src/runtime-core) into electron/runtime.cjs for the Electron main process.
import { build } from "esbuild";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
await build({
  entryPoints: [path.join(root, "src/runtime-core/index.ts")],
  outfile: path.join(root, "electron/runtime.cjs"),
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  external: ["electron"],
  logLevel: "warning",
});
console.log("built electron/runtime.cjs");
