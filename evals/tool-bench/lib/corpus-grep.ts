/**
 * The grep tool's scenario table and builder. See corpus.ts for the shared
 * contract: every scenario is a pure function of (seed, split, template).
 *
 * grep never mutates, so every scenario expects the scratch root unchanged.
 * An ok scenario also expects its matches: `path:line:` for every line the
 * call should show, the absence of every decoy and ignored file, and the
 * observation's shown count. Anchors carry `<`, `:`, digits, and uppercase,
 * so tree filler never matches a pattern.
 */
import {
	buildTree,
	CORPUS_SCHEMA,
	type CorpusEntry,
	fillerLine,
	KB,
	MB,
	type Profile,
	pickDistinct,
	Rng,
	type ScenarioBase,
	type Split,
	scenarioId,
	type TreeFile,
	treeEntry,
	unchangedFiles,
} from "./corpus-core.js";

export interface GrepCall {
	pattern: string;
	path?: string;
	literal?: boolean;
	ignore_case?: boolean;
	context?: number;
	limit?: number;
}

export interface GrepScenario extends ScenarioBase {
	tool: "grep";
	args: GrepCall;
}

type GrepShape =
	| "literal"
	| "regex"
	| "ignore-case"
	| "no-match"
	| "every-file"
	| "huge-file"
	| "byte-cap"
	| "binary"
	| "invalid-utf8"
	| "long-line"
	| "gitignore"
	| "symlink-inside"
	| "symlink-outside"
	| "symlink-outside-path"
	| "missing-path"
	| "invalid-regex"
	| "tree"
	| "context";

export interface GrepTemplate {
	key: string;
	profile: Profile;
	shape: GrepShape;
	/** Text files in the tree under data/. */
	tree: number;
	/** Size of the one large file, for huge-file and byte-cap. */
	bytes?: number;
}

/** The tool's default match limit (src/tools/grep.ts DEFAULT_LIMIT). */
const DEFAULT_LIMIT = 100;

export const GREP_TEMPLATES: readonly GrepTemplate[] = [
	{ key: "literal-10", profile: "default", shape: "literal", tree: 10 },
	{ key: "regex-100", profile: "default", shape: "regex", tree: 100 },
	{ key: "ignore-case-100", profile: "default", shape: "ignore-case", tree: 100 },
	{ key: "no-match-1k", profile: "default", shape: "no-match", tree: 1000 },
	{ key: "every-file-50", profile: "default", shape: "every-file", tree: 50 },
	{ key: "huge-file-limit-16m", profile: "default", shape: "huge-file", tree: 10, bytes: 16 * MB },
	{ key: "huge-file-limit-100m", profile: "full", shape: "huge-file", tree: 10, bytes: 100 * MB },
	{ key: "byte-cap-4m", profile: "default", shape: "byte-cap", tree: 10, bytes: 4 * MB },
	{ key: "binary-nul", profile: "default", shape: "binary", tree: 10 },
	{ key: "invalid-utf8", profile: "default", shape: "invalid-utf8", tree: 10 },
	{ key: "long-line-256k", profile: "default", shape: "long-line", tree: 10, bytes: 256 * KB },
	{ key: "gitignore", profile: "default", shape: "gitignore", tree: 10 },
	{ key: "symlink-dir-inside", profile: "default", shape: "symlink-inside", tree: 10 },
	{ key: "symlink-dir-outside", profile: "default", shape: "symlink-outside", tree: 10 },
	{ key: "tree-10k", profile: "default", shape: "tree", tree: 10000 },
	{ key: "tree-50k", profile: "full", shape: "tree", tree: 50000 },
	{ key: "context-1k", profile: "full", shape: "context", tree: 1000 },
	{ key: "err-symlink-outside-path", profile: "default", shape: "symlink-outside-path", tree: 10 },
	{ key: "err-missing-path", profile: "default", shape: "missing-path", tree: 10 },
	{ key: "err-invalid-regex", profile: "default", shape: "invalid-regex", tree: 10 },
];

/** Every nth line of a large file carries `<M000001:tag>`, numbered from 1. */
function markedFile(rng: Rng, bytes: number, every: number, tag: string): { lines: string[]; marks: number[] } {
	const pool: string[] = [];
	for (let i = 0; i < 512; i += 1) pool.push(fillerLine(rng, rng.int(20, 100), "ascii"));
	const lines: string[] = [];
	const marks: number[] = [];
	let total = 0;
	while (total < bytes) {
		let line = pool[rng.int(0, pool.length - 1)] as string;
		if (lines.length % every === every - 1) {
			marks.push(lines.length + 1);
			line = `${line} <M${String(marks.length).padStart(6, "0")}:${tag}>`;
		}
		lines.push(line);
		total += line.length + 1;
	}
	return { lines, marks };
}

