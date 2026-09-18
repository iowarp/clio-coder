/**
 * The read tool's scenario table and builder. See corpus.ts for the shared
 * contract: every scenario is a pure function of (seed, split, template).
 *
 * Read never mutates, so every scenario expects the scratch root unchanged.
 * An ok scenario also expects its output window: sentinels sit at the start of
 * the first and last lines the call should show, and at the lines just outside
 * that window, so a read that drops or adds a line fails the scenario.
 */
import {
	CORPUS_SCHEMA,
	type CorpusEntry,
	type ExpectedEntry,
	expectedFile,
	fillerLine,
	joinLines,
	KB,
	MB,
	type Profile,
	poolLines,
	Rng,
	type ScenarioBase,
	type Split,
	scenarioId,
	type TextKind,
} from "./corpus-core.js";

export interface ReadCall {
	path: string;
	offset?: number;
	limit?: number;
	tail?: number;
	line_numbers?: boolean;
}

export interface ReadScenario extends ScenarioBase {
	tool: "read";
	args: ReadCall;
}

type ReadError = "missing-file" | "directory" | "invalid-utf8" | "nul-byte" | "unreadable" | "dotdot-link-escape";

export interface ReadTemplate {
	key: string;
	profile: Profile;
	/** Target file size in bytes; the file ends on the first line that reaches it. */
	bytes: number;
	/** Characters per generated line, inclusive range. */
	line: [number, number];
	eol: "\n" | "\r\n";
	text: TextKind;
	bom?: boolean;
	/** False writes the whole file as one line with no terminator. */
	finalNewline?: boolean;
	/** The call. "middle" starts at the middle line; "past-eof" starts ten lines after the last. */
	offset?: number | "middle" | "past-eof";
	limit?: number;
	tail?: number;
	lineNumbers?: boolean;
	symlink?: boolean;
	error?: ReadError;
}

/** The tool's per-call caps (src/tools/truncate.ts and GUARDRAIL_DEFAULTS.readMaxBytes). */
const CAP_LINES = 2000;
const CAP_BYTES = 50 * KB;

const TEXT = { eol: "\n", text: "ascii" } as const;

