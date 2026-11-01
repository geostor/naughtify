import assert from "node:assert";
import { fromInvisible, naughtifySource } from "../src/core.ts";
import { PREFIXES, SUFFIXES } from "../src/wordlists.ts";

// Run a script and capture console.log calls, so we can compare behavior.
const run = (src: string) => {
  const logs: unknown[] = [];
  new Function("console", src.replace(/^export /gm, ""))({ log: (...a: unknown[]) => logs.push(a) });
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

console.log("\nok");
