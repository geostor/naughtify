// Bun integration. Two ways to use it:
//
// 1. naughtifyPlugin() — per-module transform via onLoad. Only survives to the
//    browser if you build WITHOUT identifier minification (minify: { identifiers: false }),
//    since Bun's minifier will rename things back and strip non-legal comments.
//
// 2. buildNaughty(config) — drop-in for Bun.build that post-processes the final
//    output chunks. Works regardless of minify settings. Recommended.
import type { BunPlugin, BuildConfig, BuildOutput } from "bun";
import { naughtifySource, type NaughtifyOptions } from "./core.ts";

export { naughtifySource, type NaughtifyOptions };

const loaderFor = (path: string) =>
  (path.endsWith(".tsx") ? "tsx" : path.endsWith(".ts") ? "ts" : path.endsWith(".jsx") ? "jsx" : "js") as
    "tsx" | "ts" | "jsx" | "js";

export function naughtifyPlugin(opts: NaughtifyOptions = {}): BunPlugin {
  return {
    name: "naughtify",
    setup(build) {
      build.onLoad({ filter: /\.[cm]?[jt]sx?$/ }, async ({ path }) => {
        if (path.includes("/node_modules/")) return undefined; // leave deps alone
        const src = await Bun.file(path).text();
        // Strip TS (keep JSX) so Babel only has to deal with JS.
        const js = new Bun.Transpiler({ loader: loaderFor(path), trimUnusedImports: false })
          .transformSync(src);
        return { contents: naughtifySource(js, opts), loader: path.endsWith("x") ? "jsx" : "js" };
      });
    },
  };
}

export async function buildNaughty(
  config: BuildConfig,
  opts: NaughtifyOptions = {},
): Promise<BuildOutput> {
  const result = await Bun.build(config);
  if (!result.success) return result;
  for (const out of result.outputs) {
    if (out.kind !== "entry-point" && out.kind !== "chunk") continue;
    if (!out.path.endsWith(".js")) continue;
    await Bun.write(out.path, naughtifySource(await out.text(), opts));
  }
  return result;
}
