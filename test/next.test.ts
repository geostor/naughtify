import assert from "node:assert";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { withNaughtify } from "../src/next.ts";
import { INNER_ADAPTER_ENV, OPTIONS_ENV } from "../src/next-shared.ts";

const chunk = `(function(){ function add(a, b) { const sum = a + b; return sum; } globalThis.out = add(2, 3); })();`;
const serverCode = `function secret(x) { return x * 2; }`;

const dir = await mkdtemp(path.join(tmpdir(), "naughtify-next-"));
try {
  // fake project: a client chunk under .next/static, a server file outside it,
  // and a pre-existing "platform" adapter we expect to be chained.
  await writeFile(path.join(dir, "package.json"), "{}");
  await mkdir(path.join(dir, ".next/static/chunks"), { recursive: true });
  await mkdir(path.join(dir, ".next/server"), { recursive: true });
  const chunkPath = path.join(dir, ".next/static/chunks/main.js");
  const serverPath = path.join(dir, ".next/server/page.js");
  await writeFile(chunkPath, chunk);
  await writeFile(serverPath, serverCode);
  await writeFile(
    path.join(dir, "inner-adapter.mjs"),
    `export default { name: "inner",
       modifyConfig(c) { return { ...c, touchedByInner: true }; },
       async onBuildComplete(ctx) { if (ctx.outputs.staticFiles[0]) globalThis.innerSaw = (await import("node:fs")).readFileSync(ctx.outputs.staticFiles[0].filePath, "utf8"); } };`,
  );

  // --- withNaughtify wires adapterPath and preserves the user's config
  const cfg = withNaughtify({ adapterPath: "./inner-adapter.mjs", reactStrictMode: true } as Record<string, unknown>, {
    canary: "test-canary-42",
    verbose: false,
  }) as { adapterPath: string; reactStrictMode: boolean };
  assert.equal(cfg.reactStrictMode, true, "keeps user config");
  assert.match(cfg.adapterPath, /next-adapter\.(js|ts)$/, "points at naughtify adapter");
  assert.equal(process.env[INNER_ADAPTER_ENV], "./inner-adapter.mjs", "remembers the inner adapter");
  assert.equal(JSON.parse(process.env[OPTIONS_ENV]!).canary, "test-canary-42", "passes options");

  // function-style config
  const fn = withNaughtify(async () => ({ basePath: "/x" }), { verbose: false });
  assert.equal(((await fn("phase-production-build", { defaultConfig: {} })) as { basePath: string }).basePath, "/x");

  // enabled: false is a no-op
  const off = { reactStrictMode: false };
  assert.equal(withNaughtify(off, { enabled: false }), off, "disabled returns config untouched");

  // --- adapter: rewrites client chunks, leaves server code, chains inner adapter
  process.env[OPTIONS_ENV] = JSON.stringify({ canary: "test-canary-42", verbose: false });
  const { default: adapter } = await import("../src/next-adapter.ts");
  const modified = (await adapter.modifyConfig!({ a: 1 }, { phase: "phase-production-build", projectDir: dir })) as Record<string, unknown>;
  assert.equal(modified.touchedByInner, true, "modifyConfig delegates to inner adapter");

  await adapter.onBuildComplete!({
    outputs: { staticFiles: [{ filePath: chunkPath, pathname: "/_next/static/chunks/main.js" }] },
    projectDir: dir,
    distDir: ".next",
    buildId: "build-abc",
    config: {},
  });

  const rewritten = await readFile(chunkPath, "utf8");
  assert.notEqual(rewritten, chunk, "client chunk rewritten");
  assert.match(rewritten, /test-canary-42/, "canary embedded");
  const g = globalThis as { out?: number; innerSaw?: string };
  new Function(rewritten)();
  assert.equal(g.out, 5, "rewritten chunk still runs");
  assert.equal(await readFile(serverPath, "utf8"), serverCode, "server code untouched");
  assert.equal(g.innerSaw, rewritten, "inner adapter ran after the rewrite");

  // SRI on: skip rather than ship chunks that fail integrity checks
  await writeFile(chunkPath, chunk);
  await adapter.onBuildComplete!({
    outputs: { staticFiles: [] },
    projectDir: dir,
    distDir: ".next",
    buildId: "build-abc",
    config: { experimental: { sri: { algorithm: "sha256" } } },
  });
  assert.equal(await readFile(chunkPath, "utf8"), chunk, "SRI builds are left alone");

  console.log("next ok");
} finally {
  await rm(dir, { recursive: true, force: true });
}
