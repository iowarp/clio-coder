/**
 * `run --task-file <path|->` (SPEC 6.2, 6.3): the task envelope, version 1.
 *
 * Every envelope key mirrors one `run` flag, so the envelope is checked by turning it into the flags it mirrors and
 * handing the command line plus those flags to the one run parser: the mode matrix, value checks and conflicts that
 * hold for flags hold for envelope keys without a second copy. What the parser cannot see is decided here, before
 * boot and with exit 2, each naming the dotted path: malformed JSON, `schemaVersion` other than 1, an unknown key, a
 * value of the wrong type, a key also given as a flag (`task_flag_conflict`), and a key that widens what the host
 * does without `--trust-task-file` (`task_authority`). The task text rides after `--`, so it is never read as a flag.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { type CliArgDiagnostic, parseRunCliArgs, type RunCliArgs, taskFileAuthorityRefusal } from "./args.js";

const TASK_ENVELOPE_SCHEMA_VERSION = 1;

type ValueKind = "string" | "number" | "boolean" | "duration" | "count" | "list";

/** One envelope leaf: the flags it mirrors (for conflicts) and the argv it stands for. */
interface EnvelopeLeaf {
	readonly kind: ValueKind;
	readonly flags: ReadonlyArray<string>;
	readonly emit: (value: never) => string[];
}

const valueFlag =
	(flag: string) =>
	(value: string | number): string[] => [flag, String(value)];
const switchFlag =
	(flag: string) =>
	(value: boolean): string[] =>
		value ? [flag] : [];
const listFlag =
	(flag: string, emptyIsAbsent = false) =>
	(value: string[]): string[] =>
		value.length === 0 ? (emptyIsAbsent ? [] : [flag, "none"]) : [flag, value.join(",")];

function leaf(kind: ValueKind, flags: ReadonlyArray<string>, emit: (value: never) => string[]): EnvelopeLeaf {
	return { kind, flags, emit };
}

const SAMPLING: Readonly<Record<string, EnvelopeLeaf>> = {
	temperature: leaf("number", ["--temperature"], valueFlag("--temperature")),
	topP: leaf("number", ["--top-p"], valueFlag("--top-p")),
	topK: leaf("number", ["--top-k"], valueFlag("--top-k")),
	minP: leaf("number", ["--min-p"], valueFlag("--min-p")),
	presencePenalty: leaf("number", ["--presence-penalty"], valueFlag("--presence-penalty")),
	frequencyPenalty: leaf("number", ["--frequency-penalty"], valueFlag("--frequency-penalty")),
	repeatPenalty: leaf("number", ["--repeat-penalty"], valueFlag("--repeat-penalty")),
};

/** Keyed groups; `task`, `schemaVersion`, `attachments`, `verify`, `answers` and `output.schema` are handled apart. */
const GROUPS: Readonly<Record<string, Readonly<Record<string, EnvelopeLeaf>>>> = {
	route: {
		target: leaf("string", ["--target"], valueFlag("--target")),
		model: leaf("string", ["--model"], valueFlag("--model")),
		thinking: leaf("string", ["--thinking"], valueFlag("--thinking")),
	},
	session: {
		resume: leaf("string", ["--resume"], valueFlag("--resume")),
		continue: leaf("boolean", ["--continue"], switchFlag("--continue")),
		fork: leaf("boolean", ["--fork"], switchFlag("--fork")),
		name: leaf("string", ["--name"], valueFlag("--name")),
	},
	permissions: {
		autonomy: leaf("string", ["--autonomy"], valueFlag("--autonomy")),
		readOnly: leaf("boolean", ["--read-only"], switchFlag("--read-only")),
		allowTools: leaf("list", ["--allow-tools"], listFlag("--allow-tools")),
		denyTools: leaf("list", ["--deny-tools"], listFlag("--deny-tools", true)),
		delegateTools: leaf("list", ["--delegate-tools"], listFlag("--delegate-tools")),
		delegate: leaf("boolean", ["--no-delegate"], (value: boolean) => (value ? [] : ["--no-delegate"])),
		onPermission: leaf("string", ["--on-permission"], valueFlag("--on-permission")),
		sandbox: leaf("string", ["--sandbox"], valueFlag("--sandbox")),
	},
	limits: {
		timeout: leaf("duration", ["--timeout"], valueFlag("--timeout")),
		maxCostUsd: leaf("number", ["--max-cost-usd"], valueFlag("--max-cost-usd")),
		maxRequests: leaf("number", ["--max-requests"], valueFlag("--max-requests")),
		maxToolCalls: leaf("number", ["--max-tool-calls"], valueFlag("--max-tool-calls")),
		maxContextTokens: leaf("count", ["--max-context-tokens"], valueFlag("--max-context-tokens")),
		requirePriced: leaf("boolean", ["--require-priced"], switchFlag("--require-priced")),
	},
	output: {
		format: leaf("string", ["--output-format"], valueFlag("--output-format")),
		lastMessage: leaf("string", ["--output-last-message"], valueFlag("--output-last-message")),
	},
};

