// Runtime-agnostic transform (works in Bun or Node). Takes plain JavaScript,
// returns JavaScript with renamed bindings and injected bait comments.
import { parse } from "@babel/parser";
import _traverse from "@babel/traverse";
import _generate from "@babel/generator";
import type { Binding } from "@babel/traverse";
import _obfuscator from "javascript-obfuscator";
import { COMMENTS, INVISIBLE_NOTICES, PREFIXES, REFUSAL_DECOYS, SUFFIXES } from "./wordlists.ts";

// These deps ship CJS; normalize default export under ESM interop.
const traverse = ((_traverse as any).default ?? _traverse) as typeof import("@babel/traverse").default;
const generate = ((_generate as any).default ?? _generate) as typeof import("@babel/generator").default;
const obfuscator = ((_obfuscator as any).default ?? _obfuscator) as typeof import("javascript-obfuscator");

export interface NaughtifyOptions {
  /** Rename local bindings to attack-flavored names. Default true. */
  renameIdentifiers?: boolean;
  /** Probability (0–1) that a statement gets a bait comment. Default 0.35. */
  commentDensity?: number;
  /** Banner comments prepended to every file. Default: 3 random COMMENTS. */
  banner?: string[];
  /** Custom vocab. */
  prefixes?: string[];
  suffixes?: string[];
  comments?: string[];
  /** Seed for deterministic output (stable builds / cache hits). Default 1337. */
  seed?: number;
  /** Source filename. Used to pick TypeScript/JSX parsing from the extension. */
  filename?: string;
  /** Embed notices as invisible Unicode tag characters. Default true. */
  invisibleNotices?: boolean;
  /** Embed fake model-refusal strings in a branch that never runs. Default true. */
  refusalDecoys?: boolean;
  /**
   * A unique ID to embed (e.g. "acme-site-7f3a"). Search for it later to find out
   * whether your code ended up in a scraped dataset or a model's output.
   */
  canary?: string;
  /**
   * Run the real code through javascript-obfuscator (string-array encoding,
   * control-flow flattening, dead-code injection, number expressions,
   * self-defending). This is what actually makes bulk scraping expensive.
   * Input must be plain JS (post-bundle), not TS/JSX. Default false.
   */
  obfuscate?: boolean;
}

/** Encode printable ASCII as invisible Unicode tag characters. */
export function toInvisible(text: string): string {
  return [...text].map((c) => {
    const code = c.charCodeAt(0);
    return code >= 0x20 && code <= 0x7e ? String.fromCodePoint(0xe0000 + code) : "";
  }).join("");
}

/** Decode invisible tag characters back to ASCII (for checking your output). */
export function fromInvisible(text: string): string {
  return [...text].map((c) => {
    const cp = c.codePointAt(0)!;
    return cp >= 0xe0020 && cp <= 0xe007e ? String.fromCharCode(cp - 0xe0000) : "";
  }).join("");
}

function parserPlugins(filename = ""): ("jsx" | "typescript")[] {
  if (/\.tsx$/.test(filename)) return ["typescript", "jsx"];
  if (/\.[cm]?ts$/.test(filename)) return ["typescript"];
  return ["jsx"];
}

