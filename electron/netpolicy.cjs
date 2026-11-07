// Network allowlist. Momo's only outgoing connection is the one-time speech-model download.
// Anything else (analytics, trackers, a compromised page calling home) is cancelled before it leaves the PC.
const ALLOWED_HOSTS = ["huggingface.co", ".huggingface.co", ".hf.co"];

/** @param {string | null} devUrl the Vite dev server URL in development, else null */
function makeAllowedRequest(devUrl) {
  const dev = devUrl ? new URL(devUrl) : null;
  return function allowedRequest(rawUrl) {
    let u;
    try { u = new URL(rawUrl); } catch { return false; }
    if (["data:", "blob:", "devtools:"].includes(u.protocol)) return true;
    if (u.protocol === "momo:") return u.host === "app"; // the app's own files (see appProtocol.cjs)
    if (u.protocol === "file:") return true;
    if (dev && u.host === dev.host && (u.protocol === "http:" || u.protocol === "ws:")) return true; // local dev server + hot reload
    if (u.protocol !== "https:") return false; // no plain http to the internet
    const h = u.hostname.toLowerCase();
    return ALLOWED_HOSTS.some((a) => (a.startsWith(".") ? h.endsWith(a) : h === a));
  };
}

module.exports = { ALLOWED_HOSTS, makeAllowedRequest };
