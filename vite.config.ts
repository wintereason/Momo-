import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// Production pages get a strict Content-Security-Policy (dev needs inline scripts for hot reload).
const csp = {
  name: "momo-csp",
  apply: "build" as const,
  transformIndexHtml: (html: string) =>
    html.replace(
      "<head>",
      `<head>
    <meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self' blob:; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; media-src 'self' blob:; connect-src 'self' https://huggingface.co https://*.huggingface.co https://*.hf.co" />`,
    ),
};

export default defineConfig({
  base: "./",
  envPrefix: "VITE_", // only VITE_* variables can ever reach the web page; no secret in .env uses this prefix
  build: { chunkSizeWarningLimit: 900 }, // the 3D engine and the speech worker are separate, lazily loaded chunks
  plugins: [react(), csp],
    server: { port: 5173, strictPort: true },
  test: { environment: "node", include: ["src/**/*.test.ts", "electron/**/*.test.mjs"] },
});
