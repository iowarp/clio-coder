/**
 * Seeded scenario corpus for the tool bench.
 *
 * Every scenario is a pure function of (seed, split, template). The random
 * stream for one scenario is sfc32 keyed by the SHA-256 of the corpus schema,
 * the tool, the split name, the seed, and the template key, so the search and
 * holdout splits draw from disjoint streams and carry disjoint scenario ids.
 * Nothing here reads the clock, the environment, or Math.random.
 *
 * CLI: node --import tsx evals/tool-bench/lib/corpus.ts --seed <int> --split search|holdout
 *        [--profile default|full] [--out <dir>]
 * Prints one JSON line per scenario (id, content hash, file bytes) and, with
 * --out, writes each scenario's files under <dir>/<scenario id>/.
 */
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const CORPUS_SCHEMA = "clio-coder.tool-bench.corpus.v1";
export const SPLITS = ["search", "holdout"] as const;
export type Split = (typeof SPLITS)[number];
export const PROFILES = ["default", "full"] as const;
export type Profile = (typeof PROFILES)[number];
export const DEFAULT_SEED = 1;

export type CorpusEntry =
	| { kind: "file"; path: string; bytes: Buffer; mode: number }
	| { kind: "symlink"; path: string; target: string };

export type ExpectedEntry =
	| { kind: "file"; path: string; size: number; sha256: string; mode: number }
	| { kind: "symlink"; path: string; target: string };

export interface EditCall {
	path: string;
	edits: Array<{ oldText: string; newText: string }>;
}

export interface EditScenario {
	id: string;
	tool: "edit";
	seed: number;
	split: Split;
	template: string;
	profile: Profile;
	files: CorpusEntry[];
	args: EditCall;
	expect: { outcome: "ok" | "error"; files: ExpectedEntry[] };
}

type Position = "head" | "middle" | "tail" | "spread";
type Shape = "same" | "grow" | "shrink" | "mixed";
type ErrorPath = "missing-file" | "no-match" | "ambiguous" | "invalid-utf8" | "overlap" | "mixed-eol" | "nul-byte";

interface EditTemplate {
	key: string;
	profile: Profile;
	/** Target file size in bytes; the file ends on the first line that reaches it. */
	bytes: number;
	/** Characters per generated line, inclusive range. */
	line: [number, number];
	eol: "\n" | "\r\n";
	text: "ascii" | "multibyte";
	bom?: boolean;
	/** False writes the whole file as one line with no terminator. */
	finalNewline?: boolean;
	edits: number;
	position: Position;
	shape: Shape;
	mode?: number;
	symlink?: boolean;
	error?: ErrorPath;
}

const KB = 1024;
const MB = 1024 * 1024;

/**
 * The one scenario table. Both splits and both profiles come from it. The
 * default profile keeps one trial of the suite under a minute and still covers
 * every dimension; the full profile adds the 100 MB case and the overlapping
 * variants.
 */
