/**
 * Shared primitives for the tool-bench corpus: splits, profiles, the file
 * entry shapes, the seeded sfc32 stream, and the filler text generator. Each
 * tool's scenario table and builder lives in its own corpus-<tool>.ts, and
 * corpus.ts joins them into one table with a tool dimension.
 */
import { createHash } from "node:crypto";

export const CORPUS_SCHEMA = "clio-coder.tool-bench.corpus.v1";
export const SPLITS = ["search", "holdout"] as const;
export type Split = (typeof SPLITS)[number];
export const PROFILES = ["default", "full"] as const;
export type Profile = (typeof PROFILES)[number];
export const DEFAULT_SEED = 1;
export const TOOLS = ["edit", "read", "write", "grep"] as const;
export type BenchTool = (typeof TOOLS)[number];

export type CorpusEntry =
	| { kind: "file"; path: string; bytes: Buffer; mode: number }
	| { kind: "symlink"; path: string; target: string }
	| { kind: "dir"; path: string; mode: number };

export type ExpectedEntry =
	| { kind: "file"; path: string; size: number; sha256: string; mode: number }
	| { kind: "symlink"; path: string; target: string }
	| { kind: "dir"; path: string; mode: number };

export interface ScenarioExpect {
	outcome: "ok" | "error";
	/**
	 * The scratch root after the call. Every file and symlink must match; a
	 * directory is checked only when it is listed.
	 */
	files: ExpectedEntry[];
	/** Substrings the shaped result or error must contain, and must not. */
	output?: { includes: string[]; excludes: string[] };
}

export interface ScenarioBase {
	id: string;
	tool: BenchTool;
	seed: number;
	split: Split;
	template: string;
	profile: Profile;
	files: CorpusEntry[];
	args: object;
	expect: ScenarioExpect;
}

export type TextKind = "ascii" | "multibyte";

export const KB = 1024;
export const MB = 1024 * 1024;

/** sfc32: small, fast, and identical on every JavaScript engine. */
export class Rng {
	private a: number;
	private b: number;
	private c: number;
	private d: number;

	constructor(key: string) {
		const h = createHash("sha256").update(key).digest();
		this.a = h.readUInt32LE(0);
		this.b = h.readUInt32LE(4);
		this.c = h.readUInt32LE(8);
		this.d = h.readUInt32LE(12);
		for (let i = 0; i < 16; i += 1) this.next();
	}

	next(): number {
		const t = (((this.a + this.b) | 0) + this.d) | 0;
		this.d = (this.d + 1) | 0;
		this.a = this.b ^ (this.b >>> 9);
		this.b = (this.c + (this.c << 3)) | 0;
		this.c = (this.c << 21) | (this.c >>> 11);
		this.c = (this.c + t) | 0;
		return t >>> 0;
	}

	/** Uniform integer in [min, max]. */
	int(min: number, max: number): number {
		return min + (this.next() % (max - min + 1));
	}

	hex(chars: number): string {
		let out = "";
		while (out.length < chars) out += this.next().toString(16).padStart(8, "0");
		return out.slice(0, chars);
	}
}

const LETTERS = "abcdefghijklmnopqrstuvwxyz";
// BMP only, so slicing a line by UTF-16 unit never splits a surrogate pair.
const MULTIBYTE = ["é", "ß", "ø", "ж", "λ", "日", "本", "語", "ñ", "€"];

function word(rng: Rng, text: TextKind): string {
	const length = rng.int(2, 9);
	let out = "";
	for (let i = 0; i < length; i += 1) {
		out +=
			text === "multibyte" && rng.int(0, 5) === 0
				? (MULTIBYTE[rng.int(0, MULTIBYTE.length - 1)] ?? "")
				: (LETTERS[rng.int(0, LETTERS.length - 1)] ?? "");
	}
	return out;
}

/**
 * Filler is lowercase letters, spaces, and a few BMP letters only. Anchors
 * carry `<`, `>`, `:`, digits, and uppercase, so filler can never contain an
 * anchor and every anchor is a unique exact match.
 */
