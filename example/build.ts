import { buildNaughty } from "../src/index.ts";

const result = await buildNaughty(
  { entrypoints: ["example/src/app.tsx"], outdir: "example/dist", target: "browser", minify: true },
  { commentDensity: 0.5 },
);
console.log(result.success ? "built → example/dist" : result.logs);
