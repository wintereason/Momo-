// Copies the ONNX Runtime WASM files next to the app so speech recognition never loads code from a CDN.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const from = path.join(root, "node_modules/onnxruntime-web/dist");
const to = path.join(root, "public/ort");
fs.mkdirSync(to, { recursive: true });
// transformers.js asks for the "jsep" build; the plain build is kept as a fallback
for (const f of ["ort-wasm-simd-threaded.jsep.wasm", "ort-wasm-simd-threaded.jsep.mjs", "ort-wasm-simd-threaded.wasm", "ort-wasm-simd-threaded.mjs"]) {
  const src = path.join(from, f), dst = path.join(to, f);
  if (!fs.existsSync(dst) || fs.statSync(dst).size !== fs.statSync(src).size) fs.copyFileSync(src, dst);
}