export function fillerLine(rng: Rng, length: number, text: TextKind): string {
	let out = "";
	while (out.length < length) out += (out.length === 0 ? "" : " ") + word(rng, text);
	return out.slice(0, length);
}

export function scenarioId(tool: BenchTool, split: Split, key: string): string {
	return `${tool}.${split}.${key}`;
}

export function expectedFile(path: string, bytes: Buffer, mode: number): ExpectedEntry {
	return { kind: "file", path, size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), mode };
}

const POOL_SIZE = 512;

export interface BodySpec {
	/** Target size in bytes; the body ends on the first line that reaches it. */
	bytes: number;
	/** Characters per generated line, inclusive range. */
	line: [number, number];
	text: TextKind;
}

/**
 * Lines sampled from a pool of generated lines until they and their
 * terminators reach spec.bytes. The pool keeps the 100 MB cases fast while
 * every byte still comes from the scenario's stream.
 */
export function poolLines(rng: Rng, spec: BodySpec, eolBytes: number): Buffer[] {
	const pool: Buffer[] = [];
	for (let i = 0; i < POOL_SIZE; i += 1) {
		pool.push(Buffer.from(fillerLine(rng, rng.int(spec.line[0], spec.line[1]), spec.text), "utf8"));
	}
	const lines: Buffer[] = [];
	let total = 0;
	while (total < spec.bytes) {
		const line = pool[rng.int(0, POOL_SIZE - 1)] as Buffer;
		lines.push(line);
		total += line.length + eolBytes;
	}
	return lines;
}

/** Joins lines with eol, adding a final terminator only when asked. */
export function joinLines(lines: readonly Buffer[], eol: string, finalNewline: boolean, prefix?: Buffer): Buffer {
	const terminator = Buffer.from(eol, "utf8");
	const parts: Buffer[] = prefix === undefined ? [] : [prefix];
	for (const [index, line] of lines.entries()) {
		parts.push(line);
		if (finalNewline || index < lines.length - 1) parts.push(terminator);
	}
	return Buffer.concat(parts);
}

/** The scratch root as a non-mutating tool must leave it: every file and symlink as written, sorted by path. */
export function unchangedFiles(files: readonly CorpusEntry[]): ExpectedEntry[] {
	return files
		.filter((entry) => entry.kind !== "dir")
		.map((entry) => (entry.kind === "file" ? expectedFile(entry.path, entry.bytes, entry.mode) : entry))
		.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
}

export interface TreeFile {
	path: string;
	lines: string[];
}

/**
 * A tree of count text files under data/, at most 100 per directory:
 * data/g<dir>/f<index>.<ext>. Lines come from one pool per tree, so a
 * 50 000 file tree stays cheap to generate while every byte still comes from
 * the scenario's stream. ext picks each file's extension.
 */
export function buildTree(rng: Rng, count: number, ext: (index: number) => string = () => "txt"): TreeFile[] {
	const pool: string[] = [];
	for (let i = 0; i < POOL_SIZE; i += 1) pool.push(fillerLine(rng, rng.int(20, 80), "ascii"));
	const out: TreeFile[] = [];
	for (let index = 0; index < count; index += 1) {
		const lines: string[] = [];
		const length = rng.int(4, 16);
		for (let line = 0; line < length; line += 1) lines.push(pool[rng.int(0, POOL_SIZE - 1)] as string);
		const dir = String(Math.floor(index / 100)).padStart(3, "0");
		out.push({ path: `data/g${dir}/f${String(index).padStart(5, "0")}.${ext(index)}`, lines });
	}
	return out;
}

/** count distinct integers in [0, size), in ascending order. */
export function pickDistinct(rng: Rng, count: number, size: number): number[] {
	const picked = new Set<number>();
	while (picked.size < Math.min(count, size)) picked.add(rng.int(0, size - 1));
	return [...picked].sort((left, right) => left - right);
}

export function treeEntry(file: TreeFile): CorpusEntry {
	return { kind: "file", path: file.path, bytes: Buffer.from(`${file.lines.join("\n")}\n`, "utf8"), mode: 0o644 };
}