export const READ_TEMPLATES: readonly ReadTemplate[] = [
	{ key: "size-1k-whole", profile: "default", bytes: 1 * KB, line: [20, 80], ...TEXT },
	{ key: "size-1k-tail", profile: "full", bytes: 1 * KB, line: [20, 80], ...TEXT, tail: 5 },
	{ key: "size-64k-head", profile: "default", bytes: 64 * KB, line: [20, 100], ...TEXT, offset: 1, limit: 40 },
	{
		key: "size-900k-middle",
		profile: "default",
		bytes: 900 * KB,
		line: [20, 100],
		...TEXT,
		offset: "middle",
		limit: 40,
	},
	{ key: "size-4m-tail", profile: "default", bytes: 4 * MB, line: [20, 100], ...TEXT, tail: 40 },
	{ key: "size-16m-middle", profile: "default", bytes: 16 * MB, line: [20, 100], ...TEXT, offset: "middle", limit: 40 },
	{ key: "size-100m-middle", profile: "full", bytes: 100 * MB, line: [20, 100], ...TEXT, offset: "middle", limit: 40 },
	{ key: "size-100m-tail", profile: "full", bytes: 100 * MB, line: [20, 100], ...TEXT, tail: 40 },
	{
		key: "offset-past-eof-64k",
		profile: "default",
		bytes: 64 * KB,
		line: [20, 100],
		...TEXT,
		offset: "past-eof",
		limit: 20,
	},
	{ key: "offset-limit-zero-64k", profile: "default", bytes: 64 * KB, line: [20, 100], ...TEXT, offset: 0, limit: 0 },
	{ key: "limit-over-file-1k", profile: "default", bytes: 1 * KB, line: [20, 80], ...TEXT, offset: 1, limit: 100000 },
	{ key: "tail-over-file-1k", profile: "full", bytes: 1 * KB, line: [20, 80], ...TEXT, tail: 100000 },
	{ key: "single-line-256k", profile: "default", bytes: 256 * KB, line: [0, 0], ...TEXT, finalNewline: false },
	{ key: "lines-long-256k", profile: "default", bytes: 256 * KB, line: [2048, 6144], ...TEXT, offset: 3, limit: 40 },
	{ key: "lines-short-64k", profile: "default", bytes: 64 * KB, line: [0, 6], ...TEXT },
	{
		key: "utf8-multibyte-middle",
		profile: "default",
		bytes: 64 * KB,
		line: [20, 100],
		eol: "\n",
		text: "multibyte",
		offset: "middle",
		limit: 40,
	},
	{
		key: "utf8-bom-head",
		profile: "default",
		bytes: 16 * KB,
		line: [20, 100],
		...TEXT,
		bom: true,
		offset: 1,
		limit: 20,
	},
	{
		key: "crlf-64k-middle",
		profile: "default",
		bytes: 64 * KB,
		line: [20, 100],
		eol: "\r\n",
		text: "ascii",
		offset: "middle",
		limit: 40,
	},
	{ key: "crlf-16m-tail", profile: "full", bytes: 16 * MB, line: [20, 100], eol: "\r\n", text: "ascii", tail: 40 },
	{
		key: "line-numbers-900k",
		profile: "full",
		bytes: 900 * KB,
		line: [20, 100],
		...TEXT,
		offset: "middle",
		limit: 40,
		lineNumbers: true,
	},
	{ key: "empty-file", profile: "default", bytes: 0, line: [20, 80], ...TEXT },
	{
		key: "symlink-head",
		profile: "default",
		bytes: 64 * KB,
		line: [20, 100],
		...TEXT,
		symlink: true,
		offset: 1,
		limit: 40,
	},
	{ key: "err-missing-file", profile: "default", bytes: 16 * KB, line: [20, 100], ...TEXT, error: "missing-file" },
	{ key: "err-directory", profile: "default", bytes: 16 * KB, line: [20, 100], ...TEXT, error: "directory" },
	{ key: "err-invalid-utf8", profile: "default", bytes: 16 * KB, line: [20, 100], ...TEXT, error: "invalid-utf8" },
	{ key: "err-nul-byte", profile: "default", bytes: 16 * KB, line: [20, 100], ...TEXT, error: "nul-byte" },
	{ key: "err-unreadable", profile: "default", bytes: 16 * KB, line: [20, 100], ...TEXT, error: "unreadable" },
	{
		key: "err-dotdot-link-escape",
		profile: "default",
		bytes: 16 * KB,
		line: [20, 100],
		...TEXT,
		error: "dotdot-link-escape",
	},
];

/** The 0-based lines the call should show, clamped the way the tool's caps clamp them. */
function windowOf(
	template: ReadTemplate,
	lines: readonly Buffer[],
	offset: number,
): { first: number; last: number; byteCapped: boolean } {
	const total = lines.length;
	let first = offset - 1;
	let last = total - 1;
	if (template.tail !== undefined) first = Math.max(0, total - template.tail);
	else if (template.limit !== undefined && template.limit > 0) last = Math.min(total - 1, first + template.limit - 1);
	last = Math.min(last, first + CAP_LINES - 1);
	let bytes = 0;
	for (let line = first; line <= last; line += 1) bytes += (lines[line] as Buffer).length + template.eol.length;
	return { first, last, byteCapped: bytes > CAP_BYTES };
}

function mark(line: Buffer, sentinel: string, at: "start" | "end"): Buffer {
	const tag = Buffer.from(sentinel, "utf8");
	return at === "start" ? Buffer.concat([tag, Buffer.from(" "), line]) : Buffer.concat([line, Buffer.from(" "), tag]);
}

