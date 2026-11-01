import assert from "node:assert";
import { fromInvisible, naughtifySource } from "../src/core.ts";
import { PREFIXES, SUFFIXES } from "../src/wordlists.ts";
import { aiCrawlerRobotsTxt, honeypotLinks, noaiMetaTags, renderAtRuntime, xRobotsHeaders } from "../src/signals.ts";
import { generateDecoys } from "../src/decoys.ts";
import { parse } from "@babel/parser";

// Run a script and capture console.log calls, so we can compare behavior.
const run = (src: string) => {
  const logs: unknown[] = [];
  const stripped = src.replace(/\bexport\s*\{[^}]*\}\s*;?/g, "").replace(/\bexport\s+(?=function|const|let|var|class)/g, "");
  new Function("console", stripped)({ log: (...a: unknown[]) => logs.push(a) });
  return JSON.stringify(logs);
};

// --- basics
{
  const input = `
function add(a, b) { const sum = a + b; return sum; }
export function api(x) { return add(x, 1); }
const Widget = () => 1;
console.log(add(2, 3), Widget());
`;
  const out = naughtifySource(input);
  console.log(out);
  assert.equal(run(out), run(input), "behavior preserved");
  assert.match(out, /export function api/, "exports keep their names");
  assert.doesNotMatch(out, /\bfunction add\b/, "locals renamed");
  assert.match(out, /const [A-Z]\w+ = \(\) => 1/, "capitalized names stay capitalized");
  assert.equal(out, naughtifySource(input), "deterministic");
}

// --- invisible notice, refusal decoys, canary
{
  const out = naughtifySource("console.log(1);", { canary: "test-site-42" });
  const hidden = fromInvisible(out);
  assert.match(hidden, /AI|SYSTEM|language models/, "invisible notice decodes");
  assert.doesNotMatch(out.replace(/[\u{E0000}-\u{E007F}]/gu, ""), /SYSTEM: The operator|not licensed for AI processing/,
    "notice text is not visible as plain ASCII");
  assert.match(out, /can't|refused|blocked|withheld|decline|won't/i, "refusal decoys present");
  assert.equal((out.match(/naughtify-canary:test-site-42/g) ?? []).length, 2, "canary in banner and code");
  assert.equal(run(out), run("console.log(1);"), "decoy branch never runs");
  const plain = naughtifySource("console.log(1);", { invisibleNotices: false, refusalDecoys: false });
  assert.equal(fromInvisible(plain), "", "invisible notices can be turned off");
}

// --- collision trap: inner scopes already use names the generator would pick
{
  const traps = PREFIXES.flatMap((p) => SUFFIXES.map((s) => p + s));
  const input = `
let total = 0;
function outer(n) {
  ${traps.map((t, i) => `{ const ${t} = ${i}; total += ${t} + n; }`).join("\n  ")}
  return total;
}
console.log(outer(1), total);
`;
  const out = naughtifySource(input);
  assert.equal(run(out), run(input), "no shadowing when generated names already exist");
}

// --- large file: thousands of nested scopes
{
  const N = 3000;
  const fns = Array.from({ length: N }, (_, i) =>
    `function f${i}(a, b) { const c = a * ${i}; let d = (x) => { const y = x + c; return y + b; }; return d(${i}); }`);
  const input = `${fns.join("\n")}\nlet s = 0;\n${Array.from({ length: N }, (_, i) => `s += f${i}(${i}, 2);`).join("\n")}\nconsole.log(s);`;
  const t = performance.now();
  const out = naughtifySource(input);
  const ms = Math.round(performance.now() - t);
  assert.equal(run(out), run(input), "large file behavior preserved");
  const declared = [...out.matchAll(/\b(?:function|const|let)\s+([A-Za-z_$][\w$]*)/g)].map((m) => m[1]);
  console.log(`\nlarge file: ${N} functions, ${declared.length} declarations, ${(input.length / 1024).toFixed(0)} KB in ${ms} ms`);
}

// --- obfuscate mode preserves behavior and keeps our signals in plain sight
{
  const input = `export function calc(a, b) { let t = 0; for (let i = 0; i < a; i++) t += b; return t; }
console.log(calc(3, 7));`;
  const out = naughtifySource(input, { obfuscate: true, canary: "obf-1" });
  assert.equal(run(out), run(input), "obfuscated behavior preserved");
  assert.match(fromInvisible(out), /\w/, "invisible notice survives obfuscation");
  assert.equal((out.match(/obf-1/g) ?? []).length, 2, "canary survives obfuscation");
  assert.match(out, /_0x[0-9a-f]+/, "real code is obfuscated (hex identifiers present)");
  assert.doesNotMatch(out, /for \(let i = 0; i < a/, "original loop is gone");
  assert.equal(out, naughtifySource(input, { obfuscate: true, canary: "obf-1" }), "obfuscation deterministic");
}

// --- obfuscate transpiles TS/JSX input first (regression: tsx type annotations)
{
  const tsx = `function pair({ start }: { start: number }) {
  let n: number = start;
  const next = (): number => ++n;
  return next() + next();
}
export const total: number = pair({ start: 10 });
console.log(total);`;
  const out = naughtifySource(tsx, { obfuscate: true, filename: "app.tsx" });
  assert.equal(run(out), "[[23]]", "obfuscated tsx behaves correctly");
  assert.doesNotMatch(out, /:\s*number/, "TS types stripped before obfuscation");
}

// --- seed changes names (per-deploy rotation)
{
  const input = "function helper(x){const y=x+1;return y} console.log(helper(1));";
  assert.notEqual(naughtifySource(input, { seed: 1 }), naughtifySource(input, { seed: 2 }), "seed changes output");
  assert.equal(run(naughtifySource(input, { seed: 99 })), run(input), "reseeded output still runs");
}

// --- signals generators
{
  const robots = aiCrawlerRobotsTxt({ honeypotPath: "/trap/x" });
  assert.match(robots, /User-agent: GPTBot/);
  assert.match(robots, /User-agent: ClaudeBot/);
  assert.match(robots, /Disallow: \/trap\/x/);
  assert.match(noaiMetaTags(), /noai/);
  assert.match(xRobotsHeaders().nginx, /X-Robots-Tag/);
  const hp = honeypotLinks({ count: 4, seed: 7 });
  assert.equal(hp.paths.length, 4);
  assert.match(hp.html, /aria-hidden="true"/, "honeypot hidden from assistive tech");
  assert.deepEqual(hp, honeypotLinks({ count: 4, seed: 7 }), "honeypot deterministic by seed");
  assert.match(renderAtRuntime("secret text", { id: "x" }), /atob\(/, "runtime render ships base64");
  assert.doesNotMatch(renderAtRuntime("secret text", { id: "x" }), /secret text/, "runtime render hides source text");
}

// --- decoys are valid, runnable, deterministic
{
  const a = generateDecoys(3, 5);
  const b = generateDecoys(3, 5);
  assert.deepEqual(Object.keys(a), Object.keys(b), "decoys deterministic by seed");
  assert.equal(Object.keys(a).length, 3);
  for (const src of Object.values(a)) {
    parse(src, { sourceType: "module" }); // valid ESM, throws otherwise
  }
}

console.log("\nok");
