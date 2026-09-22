/**
 * The bash tool's scenario table and builder. See corpus.ts for the shared
 * contract: every scenario is a pure function of (seed, split, template).
 *
 * Bash is the first execute-plane tool in the bench, so the scenarios are
 * written to keep the one property the digest depends on: the same command on
 * the same input produces the same bytes on every machine. Every command is a
 * POSIX shell builtin or `cat`, reads only files the scenario seeded, and
 * touches no clock, network, process id or random source. Nothing here removes
 * a path, and no scenario relies on the safety net to stop a destructive
 * command: a bench that needs admission to save it is one admission change away
 * from deleting the machine it runs on.
 *
 * The anchor tag is drawn from the scenario's own stream, so the same template
 * carries different bytes in the search and holdout splits.
 */
import {
	type BenchAutonomy,
	CORPUS_SCHEMA,
	type CorpusEntry,
	DEFAULT_AUTONOMY,
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

export interface BashCall {
	command: string;
	cwd?: string;
	timeout_ms?: number;
	output_policy?: "full" | "bounded" | "summary" | "metadata-only";
}

export interface BashScenario extends ScenarioBase {
	tool: "bash";
	args: BashCall;
}

type BashShape =
	/** Writes the anchor to stdout and exits zero. */
	| "stdout"
	/** Writes the anchor to stderr and exits zero. */
	| "stderr"
	/** Writes to both streams, so their combination order is in the digest. */
	| "both-streams"
	/** Writes the anchor, then exits with an explicit nonzero status. */
	| "exit-code"
	/** Names a command that does not exist, so the shell's own 127 is in the digest. */
	| "not-found"
	/** Prints the seeded input file, so the tool's output shaping covers real bytes. */
	| "read-input"
	/** Redirects into a new file under data/, so the post-state is checked. */
	| "write-file"
	/** Appends to the seeded input file. */
	| "append-file"
	/** Runs with an explicit cwd inside the scratch root. */
	| "cwd-inside"
	/** Runs with a cwd that leaves the workspace root. */
	| "cwd-escape"
	/** Ends without a final line terminator. */
	| "no-final-newline"
	/** Prints a file of BMP multibyte text. */
	| "multibyte"
	/** Prints a file holding NUL and other non-UTF-8 bytes. */
	| "binary"
	/** Prints a large file under an explicit output policy. */
	| "policy"
	/** Sleeps past an explicit timeout_ms. */
	| "timeout"
	/** Sends a command the schema rejects. */
	| "invalid"
	/** Runs at the default autonomy, where an execute-plane call parks. */
	| "parked";

export interface BashTemplate {
	key: string;
	profile: Profile;
	shape: BashShape;
	/** Bytes of data/input.txt; every scenario seeds one so the splits differ in file content. */
	input: number;
	/** Explicit output_policy on the call. */
	policy?: BashCall["output_policy"];
	/** Explicit exit status for the exit-code shape. */
	status?: number;
	/**
	 * The autonomy the call runs at. Execute-plane calls park below full-auto,
	 * so a scenario that measures what bash does declares it and one that
	 * measures the park does not.
	 */
	autonomy?: BenchAutonomy;
}

/** Every shape but the parked ones measures execution, which needs an autonomy that admits it. */
const EXECUTING_AUTONOMY: BenchAutonomy = "full-auto";

/** The mode a file the shell creates gets under the umask the driver pins. */
const CREATED_FILE_MODE = 0o644;
/** Comfortably past the timeout the scenario sets, so a loaded machine still times out. */
const SLEEP_SECONDS = 5;
const TIMEOUT_MS = 250;
/** The tool's combined-output ceiling (BASH_HARD_CAP_BYTES in src/tools/bash.ts). */
const HARD_CAP_BYTES = 16 * MB;

export const BASH_TEMPLATES: readonly BashTemplate[] = [
	{ key: "stdout-plain", profile: "default", shape: "stdout", input: 1 * KB },
	{ key: "stderr-plain", profile: "default", shape: "stderr", input: 1 * KB },
	{ key: "both-streams", profile: "default", shape: "both-streams", input: 1 * KB },
	{ key: "exit-42", profile: "default", shape: "exit-code", input: 1 * KB, status: 42 },
	{ key: "exit-1", profile: "default", shape: "exit-code", input: 1 * KB, status: 1 },
	{ key: "err-not-found", profile: "default", shape: "not-found", input: 1 * KB },
	{ key: "read-input-64k", profile: "default", shape: "read-input", input: 64 * KB },
	{ key: "read-input-900k", profile: "default", shape: "read-input", input: 900 * KB },
	{ key: "write-file", profile: "default", shape: "write-file", input: 1 * KB },
	{ key: "append-file", profile: "default", shape: "append-file", input: 4 * KB },
	{ key: "cwd-inside", profile: "default", shape: "cwd-inside", input: 1 * KB },
	{ key: "err-cwd-escape", profile: "default", shape: "cwd-escape", input: 1 * KB },
	{ key: "no-final-newline", profile: "default", shape: "no-final-newline", input: 1 * KB },
	{ key: "utf8-multibyte-16k", profile: "default", shape: "multibyte", input: 16 * KB },
	{ key: "binary-output", profile: "default", shape: "binary", input: 1 * KB },
	{ key: "policy-bounded-4m", profile: "default", shape: "policy", input: 4 * MB, policy: "bounded" },
	{ key: "policy-summary-4m", profile: "default", shape: "policy", input: 4 * MB, policy: "summary" },
	{ key: "policy-metadata-only-4m", profile: "default", shape: "policy", input: 4 * MB, policy: "metadata-only" },
	{ key: "policy-full-1k", profile: "default", shape: "policy", input: 1 * KB, policy: "full" },
	{ key: "err-timeout", profile: "default", shape: "timeout", input: 1 * KB },
	{ key: "err-empty-command", profile: "default", shape: "invalid", input: 1 * KB },
	// The two scenarios that keep the bench default autonomy, so the admission
	// decision an execute call gets is pinned alongside what the call does once
	// admitted. A change that stops parking bash moves these digests.
	{ key: "parked-at-auto-edit", profile: "default", shape: "parked", input: 1 * KB },
	{ key: "parked-read-only", profile: "default", shape: "parked", input: 1 * KB, autonomy: "read-only" },
	// Past the tool's 16 MiB hard cap, which stops the child and takes the
	// offload path. It moves 20 MB through a pipe, so it stays out of the
	// default profile's one-minute trial.
	{ key: "output-cap-20m", profile: "full", shape: "policy", input: 20 * MB, policy: "bounded" },
];

const TEXT = { line: [20, 100] as [number, number], eol: "\n" as const };

function body(rng: Rng, bytes: number, text: TextKind): Buffer {
	return joinLines(poolLines(rng, { bytes, line: TEXT.line, text }, TEXT.eol.length), TEXT.eol, true);
}

export function generateBashScenario(seed: number, split: Split, key: string): BashScenario {
	if (!Number.isSafeInteger(seed)) throw new Error(`seed must be an integer: ${seed}`);
	const template = BASH_TEMPLATES.find((candidate) => candidate.key === key);
	if (template === undefined) throw new Error(`unknown bash scenario template: ${key}`);
	const rng = new Rng(`${CORPUS_SCHEMA}|bash|${split}|${seed}|${key}`);
	// Uppercase and digits only, so an anchor can never collide with the
	// lowercase filler the input file is built from.
	const tag = rng.hex(8).toUpperCase();

	const text: TextKind = template.shape === "multibyte" ? "multibyte" : "ascii";
	const input: CorpusEntry =
		template.shape === "binary"
			? { kind: "file", path: "data/input.txt", bytes: binaryBody(rng, template.input), mode: 0o644 }
			: { kind: "file", path: "data/input.txt", bytes: body(rng, template.input, text), mode: 0o644 };
	const files: CorpusEntry[] = [{ kind: "dir", path: "data", mode: 0o755 }, input];
	// Every scenario leaves the input in place unless it is the one that appends.
	const expected: ExpectedEntry[] = [];
	const inputBytes = input.kind === "file" ? input.bytes : Buffer.alloc(0);

	let args: BashCall;
	let outcome: "ok" | "error" = "ok";
	const includes: string[] = [];
	const excludes: string[] = [];
	const keepInput = (): void => void expected.push(expectedFile("data/input.txt", inputBytes, 0o644));

	switch (template.shape) {
		case "stdout": {
			args = { command: `printf 'OUT:%s\\n' ${tag}` };
			includes.push(`OUT:${tag}`);
			keepInput();
			break;
		}
		case "stderr": {
			args = { command: `printf 'ERR:%s\\n' ${tag} >&2` };
			includes.push(`ERR:${tag}`);
			keepInput();
			break;
		}
		case "both-streams": {
			args = { command: `printf 'OUT:%s\\n' ${tag}; printf 'ERR:%s\\n' ${tag} >&2` };
			includes.push(`OUT:${tag}`, `ERR:${tag}`);
			keepInput();
			break;
		}
		case "exit-code": {
			args = { command: `printf 'OUT:%s\\n' ${tag}; exit ${template.status ?? 1}` };
			outcome = "error";
			keepInput();
			break;
		}
		case "not-found": {
			args = { command: `no-such-command-${tag}` };
			outcome = "error";
			keepInput();
			break;
		}
		case "read-input": {
			args = { command: "cat data/input.txt" };
			keepInput();
			break;
		}
		case "write-file": {
			const bytes = Buffer.from(`NEW:${tag}\n`, "utf8");
			args = { command: `printf 'NEW:%s\\n' ${tag} > data/out.txt` };
			keepInput();
			expected.push(expectedFile("data/out.txt", bytes, CREATED_FILE_MODE));
			break;
		}
		case "append-file": {
			const appended = Buffer.concat([inputBytes, Buffer.from(`MORE:${tag}\n`, "utf8")]);
			args = { command: `printf 'MORE:%s\\n' ${tag} >> data/input.txt` };
			expected.push(expectedFile("data/input.txt", appended, 0o644));
			break;
		}
		case "cwd-inside": {
			args = { command: `printf 'CWD:%s\\n' ${tag}; wc -c < input.txt`, cwd: "data" };
			includes.push(`CWD:${tag}`, String(inputBytes.length));
			keepInput();
			break;
		}
		case "cwd-escape": {
			args = { command: `printf 'OUT:%s\\n' ${tag}`, cwd: ".." };
			outcome = "error";
			excludes.push(`OUT:${tag}`);
			keepInput();
			break;
		}
		case "no-final-newline": {
			args = { command: `printf 'TAIL:%s' ${tag}` };
			includes.push(`TAIL:${tag}`);
			keepInput();
			break;
		}
		case "multibyte":
		case "binary":
		case "policy": {
			args = {
				command: "cat data/input.txt",
				...(template.policy === undefined ? {} : { output_policy: template.policy }),
			};
			// The 16 MiB hard cap stops the child and shapes an error result. The
			// anchor proves the scenario took that path and not some other error.
			if (template.input > HARD_CAP_BYTES) {
				outcome = "error";
				includes.push("hard cap and was stopped");
			}
			keepInput();
			break;
		}
		case "timeout": {
			args = { command: `printf 'OUT:%s\\n' ${tag}; sleep ${SLEEP_SECONDS}`, timeout_ms: TIMEOUT_MS };
			outcome = "error";
			keepInput();
			break;
		}
		case "invalid": {
			args = { command: "" };
			outcome = "error";
			keepInput();
			break;
		}
		case "parked": {
			// Admission stops this below full-auto, and the bench denies the parked
			// call because no operator attends it. The command would print the
			// anchor if it ever ran, so the exclusion proves it did not.
			args = { command: `printf 'OUT:%s\\n' ${tag}` };
			outcome = "error";
			excludes.push(`OUT:${tag}`);
			keepInput();
			break;
		}
	}

	const autonomy = template.shape === "parked" ? (template.autonomy ?? DEFAULT_AUTONOMY) : EXECUTING_AUTONOMY;
	return {
		id: scenarioId("bash", split, key),
		tool: "bash",
		seed,
		split,
		template: key,
		profile: template.profile,
		files,
		args,
		autonomy,
		expect: {
			outcome,
			files: expected.sort((left, right) => left.path.localeCompare(right.path)),
			output: { includes, excludes },
		},
	};
}

/**
 * Bytes no UTF-8 decoder can round-trip, including NUL, so the tool's own
 * decoding and the digest cover a stream that is not text.
 */
function binaryBody(rng: Rng, bytes: number): Buffer {
	const out = Buffer.alloc(bytes);
	for (let index = 0; index < bytes; index += 1) out[index] = rng.int(0, 255);
	return out;
}
