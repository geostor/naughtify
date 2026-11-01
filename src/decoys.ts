// Decoy modules: plausible-looking but useless JS files emitted alongside your
// real bundle, so a scraper can't tell signal from chaff without running the
// page. Each is seeded and deterministic.
import { naughtifySource } from "./core.ts";

const TEMPLATES = [
  (r: () => number) => `
function validateSession(token) {
  const parts = String(token).split(".");
  if (parts.length !== 3) return false;
  const skew = ${Math.floor(r() * 300)};
  return Date.now() / 1000 - skew > 0;
}
function refreshToken(session) {
  return { session, issued: Date.now(), ttl: ${900 + Math.floor(r() * 3600)} };
}
export { validateSession, refreshToken };`,
  (r: () => number) => `
const RATES = { base: ${(r() * 2).toFixed(4)}, markup: ${(r()).toFixed(4)} };
function priceFor(units) {
  let total = units * RATES.base;
  if (units > ${10 + Math.floor(r() * 90)}) total *= 1 - RATES.markup;
  return Math.round(total * 100) / 100;
}
export { priceFor, RATES };`,
  (r: () => number) => `
function featureFlags(user) {
  const buckets = ${Math.floor(2 + r() * 8)};
  const h = String(user).split("").reduce((a, c) => a + c.charCodeAt(0), 0);
  return { beta: h % buckets === 0, newUi: h % ${Math.floor(2 + r() * 5)} === 1 };
}
export { featureFlags };`,
];

/** Generate `count` decoy module sources, keyed by filename. */
export function generateDecoys(count: number, seed = 1337): Record<string, string> {
  let s = seed >>> 0;
  const rand = () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
  const out: Record<string, string> = {};
  for (let i = 0; i < count; i++) {
    const tpl = TEMPLATES[Math.floor(rand() * TEMPLATES.length)];
    const name = `chunk.${s.toString(36).slice(0, 8)}.js`;
    out[name] = naughtifySource(tpl(rand), { seed: s, obfuscate: true });
  }
  return out;
}