export function generateReadScenario(seed: number, split: Split, key: string): ReadScenario {
	if (!Number.isSafeInteger(seed)) throw new Error(`seed must be an integer: ${seed}`);
	const template = READ_TEMPLATES.find((candidate) => candidate.key === key);
	if (template === undefined) throw new Error(`unknown read scenario template: ${key}`);
	const rng = new Rng(`${CORPUS_SCHEMA}|read|${split}|${seed}|${key}`);
	const lines =
		template.finalNewline === false
			? [Buffer.from(fillerLine(rng, template.bytes, template.text), "utf8")]
			: poolLines(rng, template, template.eol.length);
	const tag = rng.hex(8);

	const offset =
		template.offset === "middle"
			? Math.floor(lines.length / 2) + 1
			: template.offset === "past-eof"
				? lines.length + 10
				: template.offset !== undefined && template.offset > 0
					? template.offset
					: 1;
	const includes: string[] = [];
	const excludes: string[] = [];
	const place = (line: number, name: string, at: "start" | "end", into: string[]): void => {
		if (line < 0 || line >= lines.length) return;
		const sentinel = `<<${name}:${tag}>>`;
		lines[line] = mark(lines[line] as Buffer, sentinel, at);
		into.push(sentinel);
	};
	const window = windowOf(template, lines, offset);
	if (template.error === undefined && window.first >= lines.length) {
		// Past EOF shows nothing, so the last line must stay out of the output.
		place(lines.length - 1, "LAST", "end", excludes);
	} else if (template.error === undefined) {
		place(window.first - 1, "BEFORE", "start", excludes);
		place(window.first, "FIRST", "start", includes);
		if (window.byteCapped) place(window.last, "END", "end", excludes);
		else {
			place(window.last, "LAST", "end", includes);
			place(window.last + 1, "AFTER", "start", excludes);
		}
	}
	if (template.error === "invalid-utf8") lines[2] = Buffer.concat([Buffer.from([0xc3, 0x28]), lines[2] as Buffer]);
	if (template.error === "nul-byte") lines[2] = Buffer.concat([Buffer.from([0x00]), lines[2] as Buffer]);

	const bom = template.bom === true ? Buffer.from([0xef, 0xbb, 0xbf]) : undefined;
	const content = joinLines(lines, template.eol, template.finalNewline !== false, bom);
	const mode = template.error === "unreadable" ? 0o000 : 0o644;
	// The stream's tag in the names keeps even the empty file's scenario split-specific.
	const targetPath = template.symlink === true ? `data/real-${tag}.txt` : `data/target-${tag}.txt`;
	const files: CorpusEntry[] = [{ kind: "file", path: targetPath, bytes: content, mode }];
	if (template.symlink === true) files.push({ kind: "symlink", path: "data/link.txt", target: `real-${tag}.txt` });
	// `..` from data/up's target, the scratch root, is outside it, where the
	// target does not exist. path.resolve would read the call as the target.
	if (template.error === "dotdot-link-escape") files.push({ kind: "symlink", path: "data/up", target: ".." });
	const callPath =
		template.error === "missing-file"
			? "data/absent.txt"
			: template.error === "directory"
				? "data"
				: template.error === "dotdot-link-escape"
					? `data/up/../${targetPath.slice("data/".length)}`
					: template.symlink === true
						? "data/link.txt"
						: targetPath;

	const args: ReadCall = { path: callPath };
	if (template.offset !== undefined)
		args.offset = template.offset === "middle" || template.offset === "past-eof" ? offset : template.offset;
	if (template.limit !== undefined) args.limit = template.limit;
	if (template.tail !== undefined) args.tail = template.tail;
	if (template.lineNumbers === true) args.line_numbers = true;

	const expected: ExpectedEntry[] = [expectedFile(targetPath, content, mode)];
	if (template.symlink === true) expected.push({ kind: "symlink", path: "data/link.txt", target: `real-${tag}.txt` });
	if (template.error === "dotdot-link-escape") expected.push({ kind: "symlink", path: "data/up", target: ".." });
	// The tool refuses an offset past the last line rather than showing nothing.
	const outcome = template.error === undefined && template.offset !== "past-eof" ? "ok" : "error";
	return {
		id: scenarioId("read", split, key),
		tool: "read",
		seed,
		split,
		template: key,
		profile: template.profile,
		files,
		args,
		expect: {
			outcome,
			files: expected.sort((left, right) => left.path.localeCompare(right.path)),
			...(template.error === undefined ? { output: { includes, excludes } } : {}),
		},
	};
}
