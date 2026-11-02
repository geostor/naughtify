// Shared between `naughtify/next` (loaded by next.config) and the adapter module
// (loaded by Next during the build). Kept dependency-free so next.config stays light.
import type { NaughtifyOptions } from "./core.ts";

/** Env var carrying the JSON-serialized options from withNaughtify() to the adapter. */
export const OPTIONS_ENV = "NAUGHTIFY_NEXT_OPTIONS";
/** Env var carrying a pre-existing adapterPath that the naughtify adapter chains to. */
export const INNER_ADAPTER_ENV = "NAUGHTIFY_NEXT_INNER_ADAPTER";

export interface NaughtifyNextOptions extends Omit<NaughtifyOptions, "filename"> {
  /** Set false to skip the rewrite (e.g. `enabled: process.env.CI === "true"`). Default true. */
  enabled?: boolean;
  /**
   * Seed every build differently. Default true: the seed is derived from Next's
   * buildId, so each deploy differs but rebuilding the same buildId is stable.
   * Ignored when `seed` is set.
   */
  rotate?: boolean;
  /** Log a one-line summary after rewriting. Default true. */
  verbose?: boolean;
}
