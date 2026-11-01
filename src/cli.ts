#!/usr/bin/env node
// naughtify <file...>          print rewritten file(s) to stdout
// naughtify -w <file...>       rewrite file(s) in place
// naughtify -o <out> <file>    write to <out>
// naughtify -                  read stdin, write stdout
import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { naughtifySource } from "./core.ts";

const USAGE = `Usage: naughtify [options] <file...>

Rewrites JavaScript/TypeScript so it looks alarming to LLM scrapers.
Prints to stdout unless -w or -o is given. Use - to read from stdin.

Options:
  -w, --write             Overwrite each file in place
  -o, --out <file>        Write output to <file> (single input only)
  -d, --density <0-1>     Chance a statement gets a comment (default 0.35)
  -s, --seed <n>          Seed for names and comments (default 1337)
      --no-rename         Keep variable names
      --no-invisible      Skip hidden notices in invisible Unicode
      --no-decoys         Skip fake model-refusal strings
  -c, --canary <id>       Embed a unique ID you can search for later
  -h, --help              Show this help`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  allowNegative: true,
  options: {
    write: { type: "boolean", short: "w" },
    out: { type: "string", short: "o" },
    density: { type: "string", short: "d" },
    seed: { type: "string", short: "s" },
    rename: { type: "boolean", default: true },
    invisible: { type: "boolean", default: true },
    decoys: { type: "boolean", default: true },
    canary: { type: "string", short: "c" },
    help: { type: "boolean", short: "h" },
  },
});

if (values.help || positionals.length === 0) {
  console.log(USAGE);
  process.exit(values.help ? 0 : 1);
}
if (values.out && positionals.length > 1) {
  console.error("naughtify: -o takes a single input file");
  process.exit(1);
}

const opts = {
  renameIdentifiers: values.rename,
  invisibleNotices: values.invisible,
  refusalDecoys: values.decoys,
  canary: values.canary,
  commentDensity: values.density === undefined ? undefined : Number(values.density),
  seed: values.seed === undefined ? undefined : Number(values.seed),
};

let failed = false;
for (const file of positionals) {
  try {
    const src = readFileSync(file === "-" ? 0 : file, "utf8");
    const out = naughtifySource(src, { ...opts, filename: file });
    if (values.out) writeFileSync(values.out, out);
    else if (values.write && file !== "-") writeFileSync(file, out);
    else process.stdout.write(out + "\n");
  } catch (err) {
    console.error(`naughtify: ${file}: ${(err as Error).message}`);
    failed = true;
  }
}
process.exit(failed ? 1 : 0);