export const EDIT_TEMPLATES: readonly EditTemplate[] = [
	{
		key: "size-1k-head",
		profile: "default",
		bytes: 1 * KB,
		line: [20, 80],
		eol: "\n",
		text: "ascii",
		edits: 1,
		position: "head",
		shape: "same",
	},
	{
		key: "size-1k-tail",
		profile: "full",
		bytes: 1 * KB,
		line: [20, 80],
		eol: "\n",
		text: "ascii",
		edits: 1,
		position: "tail",
		shape: "same",
	},
	{
		key: "size-64k-middle",
		profile: "default",
		bytes: 64 * KB,
		line: [20, 100],
		eol: "\n",
		text: "ascii",
		edits: 1,
		position: "middle",
		shape: "same",
	},
	{
		key: "size-900k-middle",
		profile: "full",
		bytes: 900 * KB,
		line: [20, 100],
		eol: "\n",
		text: "ascii",
		edits: 1,
		position: "middle",
		shape: "same",
	},
	{
		key: "size-4m-middle",
		profile: "default",
		bytes: 4 * MB,
		line: [20, 100],
		eol: "\n",
		text: "ascii",
		edits: 1,
		position: "middle",
		shape: "same",
	},
	{
		key: "size-16m-tail",
		profile: "default",
		bytes: 16 * MB,
		line: [20, 100],
		eol: "\n",
		text: "ascii",
		edits: 1,
		position: "tail",
		shape: "same",
	},
	{
		key: "size-100m-middle",
		profile: "full",
		bytes: 100 * MB,
		line: [20, 100],
		eol: "\n",
		text: "ascii",
		edits: 1,
		position: "middle",
		shape: "same",
	},
	{
		key: "lines-short-64k",
		profile: "default",
		bytes: 64 * KB,
		line: [0, 6],
		eol: "\n",
		text: "ascii",
		edits: 4,
		position: "spread",
		shape: "same",
	},
	{
		key: "lines-long-256k",
		profile: "default",
		bytes: 256 * KB,
		line: [2000, 6000],
		eol: "\n",
		text: "ascii",
		edits: 4,
		position: "spread",
		shape: "same",
	},
	{
		key: "single-line-256k",
		profile: "default",
		bytes: 256 * KB,
		line: [256 * KB, 256 * KB],
		eol: "\n",
		text: "ascii",
		finalNewline: false,
		edits: 3,
		position: "spread",
		shape: "same",
	},
	{
		key: "utf8-multibyte-middle",
		profile: "default",
		bytes: 64 * KB,
		line: [20, 100],
		eol: "\n",
		text: "multibyte",
		edits: 2,
		position: "middle",
		shape: "mixed",
	},
	{
		key: "utf8-bom-head",
		profile: "default",
		bytes: 16 * KB,
		line: [20, 100],
		eol: "\n",
		text: "multibyte",
		bom: true,
		edits: 1,
		position: "head",
		shape: "grow",
	},
	{
		key: "crlf-64k-middle",
		profile: "default",
		bytes: 64 * KB,
		line: [20, 100],
		eol: "\r\n",
		text: "ascii",
		edits: 2,
		position: "middle",
		shape: "grow",
	},
	{
		key: "crlf-4m-spread",
		profile: "default",
		bytes: 4 * MB,
		line: [20, 100],
		eol: "\r\n",
		text: "ascii",
		edits: 16,
		position: "spread",
		shape: "mixed",
	},
	{
		key: "density-8-64k",
		profile: "full",
		bytes: 64 * KB,
		line: [20, 100],
		eol: "\n",
		text: "ascii",
		edits: 8,
		position: "spread",
		shape: "mixed",
	},
	{
		key: "density-64-256k",
		profile: "default",
		bytes: 256 * KB,
		line: [20, 100],
		eol: "\n",
		text: "ascii",
		edits: 64,
		position: "spread",
		shape: "mixed",
	},
	{
		key: "density-256-900k",
		profile: "default",
		bytes: 900 * KB,
		line: [20, 100],
		eol: "\n",
		text: "ascii",
		edits: 256,
		position: "spread",
		shape: "mixed",
	},
	{
		key: "density-512-4m",
		profile: "default",
		bytes: 4 * MB,
		line: [20, 100],
		eol: "\n",
		text: "ascii",
		edits: 512,
		position: "spread",
		shape: "mixed",
	},
	{
		key: "grow-multiline-tail",
		profile: "full",
		bytes: 16 * KB,
		line: [20, 100],
		eol: "\n",
		text: "ascii",
		edits: 1,
		position: "tail",
		shape: "grow",
	},
	{
		key: "shrink-delete-head",
		profile: "full",
		bytes: 16 * KB,
		line: [20, 100],
		eol: "\n",
		text: "ascii",
		edits: 3,
		position: "head",
		shape: "shrink",
	},
	{
		key: "mode-755-middle",
		profile: "default",
		bytes: 4 * KB,
		line: [20, 80],
		eol: "\n",
		text: "ascii",
		edits: 1,
		position: "middle",
		shape: "same",
		mode: 0o755,
	},
	{
		key: "symlink-middle",
		profile: "default",
		bytes: 4 * KB,
		line: [20, 80],
		eol: "\n",
		text: "ascii",
		edits: 1,
		position: "middle",
		shape: "same",
		symlink: true,
	},
	{
		key: "err-missing-file",
		profile: "default",
		bytes: 1 * KB,
		line: [20, 80],
		eol: "\n",
		text: "ascii",
		edits: 1,
		position: "middle",
		shape: "same",
		error: "missing-file",
	},
	{
		key: "err-no-match",
		profile: "default",
		bytes: 64 * KB,
		line: [20, 100],
		eol: "\n",
		text: "ascii",
		edits: 1,
		position: "middle",
		shape: "same",
		error: "no-match",
	},
	{
		key: "err-ambiguous",
		profile: "default",
		bytes: 64 * KB,
		line: [20, 100],
		eol: "\n",
		text: "ascii",
		edits: 1,
		position: "spread",
		shape: "same",
		error: "ambiguous",
	},
	{
		key: "err-overlap",
		profile: "default",
		bytes: 16 * KB,
		line: [20, 100],
		eol: "\n",
		text: "ascii",
		edits: 1,
		position: "middle",
		shape: "same",
		error: "overlap",
	},
	{
		key: "err-invalid-utf8",
		profile: "default",
		bytes: 64 * KB,
		line: [20, 100],
		eol: "\n",
		text: "multibyte",
		edits: 1,
		position: "tail",
		shape: "same",
		error: "invalid-utf8",
	},
	{
		key: "err-mixed-eol",
		profile: "default",
		bytes: 64 * KB,
		line: [20, 100],
		eol: "\n",
		text: "ascii",
		edits: 1,
		position: "head",
		shape: "same",
		error: "mixed-eol",
	},
	{
		key: "err-nul-byte",
		profile: "full",
		bytes: 16 * KB,
		line: [20, 100],
		eol: "\n",
		text: "ascii",
		edits: 1,
		position: "middle",
		shape: "same",
		error: "nul-byte",
	},
];

