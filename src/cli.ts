#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { naughtifySource } from "./core.ts";
import { generateDecoys } from "./decoys.ts";
import { aiCrawlerRobotsTxt, canaryBeacon, honeypotLinks, noaiMetaTags, xRobotsHeaders } from "./signals.ts";

const USAGE = `naughtify — make shipped JavaScript hostile to LLM scrapers

Usage:
  naughtify [options] <file...>     Rewrite files (default command)
  naughtify signals [dir]           Write opt-out signals (robots.txt, meta, headers)
  naughtify decoys <n> [dir]        Write n decoy JS modules

Rewrite options:
  -w, --write             Overwrite each file in place
  -o, --out <file>        Write output to <file> (single input only)
  -O, --obfuscate         Scramble the real code (string arrays, control flow,
                          dead code). Input must be plain JS, not TS/JSX.
  -r, --rotate            Seed from the current time, so every build differs
  -d, --density <0-1>     Chance a statement gets a comment (default 0.35)
  -s, --seed <n>          Seed for names and comments (default 1337)
  -c, --canary <id>       Embed a unique ID you can search for later
      --no-rename         Keep variable names
      --no-invisible      Skip hidden notices in invisible Unicode
      --no-refusals       Skip fake model-refusal strings
  -h, --help              Show this help

signals options:
      --honeypot <path>   Also emit hidden honeypot links (default /trap)
      --beacon <url>      Also emit a canary beacon snippet (needs --canary)

Read from stdin with - as the file. Use with the usual tools too: robots.txt
rules, rate limiting, and bot protection like Cloudflare or Anubis.`;

const argv = process.argv.slice(2);
const sub = argv[0];

if (sub === "signals") cmdSignals(argv.slice(1));
else if (sub === "decoys") cmdDecoys(argv.slice(1));
else cmdRewrite(argv);

function die(msg: string): never {
  console.error(`naughtify: ${msg}`);
  process.exit(1);
}

function cmdRewrite(args: string[]) {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    allowNegative: true,
    options: {
      write: { type: "boolean", short: "w" },
      out: { type: "string", short: "o" },
      obfuscate: { type: "boolean", short: "O" },
      rotate: { type: "boolean", short: "r" },
      density: { type: "string", short: "d" },
      seed: { type: "string", short: "s" },
      canary: { type: "string", short: "c" },
      rename: { type: "boolean", default: true },
      invisible: { type: "boolean", default: true },
      refusals: { type: "boolean", default: true },
      help: { type: "boolean", short: "h" },
    },
  });

  if (values.help || positionals.length === 0) {
    console.log(USAGE);
    process.exit(values.help ? 0 : 1);
  }
  if (values.out && positionals.length > 1) die("-o takes a single input file");

  const seed = values.rotate ? Date.now() >>> 0
    : values.seed === undefined ? undefined : Number(values.seed);
  const opts = {
    renameIdentifiers: values.rename,
    invisibleNotices: values.invisible,
    refusalDecoys: values.refusals,
    obfuscate: values.obfuscate,
    canary: values.canary,
    commentDensity: values.density === undefined ? undefined : Number(values.density),
    seed,
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
}

function cmdSignals(args: string[]) {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      honeypot: { type: "string" },
      beacon: { type: "string" },
      canary: { type: "string", short: "c" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) { console.log(USAGE); process.exit(0); }

  const dir = positionals[0] ?? ".";
  const written: string[] = [];
  const put = (name: string, content: string) => {
    const p = join(dir, name);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, content);
    written.push(p);
  };

  const hp = values.honeypot !== undefined
    ? honeypotLinks({ basePath: values.honeypot || "/trap" })
    : undefined;
  put("robots.txt", aiCrawlerRobotsTxt({ honeypotPath: hp?.paths[0] }));
  put("naughtify-meta.html", noaiMetaTags() + "\n");
  const h = xRobotsHeaders();
  put("naughtify-headers.nginx.conf", h.nginx + "\n");
  put("naughtify-cloudflare-worker.js", h.cloudflareWorker + "\n");
  if (hp) put("naughtify-honeypot.html", hp.html + "\n");
  if (values.beacon) {
    if (!values.canary) die("--beacon needs --canary <id>");
    put("naughtify-beacon.html", canaryBeacon(values.canary, values.beacon) + "\n");
  }

  console.error(`Wrote ${written.length} file(s):`);
  for (const p of written) console.error(`  ${p}`);
  if (hp) {
    console.error(`\nHoneypot paths (log hits, then block the source):`);
    for (const p of hp.paths) console.error(`  ${p}`);
  }
  console.error(`\nNext: paste naughtify-meta.html into your <head>, serve robots.txt`);
  console.error(`at your site root, and apply the header snippet in your server config.`);
}

function cmdDecoys(args: string[]) {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      seed: { type: "string", short: "s" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) { console.log(USAGE); process.exit(0); }

  const count = Number(positionals[0]);
  if (!Number.isInteger(count) || count < 1) die("decoys needs a positive count, e.g. naughtify decoys 5 dist");
  const dir = positionals[1] ?? ".";
  const seed = values.seed === undefined ? (Date.now() >>> 0) : Number(values.seed);

  const files = generateDecoys(count, seed);
  mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
  console.error(`Wrote ${Object.keys(files).length} decoy module(s) to ${dir}:`);
  for (const name of Object.keys(files)) console.error(`  ${join(dir, name)}`);
}
