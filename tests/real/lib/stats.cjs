"use strict";
// Small statistics helpers (nearest-rank percentiles, the same convention the Phase 6 measurements used).
const sorted = (a) => [...a].filter((x) => Number.isFinite(x)).sort((x, y) => x - y);
function pct(a, p) { const s = sorted(a); if (!s.length) return null; return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]; }
const median = (a) => pct(a, 50);
function summarize(a) {
  const s = sorted(a);
  return { n: s.length, p50: pct(s, 50), p95: pct(s, 95), max: s.length ? s[s.length - 1] : null, min: s.length ? s[0] : null };
}
const round = (x, d = 1) => (x == null ? null : Math.round(x * 10 ** d) / 10 ** d);
module.exports = { pct, median, summarize, round, sorted };