export function generateGrepScenario(seed: number, split: Split, key: string): GrepScenario {
	if (!Number.isSafeInteger(seed)) throw new Error(`seed must be an integer: ${seed}`);
	const template = GREP_TEMPLATES.find((candidate) => candidate.key === key);
	if (template === undefined) throw new Error(`unknown grep scenario template: ${key}`);
	const rng = new Rng(`${CORPUS_SCHEMA}|grep|${split}|${seed}|${key}`);
	const tag = rng.hex(8);
	const tree = buildTree(rng, template.tree);
	const extra: CorpusEntry[] = [];
	const includes: string[] = [];
	const excludes: string[] = [];
	let shown = 0;

	/** One inserted line per file, so line numbers never shift under a later insert. */
	const insert = (file: TreeFile, text: string): string => {
		const at = rng.int(0, file.lines.length);
		file.lines.splice(at, 0, `${fillerLine(rng, rng.int(5, 30), "ascii")} ${text}`);
		return `${file.path}:${at + 1}:`;
	};
	const hits = (count: number, text: (index: number) => string, decoys = 0, decoy?: (index: number) => string) => {
		const picked = pickDistinct(rng, count + decoys, tree.length);
		const order = picked.map((index) => ({ index, sort: rng.next() })).sort((left, right) => left.sort - right.sort);
		for (const [slot, { index }] of order.entries()) {
			const file = tree[index] as TreeFile;
			if (slot < count) {
				includes.push(insert(file, text(slot)));
				shown += 1;
			} else if (decoy !== undefined) {
				insert(file, decoy(slot));
				excludes.push(`${file.path}:`);
			}
		}
	};

	let args: GrepCall;
	let outcome: "ok" | "error" = "ok";
	switch (template.shape) {
		case "literal": {
			// Read as a regex, the pattern's group and `.` match the decoys too.
			hits(
				3,
				() => `(HIT.${tag})`,
				3,
				() => `(HITx${tag})`,
			);
			args = { pattern: `(HIT.${tag})`, literal: true };
			break;
		}
		case "regex": {
			hits(
				4,
				(index) => `HIT-${100 + index * 111}-${tag}`,
				4,
				(index) => `HIT-${10 + index}x-${tag}`,
			);
			args = { pattern: `HIT-[0-9]{3}-${tag}` };
			break;
		}
		case "ignore-case": {
			const variants = [`hit:${tag}`, `HIT:${tag.toUpperCase()}`, `Hit:${tag}`, `hIT:${tag.toUpperCase()}`];
			hits(4, (index) => variants[index] as string);
			args = { pattern: `hit:${tag}`, ignore_case: true };
			break;
		}
		case "no-match": {
			includes.push("No matches found");
			args = { pattern: `NOPE:${tag}` };
			break;
		}
		case "every-file": {
			hits(tree.length, () => `EVERY:${tag}`);
			args = { pattern: `EVERY:${tag}`, literal: true };
			break;
		}
		case "huge-file": {
			// More marks than the default limit: the call stops at the limit and
			// offers the next one.
			const path = `data/huge-${tag}.txt`;
			const { lines, marks } = markedFile(rng, template.bytes as number, 1000, tag);
			extra.push({ kind: "file", path, bytes: Buffer.from(`${lines.join("\n")}\n`, "utf8"), mode: 0o644 });
			includes.push(`${path}:${marks[0]}:`, `${path}:${marks[DEFAULT_LIMIT - 1]}:`, `limit=${DEFAULT_LIMIT * 2}`);
			excludes.push(`<M${String(DEFAULT_LIMIT + 1).padStart(6, "0")}:${tag}>`);
			shown = DEFAULT_LIMIT;
			args = { pattern: `<M[0-9]{6}:${tag}>` };
			break;
		}
		case "byte-cap": {
			// A limit of 1000 marks renders past the 16 KiB content cap, so the
			// byte cap cuts the output, offloads the full rendering, and says so.
			const path = `data/huge-${tag}.txt`;
			const { lines, marks } = markedFile(rng, template.bytes as number, 20, tag);
			extra.push({ kind: "file", path, bytes: Buffer.from(`${lines.join("\n")}\n`, "utf8"), mode: 0o644 });
			includes.push(`${path}:${marks[0]}:`, '"truncated":true', "full: <state>/");
			excludes.push(`<M001000:${tag}>`);
			shown = -1;
			args = { pattern: `<M[0-9]{6}:${tag}>`, limit: 1000 };
			break;
		}
		case "binary": {
			// A NUL byte in the first KiB makes a file binary; a walk skips it.
			hits(1, () => `BIN:${tag}`);
			for (const name of ["a", "b"]) {
				const path = `data/blob-${name}-${tag}.bin`;
				const text = `head\0${fillerLine(rng, 40, "ascii")}\nBIN:${tag}\n${fillerLine(rng, 40, "ascii")}\n`;
				extra.push({ kind: "file", path, bytes: Buffer.from(text, "utf8"), mode: 0o644 });
				excludes.push(`${path}:`);
			}
			args = { pattern: `BIN:${tag}`, literal: true };
			break;
		}
		case "invalid-utf8": {
			// The match on the invalid line must show; the valid one sets the baseline.
			hits(1, () => `UTF:${tag}`);
			const path = `data/latin-${tag}.txt`;
			const bytes = Buffer.concat([
				Buffer.from(`${fillerLine(rng, 40, "ascii")}\n`, "utf8"),
				Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x20, 0xc3, 0x28, 0x20]),
				Buffer.from(`UTF:${tag}\n${fillerLine(rng, 40, "ascii")}\n`, "utf8"),
			]);
			extra.push({ kind: "file", path, bytes, mode: 0o644 });
			includes.push(`${path}:2:`);
			shown += 1;
			args = { pattern: `UTF:${tag}`, literal: true };
			break;
		}
		case "long-line": {
			// One line with no terminator and the match in its middle. The tool
			// cuts a shown line at 500 characters and says so.
			const path = `data/long-${tag}.txt`;
			const half = Math.floor((template.bytes as number) / 2);
			const text = `${fillerLine(rng, half, "ascii")} LONG:${tag} ${fillerLine(rng, half, "ascii")}`;
			extra.push({ kind: "file", path, bytes: Buffer.from(text, "utf8"), mode: 0o644 });
			includes.push(`${path}:1:`, "Some lines truncated to 500 chars");
			excludes.push(`LONG:${tag}`);
			shown = 1;
			args = { pattern: `LONG:${tag}`, literal: true };
			break;
		}
		case "gitignore": {
			hits(2, () => `IGN:${tag}`);
			extra.push({
				kind: "file",
				path: ".gitignore",
				bytes: Buffer.from(`# ${tag}\nignored/\n*.log\n`, "utf8"),
				mode: 0o644,
			});
			for (const path of [`data/ignored/kept-${tag}.txt`, `data/notes-${tag}.log`]) {
				extra.push({ kind: "file", path, bytes: Buffer.from(`one\nIGN:${tag}\n`, "utf8"), mode: 0o644 });
				excludes.push(`${path}:`);
			}
			args = { pattern: `IGN:${tag}`, literal: true };
			break;
		}
		case "symlink-inside": {
			// The walk does not follow data/linked, so its one match shows once.
			const path = `data/real/r-${tag}.txt`;
			extra.push({ kind: "file", path, bytes: Buffer.from(`one\nLINK:${tag}\n`, "utf8"), mode: 0o644 });
			extra.push({ kind: "symlink", path: "data/linked", target: "real" });
			includes.push(`${path}:2:`);
			excludes.push(`data/linked/`);
			shown = 1;
			args = { pattern: `LINK:${tag}`, literal: true };
			break;
		}
		case "symlink-outside":
		case "symlink-outside-path": {
			// data/out names the directory holding the scratch root, so a search
			// through it would show this tree again under root/.
			hits(2, () => `OUT:${tag}`);
			extra.push({ kind: "symlink", path: "data/out", target: "../.." });
			excludes.push("root/data/");
			if (template.shape === "symlink-outside") args = { pattern: `OUT:${tag}`, literal: true };
			else {
				args = { pattern: `OUT:${tag}`, literal: true, path: "data/out" };
				outcome = "error";
			}
			break;
		}
		case "missing-path": {
			args = { pattern: `GONE:${tag}`, path: `data/absent-${tag}` };
			outcome = "error";
			break;
		}
		case "invalid-regex": {
			args = { pattern: `HIT(${tag}` };
			outcome = "error";
			break;
		}
		case "tree": {
			hits(5, () => `TREE:${tag}`);
			args = { pattern: `TREE:${tag}`, literal: true };
			break;
		}
		case "context": {
			hits(3, () => `CTX:${tag}`);
			args = { pattern: `CTX:${tag}`, literal: true, context: 2 };
			break;
		}
	}
	if (outcome === "ok" && shown >= 0) includes.push(`"shownCount":${shown},`);

	const files = [...tree.map(treeEntry), ...extra];
	return {
		id: scenarioId("grep", split, key),
		tool: "grep",
		seed,
		split,
		template: key,
		profile: template.profile,
		files,
		args,
		expect: {
			outcome,
			files: unchangedFiles(files),
			...(outcome === "ok" ? { output: { includes, excludes } } : {}),
		},
	};
}