/** sfc32: small, fast, and identical on every JavaScript engine. */
class Rng {
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
const POOL_LINES = 512;

function word(rng: Rng, text: EditTemplate["text"]): string {
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
function fillerLine(rng: Rng, length: number, text: EditTemplate["text"]): string {
	let out = "";
	while (out.length < length) out += (out.length === 0 ? "" : " ") + word(rng, text);
	return out.slice(0, length);
}

export function scenarioId(split: Split, key: string): string {
	return `edit.${split}.${key}`;
}

export function parseScenarioId(id: string): { split: Split; key: string } {
	const match = /^edit\.(search|holdout)\.([a-z0-9-]+)$/u.exec(id);
	if (match === null) throw new Error(`not an edit scenario id: ${id}`);
	return { split: match[1] as Split, key: match[2] as string };
}

export function templatesFor(profile: Profile): EditTemplate[] {
	return EDIT_TEMPLATES.filter((template) => profile === "full" || template.profile === "default");
}

function anchorLines(rng: Rng, count: number, lines: number, position: Position): number[] {
	const band = Math.max(0, Math.floor(lines * 0.02));
	const out: number[] = [];
	for (let i = 0; i < count; i += 1) {
		if (position === "head") out.push(rng.int(0, band));
		else if (position === "tail") out.push(rng.int(lines - 1 - band, lines - 1));
		else if (position === "middle") out.push(rng.int(Math.floor(lines / 2) - band / 2, Math.floor(lines / 2) + band / 2));
		else out.push(Math.min(lines - 1, Math.floor(((i + 0.5) * lines) / count)));
	}
	return out.map((line) => Math.max(0, Math.min(lines - 1, Math.floor(line))));
}

function newTextFor(rng: Rng, shape: Shape, index: number, tag: string, text: EditTemplate["text"]): string {
	const resolved: Shape = shape === "mixed" ? ((["same", "grow", "shrink"] as const)[index % 3] ?? "same") : shape;
	if (resolved === "shrink") return "";
	const replacement = `<<R${index}:${tag}>>`;
	if (resolved === "same") return replacement;
	const extra = rng.int(1, 40);
	const lines = [replacement];
	for (let i = 0; i < extra; i += 1) lines.push(fillerLine(rng, rng.int(10, 70), text));
	return lines.join("\n");
}

/**
 * The post-state an exact editor must produce. Anchors are unique by
 * construction (each carries its own index, and filler never contains `<`), so
 * one forward search per edit finds its only occurrence.
 */
function applyExact(content: Buffer, edits: EditCall["edits"], eol: string): Buffer {
	let cursor = 0;
	const spans = edits.map((edit) => {
		const needle = Buffer.from(edit.oldText, "utf8");
		let at = content.indexOf(needle, cursor);
		if (at < 0) at = content.indexOf(needle);
		if (at < 0) throw new Error(`corpus invariant: ${edit.oldText} is missing`);
		cursor = at + needle.length;
		return { at, end: at + needle.length, text: Buffer.from(edit.newText.replaceAll("\n", eol), "utf8") };
	});
	spans.sort((left, right) => left.at - right.at);
	const parts: Buffer[] = [];
	let offset = 0;
	for (const span of spans) {
		if (span.at < offset) throw new Error("corpus invariant: expected edits overlap");
		parts.push(content.subarray(offset, span.at), span.text);
		offset = span.end;
	}
	parts.push(content.subarray(offset));
	return Buffer.concat(parts);
}

function expectedFile(path: string, bytes: Buffer, mode: number): ExpectedEntry {
	return { kind: "file", path, size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), mode };
}

export function generateScenario(seed: number, split: Split, key: string): EditScenario {
	if (!Number.isSafeInteger(seed)) throw new Error(`seed must be an integer: ${seed}`);
	const template = EDIT_TEMPLATES.find((candidate) => candidate.key === key);
	if (template === undefined) throw new Error(`unknown edit scenario template: ${key}`);
	const rng = new Rng(`${CORPUS_SCHEMA}|edit|${split}|${seed}|${key}`);

	// A pool of generated lines, sampled per output line, keeps the 100 MB case
	// fast while every byte still comes from this scenario's stream.
	const pool: Buffer[] = [];
	for (let i = 0; template.finalNewline !== false && i < POOL_LINES; i += 1) {
		pool.push(Buffer.from(fillerLine(rng, rng.int(template.line[0], template.line[1]), template.text), "utf8"));
	}
	const eol = Buffer.from(template.eol, "utf8");
	const lines: Buffer[] = [];
	let total = 0;
	if (template.finalNewline === false) {
		lines.push(Buffer.from(fillerLine(rng, template.bytes, template.text), "utf8"));
	} else {
		while (total < template.bytes) {
			const line = pool[rng.int(0, POOL_LINES - 1)] as Buffer;
			lines.push(line);
			total += line.length + eol.length;
		}
	}

	// Anchor i sits at a line and a character offset within it. Several anchors
	// on one line are inserted from the right so earlier offsets stay valid.
	const tag = rng.hex(8);
	const anchors = Array.from({ length: template.edits }, (_, index) => `<<E${index}:${tag}>>`);
	const placement = anchorLines(rng, anchors.length, lines.length, template.position);
	const byLine = new Map<number, Array<{ anchor: string; offset: number }>>();
	for (const [index, anchor] of anchors.entries()) {
		const line = placement[index] as number;
		const slot = byLine.get(line) ?? [];
		slot.push({ anchor, offset: rng.int(0, (lines[line] as Buffer).toString("utf8").length) });
		byLine.set(line, slot);
	}
	if (template.error === "ambiguous") {
		const first = anchors[0] as string;
		const other = (placement[0] as number) < lines.length / 2 ? lines.length - 1 : 0;
		const slot = byLine.get(other) ?? [];
		slot.push({ anchor: first, offset: 0 });
		byLine.set(other, slot);
	}
	for (const [line, slot] of byLine) {
		let text = (lines[line] as Buffer).toString("utf8");
		for (const { anchor, offset } of [...slot].sort((left, right) => right.offset - left.offset)) {
			text = `${text.slice(0, offset)}${anchor}${text.slice(offset)}`;
		}
		lines[line] = Buffer.from(text, "utf8");
	}

	const parts: Buffer[] = template.bom === true ? [Buffer.from([0xef, 0xbb, 0xbf])] : [];
	const middle = Math.floor(lines.length / 2);
	for (const [index, line] of lines.entries()) {
		if (index === middle && template.error === "invalid-utf8") parts.push(Buffer.from([0xc3, 0x28]));
		if (index === middle && template.error === "nul-byte") parts.push(Buffer.from([0x00]));
		parts.push(line);
		if (template.finalNewline === false) continue;
		parts.push(index === middle && template.error === "mixed-eol" ? Buffer.from("\r\n", "utf8") : eol);
	}
	const content = Buffer.concat(parts);

	const edits = anchors.map((anchor, index) => ({
		oldText: anchor,
		newText: newTextFor(rng, template.shape, index, tag, template.text),
	}));
	if (template.error === "no-match") (edits[0] as EditCall["edits"][number]).oldText = `<<MISSING:${rng.hex(8)}>>`;
	if (template.error === "overlap") edits.push({ oldText: (anchors[0] as string).slice(3), newText: `<<O:${tag}>>` });

	const mode = template.mode ?? 0o644;
	const targetPath = template.symlink === true ? "data/real.txt" : "data/target.txt";
	const files: CorpusEntry[] = [{ kind: "file", path: targetPath, bytes: content, mode }];
	if (template.symlink === true) files.push({ kind: "symlink", path: "data/link.txt", target: "real.txt" });
	const callPath =
		template.error === "missing-file" ? "data/absent.txt" : template.symlink === true ? "data/link.txt" : targetPath;

	const outcome = template.error === undefined ? "ok" : "error";
	const after = outcome === "ok" ? applyExact(content, edits, template.eol) : content;
	const expected: ExpectedEntry[] = [expectedFile(targetPath, after, mode)];
	if (template.symlink === true) expected.push({ kind: "symlink", path: "data/link.txt", target: "real.txt" });

	return {
		id: scenarioId(split, key),
		tool: "edit",
		seed,
		split,
		template: key,
		profile: template.profile,
		files,
		args: { path: callPath, edits },
		expect: { outcome, files: expected.sort((left, right) => left.path.localeCompare(right.path)) },
	};
}

export function generateCorpus(seed: number, split: Split, profile: Profile = "default"): EditScenario[] {
	return templatesFor(profile).map((template) => generateScenario(seed, split, template.key));
}

/** Hash over everything a scenario feeds the tool: its files and its call. */
export function scenarioContentHash(scenario: EditScenario): string {
	const hash = createHash("sha256");
	for (const entry of scenario.files) {
		hash.update(`${entry.kind}\0${entry.path}\0`);
		if (entry.kind === "file") hash.update(`${entry.mode}\0`).update(entry.bytes);
		else hash.update(entry.target);
		hash.update("\0");
	}
	hash.update(JSON.stringify(scenario.args));
	return hash.digest("hex");
}

/** Writes a scenario's files under root with explicit modes, so umask never leaks in. */
export function materializeScenario(scenario: EditScenario, root: string): void {
	for (const entry of scenario.files) {
		const target = join(root, entry.path);
		mkdirSync(dirname(target), { recursive: true, mode: 0o755 });
		chmodSync(dirname(target), 0o755);
		if (entry.kind === "symlink") {
			symlinkSync(entry.target, target);
			continue;
		}
		writeFileSync(target, entry.bytes, { mode: entry.mode });
		chmodSync(target, entry.mode);
	}
}

export function parseCorpusArgs(argv: readonly string[]): {
	seed: number;
	split: Split;
	profile: Profile;
	rest: Map<string, string>;
} {
	const values = new Map<string, string>();
	for (let i = 0; i < argv.length; i += 1) {
		const flag = argv[i] as string;
		if (!flag.startsWith("--")) throw new Error(`unexpected argument: ${flag}`);
		const value = argv[i + 1];
		if (value === undefined || value.startsWith("--")) throw new Error(`${flag} needs a value`);
		values.set(flag.slice(2), value);
		i += 1;
	}
	const seedText = values.get("seed") ?? String(DEFAULT_SEED);
	if (!/^-?\d+$/u.test(seedText)) throw new Error(`--seed must be an integer: ${seedText}`);
	const split = values.get("split") ?? "search";
	if (!(SPLITS as readonly string[]).includes(split)) throw new Error(`--split must be search or holdout: ${split}`);
	const profile = values.get("profile") ?? "default";
	if (!(PROFILES as readonly string[]).includes(profile))
		throw new Error(`--profile must be default or full: ${profile}`);
	values.delete("seed");
	values.delete("split");
	values.delete("profile");
	return { seed: Number(seedText), split: split as Split, profile: profile as Profile, rest: values };
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
	const { seed, split, profile, rest } = parseCorpusArgs(process.argv.slice(2));
	const out = rest.get("out");
	rest.delete("out");
	if (rest.size > 0) throw new Error(`unknown flags: ${[...rest.keys()].join(", ")}`);
	for (const scenario of generateCorpus(seed, split, profile)) {
		if (out !== undefined) materializeScenario(scenario, join(out, scenario.id));
		const bytes = scenario.files.reduce((sum, entry) => sum + (entry.kind === "file" ? entry.bytes.length : 0), 0);
		process.stdout.write(`${JSON.stringify({ id: scenario.id, contentHash: scenarioContentHash(scenario), bytes })}\n`);
	}
}
