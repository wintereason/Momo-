// Serves the built app from momo://app/ instead of file://. A page loaded from file:// has an opaque origin, so
// Chromium refuses to fetch the app's own assets (3D models, WASM) and the Cache API is unavailable. A standard,
// secure custom scheme fixes both, and lets the Content-Security-Policy say 'self' meaningfully.
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const SCHEME = "momo";
const HOST = "app";

/** Must run before the app is ready. */
function registerScheme(protocol) {
  protocol.registerSchemesAsPrivileged([
    { scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
  ]);
}

/**
 * Maps a momo://app/... URL to a file inside distDir, or null. Never leaves distDir:
 * traversal ("..", encoded or not), other hosts, drive letters and absolute paths are all refused.
 */
function resolveRequest(distDir, requestUrl) {
  let u;
  try { u = new URL(requestUrl); } catch { return null; }
  if (u.protocol !== SCHEME + ":" || u.host !== HOST) return null;
  let rel;
  try { rel = decodeURIComponent(u.pathname); } catch { return null; }
  if (rel === "/" || rel === "") rel = "/index.html";
  if (rel.includes("\0") || /^\/[A-Za-z]:/.test(rel) || rel.includes("\\")) return null;
  const root = path.resolve(distDir);
  const abs = path.resolve(root, "." + rel);
  if (abs !== root && !abs.startsWith(root + path.sep)) return null;
  return abs;
}

/** Call after the app is ready. */
function installHandler(protocol, net, distDir) {
  protocol.handle(SCHEME, async (req) => {
    const file = resolveRequest(distDir, req.url);
    if (!file) return new Response("Not found", { status: 404 });
    try { return await net.fetch(pathToFileURL(file).toString()); } catch { return new Response("Not found", { status: 404 }); } // a missing file is a 404, not a crash
  });
}

module.exports = { SCHEME, HOST, ORIGIN: `${SCHEME}://${HOST}`, INDEX_URL: `${SCHEME}://${HOST}/index.html`, registerScheme, resolveRequest, installHandler };