const TOP_LEVEL: Readonly<Record<string, EnvelopeLeaf>> = {
	cwd: leaf("string", ["--cwd"], valueFlag("--cwd")),
	mode: leaf("string", ["--turn-mode"], valueFlag("--turn-mode")),
	agent: leaf("string", ["--agent"], valueFlag("--agent")),
	systemone: leaf("string", ["--systemone"], valueFlag("--systemone")),
	steerChannel: leaf("string", ["--steer-channel"], valueFlag("--steer-channel")),
	skills: leaf("list", ["--skill"], (value: string[]) => value.flatMap((skill) => ["--skill", skill])),
	noSkills: leaf("boolean", ["--no-skills"], switchFlag("--no-skills")),
	failOnVerify: leaf("boolean", ["--fail-on-verify"], switchFlag("--fail-on-verify")),
	failOnNoop: leaf("boolean", ["--fail-on-noop"], switchFlag("--fail-on-noop")),
	answers: leaf("string", ["--answers"], valueFlag("--answers")),
};

/** Every key the envelope accepts at its root; the manifest and `schema task` describe the same set. */
export const TASK_ENVELOPE_KEYS: ReadonlyArray<string> = [
	"schemaVersion",
	"task",
	"attachments",
	"verify",
	...Object.keys(GROUPS),
	...Object.keys(TOP_LEVEL),
];

/** Flag spellings that are one flag for conflict purposes. */
const FLAG_ALIASES: Readonly<Record<string, string>> = {
	"-r": "--resume",
	"-o": "--output-last-message",
};

class EnvelopeError extends Error {
	constructor(
		readonly slug: NonNullable<CliArgDiagnostic["slug"]>,
		message: string,
	) {
		super(message);
	}
}

const usage = (message: string): EnvelopeError => new EnvelopeError("usage", message);

/** The flags a command line gives, normalized (`--x=v` is `--x`, aliases folded), stopping at `--`. */
function flagsOnCommandLine(args: ReadonlyArray<string>): Set<string> {
	const flags = new Set<string>();
	for (let i = 0; i < args.length; i += 1) {
		const arg = args[i] ?? "";
		if (arg === "--") break;
		if (!arg.startsWith("-") || arg === "-") continue;
		const name = arg.includes("=") ? arg.slice(0, arg.indexOf("=")) : arg;
		flags.add(FLAG_ALIASES[name] ?? name);
		// The one flag whose value may start with a dash.
		if (arg === "--verify") i += 1;
	}
	return flags;
}

/** The command line without the `--task-file` tokens and without a trailing bare `--` (there is no argv text). */
function withoutTaskFileTokens(args: ReadonlyArray<string>): string[] {
	const kept: string[] = [];
	for (let i = 0; i < args.length; i += 1) {
		const arg = args[i] ?? "";
		if (arg === "--trust-task-file" || arg.startsWith("--task-file=")) continue;
		if (arg === "--task-file") {
			i += 1;
			continue;
		}
		if (arg === "--verify" && i + 1 < args.length) {
			kept.push(arg, args[i + 1] ?? "");
			i += 1;
			continue;
		}
		kept.push(arg);
	}
	if (kept.at(-1) === "--") kept.pop();
	return kept;
}

