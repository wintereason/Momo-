/**
 * Last line of defence for text read from other programs (screens, windows, tabs): obvious secrets are
 * replaced before the text is shown, spoken or kept in memory. This is a safety net, not a guarantee:
 * it complements (never replaces) skipping password fields and asking before looking at a screen.
 */

function luhn(digits: string): boolean {
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (alt) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
    alt = !alt;
  }
  return sum % 10 === 0;
}

const PATTERNS: [RegExp, string][] = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*/g, "[private key hidden]"],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, "[token hidden]"], // JWT
  [/\b(?:sk-[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{20,}|gho_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,}|xox[baprs]-[A-Za-z0-9-]{10,})/g, "[key hidden]"],
  // "password: hunter2", "api_key=abc..." (only explicit key/value forms, so "Password is required" still reads normally)
  [/\b(password|passwd|pwd|passcode|passphrase|secret|token|api[_ -]?key|bearer)\b\s*[:=]\s*\S+/gi, "$1: [hidden]"],
];

export function redactSecrets(s: string): string {
  let t = s;
  for (const [re, rep] of PATTERNS) t = t.replace(re, rep);
  // payment card numbers: 13-19 digits (spaces or dashes allowed) that pass the Luhn check
  t = t.replace(/\b\d(?:[ -]?\d){12,18}\b/g, (m) => {
    const d = m.replace(/\D/g, "");
    return d.length >= 13 && d.length <= 19 && luhn(d) ? "[card number hidden]" : m;
  });
  return t;
}
