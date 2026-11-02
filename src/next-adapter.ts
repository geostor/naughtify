// Next.js build adapter. Not imported directly: withNaughtify() (naughtify/next)
// points next.config's `adapterPath` here and passes options through the env.
import { readdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { naughtifySource } from "./core.ts";
import { INNER_ADAPTER_ENV, OPTIONS_ENV, type NaughtifyNextOptions } from "./next-shared.ts";

// Minimal structural slice of next's NextAdapter types, so we don't depend on `next`.
type StaticFile = { filePath: string; pathname: string };
type BuildCompleteCtx = {
  outputs: { staticFiles: StaticFile[] };
  projectDir: string;
  distDir: string;
  buildId: string;
  config: { experimental?: { sri?: unknown } };
  [key: string]: unknown;
};
type Adapter = {
  name: string;
  modifyConfig?: (config: any, ctx: { phase: string; projectDir: string; [k: string]: unknown }) => unknown;
  onBuildComplete?: (ctx: BuildCompleteCtx) => unknown;
};

const log = (msg: string) => console.log(` \x1b[35m▲\x1b[0m naughtify: ${msg}`);

function readOptions(): NaughtifyNextOptions {
  try {
    return JSON.parse(process.env[OPTIONS_ENV] ?? "{}");
  } catch {
    return {};
  }
}

let innerPromise: Promise<Adapter | null> | null = null;
function loadInner(projectDir: string): Promise<Adapter | null> {
  const spec = process.env[INNER_ADAPTER_ENV];
  if (!spec) return Promise.resolve(null);
  innerPromise ??= (async () => {
    const resolved = createRequire(path.join(projectDir, "package.json")).resolve(spec);
    const mod = await import(pathToFileURL(resolved).href);
    return (mod.default ?? mod) as Adapter;
  })();
  return innerPromise;
}

async function walkJs(dir: string, out: Set<string>) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) await walkJs(p, out);
    else if (/\.m?js$/.test(e.name)) out.add(p);
  }
}

function seedFrom(text: string) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return h >>> 0;
}

async function rewriteClientChunks(ctx: BuildCompleteCtx, opts: NaughtifyNextOptions) {
  const { enabled, rotate = true, verbose = true, ...transformOpts } = opts;
  if (enabled === false) return;

  if (ctx.config.experimental?.sri) {
    log("skipped: experimental.sri is on and rewritten chunks would fail their integrity hashes.");
    return;
  }

  // Everything served from /_next/static: the adapter's staticFiles list, plus a
  // walk of <distDir>/static in case a Next version reports fewer files.
  const files = new Set<string>();
  for (const f of ctx.outputs.staticFiles ?? []) {
    if (/\.m?js$/.test(f.filePath) && f.pathname.includes("/_next/static/")) files.add(f.filePath);
  }
  await walkJs(path.join(path.resolve(ctx.projectDir, ctx.distDir), "static"), files);

  const seed = transformOpts.seed ?? (rotate ? seedFrom(ctx.buildId) : undefined);
  const t0 = performance.now();
  let before = 0;
  let after = 0;
  let done = 0;
  const failed: string[] = [];

  for (const file of files) {
    const src = await readFile(file, "utf8");
    try {
      const out = naughtifySource(src, { ...transformOpts, seed, filename: file });
      await writeFile(file, out);
      before += src.length;
      after += out.length;
      done++;
    } catch (err) {
      failed.push(`${path.relative(ctx.projectDir, file)}: ${err instanceof Error ? err.message : err}`);
    }
  }

  if (verbose) {
    const kb = (n: number) => `${Math.round(n / 1024)} KB`;
    log(
      `rewrote ${done} client chunk(s) in ${((performance.now() - t0) / 1000).toFixed(1)}s ` +
        `(${kb(before)} -> ${kb(after)}${transformOpts.obfuscate ? ", obfuscated" : ""}` +
        `${transformOpts.canary ? `, canary "${transformOpts.canary}"` : ""})`,
    );
  }
  if (failed.length) log(`left ${failed.length} chunk(s) untouched:\n   ${failed.join("\n   ")}`);
}

const adapter: Adapter = {
  name: "naughtify",

  async modifyConfig(config, ctx) {
    const inner = await loadInner(ctx.projectDir);
    return inner?.modifyConfig ? inner.modifyConfig(config, ctx) : config;
  },

  async onBuildComplete(ctx) {
    // Rewrite first so a chained deployment adapter ships the rewritten files.
    await rewriteClientChunks(ctx, readOptions());
    const inner = await loadInner(ctx.projectDir);
    await inner?.onBuildComplete?.(ctx);
  },
};

export default adapter;