function describeType(value: unknown): string {
	if (value === null) return "null";
	if (Array.isArray(value)) return "an array";
	return `a ${typeof value}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function checkKind(dotted: string, kind: ValueKind, value: unknown): void {
	const ok =
		kind === "string"
			? typeof value === "string"
			: kind === "number"
				? typeof value === "number" && Number.isFinite(value)
				: kind === "boolean"
					? typeof value === "boolean"
					: kind === "duration" || kind === "count"
						? typeof value === "string" || (typeof value === "number" && Number.isFinite(value))
						: Array.isArray(value) && value.every((item) => typeof item === "string");
	if (ok) return;
	const expected =
		kind === "list"
			? "an array of strings"
			: kind === "duration"
				? "a duration string or a number"
				: kind === "count"
					? "a string or a number"
					: kind === "number"
						? "a finite number"
						: `a ${kind}`;
	throw usage(`task file ${dotted}: expected ${expected}, got ${describeType(value)}`);
}

interface Translation {
	/** Envelope-derived argv, task text last after `--`. */
	readonly argv: string[];
	/** Flag to the dotted envelope path that produced it, for diagnostics. */
	readonly origin: Map<string, string>;
	readonly outputSchema?: { readonly inline: unknown; readonly label: string };
}

/** Check the envelope and turn it into run flags; throws an `EnvelopeError` naming the dotted path. */
function translateTaskEnvelope(
	value: unknown,
	options: { readonly trusted: boolean; readonly commandLineFlags: ReadonlySet<string> },
): Translation {
	if (!isRecord(value)) throw usage(`task file: the envelope must be a JSON object, got ${describeType(value)}`);
	if (value.schemaVersion !== TASK_ENVELOPE_SCHEMA_VERSION)
		// SPEC 6.6: an envelope version this release does not read.
		throw new EnvelopeError(
			"schema_unsupported",
			value.schemaVersion === undefined
				? "task file schemaVersion: required, and must be 1"
				: `task file schemaVersion: this release reads version 1, got ${JSON.stringify(value.schemaVersion)}`,
		);
	for (const key of Object.keys(value)) {
		if (!TASK_ENVELOPE_KEYS.includes(key)) throw usage(`task file ${key}: unknown key`);
	}
	const task = value.task;
	if (task === undefined) throw usage("task file task: required");
	if (typeof task !== "string") throw usage(`task file task: expected a string, got ${describeType(task)}`);
	if (task.trim().length === 0) throw new EnvelopeError("empty_task", "task file task: the task text is empty");

	// Null is the same as absent for every optional key (`"agent": null`, `"delegateTools": null`).
	const present = (record: Record<string, unknown>): Array<[string, unknown]> =>
		Object.entries(record).filter(([, item]) => item !== null && item !== undefined);

	const argv: string[] = [];
	const origin = new Map<string, string>();
	const fileArgs: string[] = [];
	let outputSchema: Translation["outputSchema"];
	const claim = (dotted: string, flags: ReadonlyArray<string>, emitted: string[]): void => {
		const clash = flags.find((flag) => options.commandLineFlags.has(flag));
		if (clash !== undefined)
			throw new EnvelopeError(
				"task_flag_conflict",
				`task file key ${dotted} is also given as ${clash} on the command line; set it in one place`,
			);
		for (const flag of flags) if (!origin.has(flag)) origin.set(flag, dotted);
		argv.push(...emitted);
	};
	const takeLeaf = (dotted: string, spec: EnvelopeLeaf, item: unknown): void => {
		checkKind(dotted, spec.kind, item);
		claim(dotted, spec.flags, spec.emit(item as never));
	};

	for (const [key, item] of present(value)) {
		if (key === "schemaVersion" || key === "task") continue;
		const top = TOP_LEVEL[key];
		if (top !== undefined) {
			takeLeaf(key, top, item);
			continue;
		}
		const group = GROUPS[key];
		if (group !== undefined) {
			if (!isRecord(item)) throw usage(`task file ${key}: expected an object, got ${describeType(item)}`);
			for (const [name, inner] of present(item)) {
				const dotted = `${key}.${name}`;
				if (key === "output" && name === "schema") {
					if (!isRecord(inner))
						throw new EnvelopeError(
							"schema_unsupported",
							`task file ${dotted}: expected a JSON Schema object, got ${describeType(inner)}`,
						);
					claim(dotted, ["--output-schema"], []);
					outputSchema = { inline: inner, label: dotted };
					continue;
				}
				if (key === "route" && name === "sampling") {
					if (!isRecord(inner)) throw usage(`task file ${dotted}: expected an object, got ${describeType(inner)}`);
					for (const [knob, setting] of present(inner)) {
						const spec = SAMPLING[knob];
						if (spec === undefined) throw usage(`task file ${dotted}.${knob}: unknown key`);
						takeLeaf(`${dotted}.${knob}`, spec, setting);
					}
					continue;
				}
				const spec = group[name];
				if (spec === undefined) throw usage(`task file ${dotted}: unknown key`);
				takeLeaf(dotted, spec, inner);
			}
			continue;
		}
		if (key === "attachments") {
			if (!Array.isArray(item)) throw usage(`task file attachments: expected an array, got ${describeType(item)}`);
			item.forEach((attachment, index) => {
				const dotted = `attachments[${index}]`;
				if (!isRecord(attachment)) throw usage(`task file ${dotted}: expected an object with a path`);
				for (const name of Object.keys(attachment))
					if (name !== "path") throw usage(`task file ${dotted}.${name}: unknown key`);
				if (typeof attachment.path !== "string" || attachment.path.length === 0)
					throw usage(`task file ${dotted}.path: expected a non-empty string`);
				fileArgs.push(`@${attachment.path}`);
			});
			continue;
		}
		if (key === "verify") {
			if (!Array.isArray(item)) throw usage(`task file verify: expected an array, got ${describeType(item)}`);
			let timeout: { value: string; dotted: string } | undefined;
			item.forEach((check, index) => {
				const dotted = `verify[${index}]`;
				if (!isRecord(check)) throw usage(`task file ${dotted}: expected an object with a command`);
				for (const name of Object.keys(check))
					if (name !== "command" && name !== "timeout") throw usage(`task file ${dotted}.${name}: unknown key`);
				if (typeof check.command !== "string" || check.command.trim().length === 0)
					throw usage(`task file ${dotted}.command: expected a non-empty string`);
				claim(`${dotted}.command`, ["--verify"], ["--verify", check.command]);
				if (check.timeout === undefined || check.timeout === null) return;
				checkKind(`${dotted}.timeout`, "duration", check.timeout);
				const text = String(check.timeout);
				// 0.8.5 has one --verify-timeout for every check, so the envelope may name one value.
				if (timeout !== undefined && timeout.value !== text)
					throw usage(
						`task file ${dotted}.timeout: every check shares one timeout in this release; ${timeout.dotted}.timeout is ${timeout.value}`,
					);
				if (timeout === undefined) {
					timeout = { value: text, dotted };
					claim(`${dotted}.timeout`, ["--verify-timeout"], ["--verify-timeout", text]);
				}
			});
		}
	}
	// SPEC 6.3 (review H06): the same gate for a file and for stdin, after the shape is known to be sound.
	const refusal = taskFileAuthorityRefusal(
		Object.fromEntries(present(value)) as Readonly<Record<string, unknown>>,
		options.trusted,
	);
	if (refusal !== undefined) throw new EnvelopeError("task_authority", refusal);
	return {
		argv: [...argv, ...fileArgs, "--", task],
		origin,
		...(outputSchema !== undefined ? { outputSchema } : {}),
	};
}

async function readStdinToEnd(): Promise<string> {
	const chunks: Buffer[] = [];
	for await (const chunk of process.stdin) chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
	return Buffer.concat(chunks).toString("utf8");
}

async function readEnvelopeText(source: string): Promise<string> {
	if (source === "-") {
		if (process.stdin.isTTY) throw usage("--task-file - reads the envelope from stdin, but stdin is a terminal");
		return readStdinToEnd();
	}
	// SPEC 6.2: the --task-file path resolves against the invocation directory, before --cwd or the envelope's cwd.
	const file = path.resolve(source);
	try {
		return readFileSync(file, "utf8");
	} catch (error) {
		throw usage(`--task-file ${file}: cannot read the file: ${error instanceof Error ? error.message : String(error)}`);
	}
}

function refused(parsed: RunCliArgs, error: EnvelopeError): RunCliArgs {
	parsed.diagnostics.push({ type: "error", slug: error.slug, message: error.message });
	return parsed;
}

/**
 * The run's arguments with any `--task-file` envelope merged in. Without the flag this is `parseRunCliArgs(args)`.
 * A refusal comes back as an error diagnostic carrying its C17 slug, so it is reported like any other usage error,
 * before boot, in the output format the command line asked for.
 */
export async function parseRunArgsWithTaskFile(args: ReadonlyArray<string>): Promise<RunCliArgs> {
	const commandLine = parseRunCliArgs(args);
	const source = commandLine.taskFile;
	if (source === undefined || commandLine.help) return commandLine;
	if (commandLine.diagnostics.some((diagnostic) => diagnostic.type === "error")) return commandLine;
	let translation: Translation;
	try {
		const text = await readEnvelopeText(source);
		let value: unknown;
		try {
			value = JSON.parse(text);
		} catch (error) {
			throw usage(`task file is not JSON: ${error instanceof Error ? error.message : String(error)}`);
		}
		translation = translateTaskEnvelope(value, {
			trusted: commandLine.trustTaskFile === true,
			commandLineFlags: flagsOnCommandLine(args),
		});
	} catch (error) {
		if (error instanceof EnvelopeError) return refused(commandLine, error);
		throw error;
	}
	const merged = parseRunCliArgs([...withoutTaskFileTokens(args), ...translation.argv]);
	// A value the run parser refuses names its flag; say which envelope key that flag came from.
	merged.diagnostics = merged.diagnostics.map((diagnostic) => {
		const flag = /^(--[a-z-]+)/u.exec(diagnostic.message)?.[1];
		const dotted = flag === undefined ? undefined : translation.origin.get(flag);
		return dotted === undefined ? diagnostic : { ...diagnostic, message: `task file ${dotted}: ${diagnostic.message}` };
	});
	merged.taskFile = source;
	if (commandLine.trustTaskFile === true) merged.trustTaskFile = true;
	if (translation.outputSchema !== undefined) merged.outputSchema = translation.outputSchema;
	return merged;
}
