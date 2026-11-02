// Next.js integration.
//
//   // next.config.ts
//   import { withNaughtify } from "naughtify/next";
//   export default withNaughtify({ /* your config */ }, { canary: "acme-7f3a" });
//
// Uses Next's build adapter API (`adapterPath`, stable since Next 16.2): after
// `next build` finishes, the adapter rewrites the client JS in `.next/static`.
// Works with Turbopack and webpack, because it runs on the final chunks rather
// than as a loader, so minification can't undo it. Server code is never touched.
//
// If you already use an adapter (your config's `adapterPath`, or a platform's
// NEXT_ADAPTER_PATH), naughtify runs first and then hands off to it.
import { fileURLToPath } from "node:url";
import { INNER_ADAPTER_ENV, OPTIONS_ENV, type NaughtifyNextOptions } from "./next-shared.ts";

export type { NaughtifyNextOptions } from "./next-shared.ts";

// Structural stand-in for next's NextConfig so naughtify doesn't depend on `next`.
type NextConfigObject = { adapterPath?: string };
type NextConfigFn<C> = (phase: string, ctx: { defaultConfig: C }) => C | Promise<C>;

const ADAPTER_PATH = fileURLToPath(new URL("./next-adapter.js", import.meta.url));

export function withNaughtify<C extends NextConfigObject>(config: C, opts?: NaughtifyNextOptions): C;
export function withNaughtify<C extends NextConfigObject>(config: NextConfigFn<C>, opts?: NaughtifyNextOptions): NextConfigFn<C>;
export function withNaughtify<C extends NextConfigObject>(
  config: C | NextConfigFn<C>,
  opts: NaughtifyNextOptions = {},
): C | NextConfigFn<C> {
  if (typeof config === "function") {
    return async (phase, ctx) => apply(await config(phase, ctx), opts);
  }
  return apply(config, opts);
}

function apply<C extends NextConfigObject>(config: C, opts: NaughtifyNextOptions): C {
  if (opts.enabled === false) return config;

  const inner = config.adapterPath ?? process.env.NEXT_ADAPTER_PATH;
  if (inner && inner !== ADAPTER_PATH) process.env[INNER_ADAPTER_ENV] = inner;
  process.env[OPTIONS_ENV] = JSON.stringify(opts);

  return { ...config, adapterPath: ADAPTER_PATH };
}
