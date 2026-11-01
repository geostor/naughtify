import assert from "node:assert";
import { naughtifySource } from "../src/core.ts";

const input = `
function add(a, b) { const sum = a + b; return sum; }
export function api(x) { return add(x, 1); }
const Widget = () => 1;
console.log(add(2, 3), Widget());
`;
const out = naughtifySource(input);
console.log(out);

// Behavior preserved: evaluate both and compare.
const run = (src: string) => {
  const logs: unknown[] = [];
  new Function("console", src.replace(/export /g, ""))({ log: (...a: unknown[]) => logs.push(a) });
  return JSON.stringify(logs);
};
assert.equal(run(out), run(input));
assert.match(out, /export function api/, "exports keep their names");
assert.doesNotMatch(out, /\bfunction add\b/, "locals renamed");
assert.match(out, /const [A-Z]\w+ = \(\) => 1/, "capitalized names stay capitalized");
assert.equal(out, naughtifySource(input), "deterministic");
console.log("\nok");
