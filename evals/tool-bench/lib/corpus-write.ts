/**
 * The write tool's scenario table and builder. See corpus.ts for the shared
 * contract: every scenario is a pure function of (seed, split, template).
 *
 * An ok scenario expects the written file to hold exactly the call's content
 * and every other entry untouched. An error scenario expects the scratch root
 * unchanged. Two error paths aim outside the scratch root: the driver runs
 * each call in a scratch root nested one level inside its own temp directory,
 * so a write that escaped lands there, is recorded, and fails the scenario.
 */
import {
	CORPUS_SCHEMA,
	type CorpusEntry,
	type ExpectedEntry,
	expectedFile,
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

export interface WriteCall {
	path: string;
	content: string;
}

export interface WriteScenario extends ScenarioBase {
	tool: "write";
	args: WriteCall;
}

type WriteError = "directory" | "escape" | "symlink-escape" | "readonly-parent";

export interface WriteTemplate {
	key: string;
	profile: Profile;
	/** The file the call replaces; absent when the call creates it. */
	existing?: { bytes: number; mode: number };
	/** Size of the new content in bytes; "same" matches the existing file's size exactly. */
	bytes: number | "same";
	/** Characters per generated line, inclusive range. */
	line: [number, number];
	eol: "\n" | "\r\n";
	text: TextKind;
	/** False leaves the new content without a final line terminator. */
	finalNewline?: boolean;
	/** Where a created file goes, relative to the scratch root. */
	createAt?: string;
	/** The call goes through data/link.txt, which points at the existing data/real.txt. */
	symlink?: boolean;
	error?: WriteError;
}

/** The mode a created file or directory gets under the umask the driver pins. */
const CREATED_FILE_MODE = 0o644;
const CREATED_DIR_MODE = 0o755;

const TEXT = { line: [20, 100], eol: "\n", text: "ascii" } as const satisfies Partial<WriteTemplate>;
const FILE_644 = { mode: 0o644 } as const;

export const WRITE_TEMPLATES: readonly WriteTemplate[] = [
	{ key: "create-1k", profile: "default", bytes: 1 * KB, ...TEXT, createAt: "data/new.txt" },
	{ key: "create-nested-64k", profile: "default", bytes: 64 * KB, ...TEXT, createAt: "data/a/b/c/new.txt" },
	{ key: "create-16m", profile: "default", bytes: 16 * MB, ...TEXT, createAt: "data/new.txt" },
	{ key: "create-100m", profile: "full", bytes: 100 * MB, ...TEXT, createAt: "data/new.txt" },
	{ key: "overwrite-same-1k", profile: "full", existing: { bytes: 1 * KB, ...FILE_644 }, bytes: "same", ...TEXT },
	{ key: "overwrite-same-64k", profile: "default", existing: { bytes: 64 * KB, ...FILE_644 }, bytes: "same", ...TEXT },
	{ key: "create-900k", profile: "default", bytes: 900 * KB, ...TEXT, createAt: "data/new.txt" },
	{
		// The tool diffs both sides below 1 MiB, which costs about 6 s here, so
		// this case stays out of the default profile's one-minute trial.
		key: "overwrite-grow-900k",
		profile: "full",
		existing: { bytes: 64 * KB, ...FILE_644 },
		bytes: 900 * KB,
		...TEXT,
	},
	{ key: "overwrite-grow-16m", profile: "full", existing: { bytes: 1 * KB, ...FILE_644 }, bytes: 16 * MB, ...TEXT },
	{ key: "overwrite-shrink-4m", profile: "default", existing: { bytes: 4 * MB, ...FILE_644 }, bytes: 1 * KB, ...TEXT },
	{
		key: "utf8-multibyte-64k",
		profile: "default",
		existing: { bytes: 16 * KB, ...FILE_644 },
		bytes: 64 * KB,
		line: [20, 100],
		eol: "\n",
		text: "multibyte",
	},
	{
		key: "crlf-64k",
		profile: "default",
		existing: { bytes: 16 * KB, ...FILE_644 },
		bytes: 64 * KB,
		line: [20, 100],
		eol: "\r\n",
		text: "ascii",
	},
	{
		key: "no-final-newline-1k",
		profile: "default",
		existing: { bytes: 1 * KB, ...FILE_644 },
		bytes: 1 * KB,
		...TEXT,
		finalNewline: false,
	},
	{ key: "empty-content", profile: "default", existing: { bytes: 1 * KB, ...FILE_644 }, bytes: 0, ...TEXT },
	{
		key: "symlink-target-64k",
		profile: "default",
		existing: { bytes: 64 * KB, ...FILE_644 },
		bytes: 64 * KB,
		...TEXT,
		symlink: true,
	},
	{ key: "mode-755-overwrite", profile: "default", existing: { bytes: 16 * KB, mode: 0o755 }, bytes: 16 * KB, ...TEXT },
	{ key: "mode-600-overwrite", profile: "full", existing: { bytes: 16 * KB, mode: 0o600 }, bytes: 16 * KB, ...TEXT },
	{ key: "err-directory", profile: "default", bytes: 1 * KB, ...TEXT, error: "directory" },
	{ key: "err-escape", profile: "default", bytes: 1 * KB, ...TEXT, error: "escape" },
	{ key: "err-symlink-escape", profile: "default", bytes: 1 * KB, ...TEXT, error: "symlink-escape" },
	{ key: "err-readonly-parent", profile: "default", bytes: 1 * KB, ...TEXT, error: "readonly-parent" },
];

function body(rng: Rng, template: WriteTemplate, bytes: number, finalNewline: boolean): Buffer {
	return joinLines(
		poolLines(rng, { bytes, line: template.line, text: template.text }, template.eol.length),
		template.eol,
		finalNewline,
	);
}

export function generateWriteScenario(seed: number, split: Split, key: string): WriteScenario {
	if (!Number.isSafeInteger(seed)) throw new Error(`seed must be an integer: ${seed}`);
	const template = WRITE_TEMPLATES.find((candidate) => candidate.key === key);
	if (template === undefined) throw new Error(`unknown write scenario template: ${key}`);
	const rng = new Rng(`${CORPUS_SCHEMA}|write|${split}|${seed}|${key}`);

	const files: CorpusEntry[] = [{ kind: "dir", path: "data", mode: 0o755 }];
	const expected: ExpectedEntry[] = [];
	const keep = (entry: CorpusEntry): void => {
		files.push(entry);
		if (entry.kind === "file") expected.push(expectedFile(entry.path, entry.bytes, entry.mode));
		else expected.push(entry);
	};

	// The file the call replaces, when there is one. Its bytes come first from
	// the stream, so a template's new content never repeats them.
	const targetPath = template.symlink === true ? "data/real.txt" : "data/target.txt";
	const existing =
		template.existing === undefined
			? null
			: { bytes: body(rng, template, template.existing.bytes, true), mode: template.existing.mode };
	if (existing !== null) files.push({ kind: "file", path: targetPath, bytes: existing.bytes, mode: existing.mode });
	if (template.symlink === true) keep({ kind: "symlink", path: "data/link.txt", target: "real.txt" });

	let content: Buffer;
	if (template.bytes === "same") {
		const size = existing?.bytes.length ?? 0;
		const eol = Buffer.from(template.eol, "utf8");
		content = Buffer.concat([body(rng, template, size, true).subarray(0, size - eol.length), eol]);
	} else
		content =
			template.bytes === 0 ? Buffer.alloc(0) : body(rng, template, template.bytes, template.finalNewline !== false);

	let callPath = template.symlink === true ? "data/link.txt" : (template.createAt ?? targetPath);
	if (template.error === "directory") {
		keep({ kind: "dir", path: "data/sub", mode: 0o755 });
		callPath = "data/sub";
	}
	if (template.error === "escape") callPath = "../escape.txt";
	if (template.error === "symlink-escape") {
		keep({ kind: "symlink", path: "data/out.txt", target: "../../escape.txt" });
		callPath = "data/out.txt";
	}
	if (template.error === "readonly-parent") {
		keep({ kind: "dir", path: "ro", mode: 0o555 });
		callPath = "ro/new.txt";
	}

	const outcome = template.error === undefined ? "ok" : "error";
	const written = template.symlink === true ? targetPath : callPath;
	if (outcome === "ok") {
		expected.push(expectedFile(written, content, existing?.mode ?? CREATED_FILE_MODE));
		// Directories the write creates on the way to its file.
		const parts = written.split("/").slice(0, -1);
		for (let depth = 2; depth <= parts.length; depth += 1) {
			expected.push({ kind: "dir", path: parts.slice(0, depth).join("/"), mode: CREATED_DIR_MODE });
		}
	} else if (existing !== null) expected.push(expectedFile(targetPath, existing.bytes, existing.mode));

	const bytes = content.length;
	return {
		id: scenarioId("write", split, key),
		tool: "write",
		seed,
		split,
		template: key,
		profile: template.profile,
		files,
		args: { path: callPath, content: content.toString("utf8") },
		expect: {
			outcome,
			files: expected.sort((left, right) => left.path.localeCompare(right.path)),
			...(outcome === "ok" ? { output: { includes: [`wrote ${bytes}B to ${callPath}`], excludes: [] } } : {}),
		},
	};
}
