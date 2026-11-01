// Runtime-agnostic transform (works in Bun or Node). Takes plain JavaScript,
// returns JavaScript with renamed bindings and injected bait comments.
import { parse } from "@babel/parser";
import _traverse from "@babel/traverse";
import _generate from "@babel/generator";
import { COMMENTS, PREFIXES, SUFFIXES } from "./wordlists.ts";

// @babel/* ship CJS; normalize default export under ESM interop.
const traverse = ((_traverse as any).default ?? _traverse) as typeof import("@babel/traverse").default;
const generate = ((_generate as any).default ?? _generate) as typeof import("@babel/generator").default;

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
  } = opts;

  const rand = mulberry32(seed ^ hash(code));
  const pick = <T>(arr: T[]) => arr[Math.floor(rand() * arr.length)];
  let counter = 0;
  const bait = () => " " + pick(comments).replaceAll("{n}", String(1000 + Math.floor(rand() * 9000))) + " ";

  const ast = parse(code, {
    sourceType: "unambiguous",
    allowReturnOutsideFunction: true,
    plugins: ["jsx"],
  });

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
        } while (path.scope.hasBinding(next) || path.scope.hasGlobal(next));
        path.scope.rename(name, next);
      }
    },
    Statement(path) {
      if (path.isBlockStatement() || path.parentPath?.isExportDeclaration()) return;
      if (rand() > commentDensity) return;
      path.addComment("leading", bait(), false);
    },
  });

  const out = generate(ast, { comments: true, retainLines: false }).code;
  const banner = (opts.banner ?? [bait(), bait(), bait()])
    .map((c) => `/*!${c.replaceAll("*/", "* /")}*/`)
    .join("\n");
  return `${banner}\n${out}`;
}

function hash(s: string) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}