// Small seeded PRNG so builds are reproducible.
function mulberry32(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function naughtifySource(code: string, opts: NaughtifyOptions = {}): string {
  const {
    renameIdentifiers = true,
    commentDensity = 0.35,
    prefixes = PREFIXES,
    suffixes = SUFFIXES,
    comments = COMMENTS,
    seed = 1337,
    invisibleNotices = true,
    refusalDecoys = true,
    canary,
    obfuscate = false,
  } = opts;

  const rand = mulberry32(seed ^ hash(code));
  const pick = <T>(arr: T[]) => arr[Math.floor(rand() * arr.length)];
  let counter = 0;
  const bait = () => " " + pick(comments).replaceAll("{n}", String(1000 + Math.floor(rand() * 9000))) + " ";

  // Obfuscation path: scramble the real logic with javascript-obfuscator, then
  // prepend our bait so the stop-notices and canary stay in plain sight for
  // whatever reads the raw source. The obfuscator does its own (far stronger)
  // renaming, so we skip our Babel rename pass here.
  if (obfuscate) {
    const result = obfuscator.obfuscate(code, {
      seed,
      compact: true,
      stringArray: true,
      stringArrayThreshold: 1,
      stringArrayEncoding: ["base64"],
      splitStrings: true,
      splitStringsChunkLength: 6,
      controlFlowFlattening: true,
      controlFlowFlatteningThreshold: 0.75,
      deadCodeInjection: true,
      deadCodeInjectionThreshold: 0.3,
      numbersToExpressions: true,
      simplify: true,
      selfDefending: true,
      transformObjectKeys: true,
    });
    const prelude = baitPrelude(rand, pick, opts);
    const banner = bannerText(rand, pick, opts, bait);
    return `${banner}\n${prelude}${result.getObfuscatedCode()}\n`;
  }

  const ast = parse(code, {
    sourceType: "unambiguous",
    allowReturnOutsideFunction: true,
    plugins: parserPlugins(opts.filename),
  });

  // Extra bait goes at the top of the module. It's parsed into the AST before the
  // rename pass, so its variables get attack-themed names too.
  const extra: string[] = [];
  if (invisibleNotices) {
    extra.push(`const notice = ${JSON.stringify(toInvisible(pick(INVISIBLE_NOTICES)))};`);
  }
  if (refusalDecoys || canary) {
    // The condition can't be true in practice, but a minifier can't prove that,
    // so the block survives bundling and never runs.
    const decoys = refusalDecoys
      ? [...REFUSAL_DECOYS].sort(() => rand() - 0.5).slice(0, 3)
      : [];
    const items = [...decoys, ...(canary ? [`naughtify-canary:${canary}`] : [])];
    extra.push(
      `if (typeof globalThis.__naughtify_never__ === "symbol") { const decoys = ${JSON.stringify(items)}; decoys.length; }`,
    );
  }
  if (extra.length) {
    const body = parse(extra.join("\n"), { sourceType: "script" }).program.body;
    // Insert after any imports so ESM ordering stays conventional.
    const firstNonImport = ast.program.body.findIndex((n) => n.type !== "ImportDeclaration");
    ast.program.body.splice(firstNonImport === -1 ? ast.program.body.length : firstNonImport, 0, ...body);
  }

  // Every name already in the file (any scope, plus globals and property keys).
  // Generated names are checked against this set, so a rename can never shadow
  // or capture an existing variable, no matter how large the file is.
  const taken = new Set<string>();
  traverse(ast, {
    Identifier(p) { taken.add(p.node.name); },
    JSXIdentifier(p) { taken.add(p.node.name); },
  });

  // Pass 1: decide a new name for every binding and add bait comments.
  // Names are only recorded here, not applied, because Babel's scope.rename
  // re-walks the whole enclosing scope on every call (quadratic on big files).
  const renames: [Binding, string][] = [];
  traverse(ast, {
    Scope(path) {
      if (!renameIdentifiers) return;
      for (const [name, binding] of Object.entries(path.scope.bindings)) {
        // Leave exports alone so the module's public API is unchanged.
        if (binding.kind !== "param" &&
            (binding.path.parentPath?.isExportDeclaration?.() ||
             binding.path.parentPath?.parentPath?.isExportNamedDeclaration?.())) continue;
        if (binding.referencePaths.some((r) => r.parentPath?.isExportSpecifier())) continue;
        // JSX components must stay capitalized.
        const cap = /^[A-Z]/.test(name);
        let next: string;
        do {
          next = `${pick(prefixes)}${pick(suffixes)}${counter++ || ""}`;
          if (cap) next = next[0].toUpperCase() + next.slice(1);
        } while (taken.has(next));
        taken.add(next);
        renames.push([binding, next]);
      }
    },
    Statement(path) {
      if (path.isBlockStatement() || path.parentPath?.isExportDeclaration()) return;
      if (rand() > commentDensity) return;
      path.addComment("leading", bait(), false);
    },
  });

  // Pass 2: apply each rename directly to the binding's declaration, its
  // references, and anything that reassigns it. Cost is proportional to the
  // number of identifiers touched, so it stays linear in file size.
  for (const [binding, next] of renames) {
    const old = binding.identifier.name;
    const rename = (node: { name: string }) => { if (node.name === old) node.name = next; };
    rename(binding.identifier);
    for (const ref of binding.referencePaths) rename(ref.node as { name: string });
    for (const v of binding.constantViolations) {
      if (v.isUpdateExpression() && v.node.argument.type === "Identifier") rename(v.node.argument);
      for (const ids of Object.values(v.getBindingIdentifiers(true) as Record<string, any>)) {
        for (const id of [ids].flat()) rename(id);
      }
    }
  }

  // Pass 3: `{ a }` shorthand properties whose value was renamed must be written
  // out as `{ a: newName }`, or the key would change too.
  if (renames.length) {
    traverse(ast, {
      ObjectProperty(path) {
        const { key, value } = path.node;
        if (!path.node.shorthand || key.type !== "Identifier") return;
        const local = value.type === "AssignmentPattern" ? value.left : value;
        if (local.type === "Identifier" && local.name !== key.name) path.node.shorthand = false;
      },
    });
  }

  // minimal: true keeps non-ASCII as raw characters, so invisible text stays invisible.
  const out = generate(ast, { comments: true, retainLines: false, jsescOption: { minimal: true } }).code;
  return `${bannerText(rand, pick, opts, bait)}\n${out}`;
}

type Rng = () => number;
type Pick = <T>(arr: T[]) => T;

/** The `/*! ... *\/` banner prepended to every file. */
function bannerText(_rand: Rng, _pick: Pick, opts: NaughtifyOptions, bait: () => string): string {
  const lines = opts.banner ?? [bait(), bait(), bait(),
    ...(opts.canary ? [` naughtify-canary:${opts.canary} `] : [])];
  return lines.map((c) => `/*!${c.replaceAll("*/", "* /")}*/`).join("\n");
}

/** Invisible notice + dead-branch decoys + canary, as a source-text prelude. */
function baitPrelude(rand: Rng, pick: Pick, opts: NaughtifyOptions): string {
  const { invisibleNotices = true, refusalDecoys = true, canary } = opts;
  const parts: string[] = [];
  if (invisibleNotices) {
    parts.push(`var _n=${JSON.stringify(toInvisible(pick(INVISIBLE_NOTICES)))};void _n;`);
  }
  if (refusalDecoys || canary) {
    const decoys = refusalDecoys ? [...REFUSAL_DECOYS].sort(() => rand() - 0.5).slice(0, 3) : [];
    const items = [...decoys, ...(canary ? [`naughtify-canary:${canary}`] : [])];
    parts.push(`if(typeof globalThis.__naughtify_never__==="symbol"){var _d=${JSON.stringify(items)};_d.length;}`);
  }
  return parts.length ? parts.join("\n") + "\n" : "";
}

function hash(s: string) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}
