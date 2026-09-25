/**
 * The operator command catalog, projected onto ACP.
 *
 * Two methods ride the `_meta` seam: `_clio-coder/commands/list` hands a client
 * the grammar it needs to build an argument UI, and
 * `_clio-coder/commands/invoke` runs one of them headlessly. Neither adds a
 * `sessionUpdate` kind or a top-level response field, so protocolVersion stays
 * at 1.
 *
 * The registry in `src/interactive/slash-commands.ts` owns 40 commands. Most of
 * them exist to open a full-screen overlay and have no result a wire client
 * could render, and several reach `ctx.keyboardActions`, which a process with
 * no TUI does not have. So this module does not forward what a client asks for:
 * it forwards what {@link ACP_COMMAND_RULES} names, and refuses everything
 * else before a line is ever handed to the parser. An allowlist is the whole
 * security posture here, because `dispatchSlashCommand` on peer-chosen text
 * would reach `/quit`, `/archive import --force`, and the editor.
 */
import type { PendingSkillRequest } from "../../core/skill-activation.js";
import type { NoticeLevel } from "../../interactive/command-output.js";
import type { SlashCommand, SlashCommandContext, SlashCommandKind } from "../../interactive/slash-commands.js";
import {
	BUILTIN_SLASH_COMMANDS,
	commandReference,
	dispatchSlashCommand,
	parseSlashCommand,
} from "../../interactive/slash-commands.js";
import type { CommandArgsSpec, CommandFlagSpec, CommandPositionalSpec } from "../../interactive/slash-spec.js";
import { AcpRequestError } from "./errors.js";
import { ACP_COMMANDS_INVOKE_METHOD, ACP_COMMANDS_LIST_METHOD, ACP_COMMANDS_META_KEY } from "./types.js";

export { ACP_COMMANDS_INVOKE_METHOD, ACP_COMMANDS_LIST_METHOD, ACP_COMMANDS_META_KEY };

/**
 * Bounds on the catalog and on one invocation's result (CONTRACT C001 §3).
 * A client renders every line it receives; a command that streams a worker's
 * output through `io.stderr` can produce thousands of them, and a `values`
 * array comes from a settings-derived list that grows with the install.
 */
const ACP_MAX_COMMAND_NAME_BYTES = 64;
const ACP_MAX_COMMAND_TEXT_BYTES = 512;
const ACP_MAX_COMMAND_VALUES = 64;
const ACP_MAX_COMMAND_FLAGS = 32;
const ACP_MAX_COMMAND_POSITIONALS = 8;
const ACP_MAX_COMMAND_SUBCOMMANDS = 16;
const ACP_MAX_COMMAND_ARGV = 32;
const ACP_MAX_COMMAND_ARGV_BYTES = 4096;
const ACP_MAX_COMMAND_RESULT_LINES = 200;
const ACP_MAX_COMMAND_RESULT_LINE_BYTES = 1024;

const ACP_TRUNCATION_SUFFIX = "…[truncated]";

/** UTF-8-safe prefix; `Buffer.write` stops before a partial sequence, so no lone surrogate escapes. */
function bounded(value: string, maxBytes: number): string {
	if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
	const budget = maxBytes - Buffer.byteLength(ACP_TRUNCATION_SUFFIX, "utf8");
	if (budget <= 0) {
		const flat = Buffer.allocUnsafe(maxBytes);
		return flat.toString("utf8", 0, flat.write(value, 0, maxBytes, "utf8"));
	}
	const buffer = Buffer.allocUnsafe(budget);
	return `${buffer.toString("utf8", 0, buffer.write(value, 0, budget, "utf8"))}${ACP_TRUNCATION_SUFFIX}`;
}

/**
 * How a command behaves once it is running, beyond its return value. Both
 * flags exist because the honest answer is "this control does something you
 * will not see here", and a client that does not know that renders a button
 * that looks broken.
 */
export interface AcpCommandRule {
	name: string;
	/**
	 * Only these subcommands are admitted. Present for the three commands whose
	 * bare form opens an overlay (`/context`, `/tasks`, `/memory`): the verbs are
	 * wire-shaped, the browser they share a name with is not.
	 */
	subcommands?: ReadonlyArray<string>;
	/**
	 * The command dispatches a worker and returns before it finishes. Its result
	 * is "started"; everything interesting arrives as `_clio-coder/event` dispatch
	 * kinds. A client not consuming those sees a control that appears to do
	 * nothing.
	 */
	streams?: "dispatch";
	/**
	 * The command puts operator-authored text into the session as a user turn,
	 * outside any `session/prompt`. A client will observe a turn it never
	 * prompted; that is the contract, not a protocol violation.
	 */
	injectsUserTurn?: true;
}

/**
 * The 13 commands whose whole result is text, plus the verbs of the three
 * hub commands. Everything absent from this list is either TUI-bound (it
 * reaches `keyboardActions`, an overlay, or the editor) or already reachable
 * over ACP by other means, and is refused by name.
 */
export const ACP_COMMAND_RULES: ReadonlyArray<AcpCommandRule> = [
	{ name: "mcp" },
	{ name: "doctor" },
	// `/share` and `/oracle` both end in `submitOperatorNote`.
	{ name: "share", injectsUserTurn: true },
	{ name: "archive" },
	{ name: "run", streams: "dispatch" },
	{ name: "delegate", streams: "dispatch" },
	{ name: "oracle", streams: "dispatch", injectsUserTurn: true },
	{ name: "council", streams: "dispatch" },
	// `/skill <name>` submits the expanded skill as a user turn; `/skill off` does not.
	{ name: "skill", injectsUserTurn: true },
	{ name: "context", subcommands: ["compact", "recall", "init", "refresh", "reset"] },
	// `/tasks hand` submits the handoff text as a user turn; add/done/drop do not.
	{ name: "tasks", subcommands: ["add", "hand", "done", "drop"], injectsUserTurn: true },
	{ name: "memory", subcommands: ["seed"] },
	{ name: "export" },
];

/** Host capabilities required by each advertised operation. Grammar stays in the slash registry. */
const COMMAND_REQUIREMENTS: Record<string, ReadonlyArray<keyof AcpCommandHost>> = {
	doctor: ["runDoctor"],
	share: ["listWorkerRuns", "submitOperatorNote"],
	archive: ["exportShareArchive", "importShareArchive"],
	oracle: ["oracleBriefing", "submitOperatorNote"],
	council: ["runCouncilDispatch", "getWorkerRosters"],
	skill: ["submitTurn", "parsePendingSkillRequests", "clearSkillSurface"],
	tasks: ["userTasks", "submitTurn"],
	memory: ["seedTaskMemory"],
	export: ["exportTranscript"],
};
const CONTEXT_REQUIREMENTS: Record<string, keyof AcpCommandHost> = {
	compact: "runCompact",
	recall: "runContextRecall",
	init: "runInit",
	refresh: "runContextRefresh",
	reset: "runContextClear",
};
function availableRules(host?: AcpCommandHost): ReadonlyArray<AcpCommandRule> {
	if (!host) return ACP_COMMAND_RULES;
	return ACP_COMMAND_RULES.flatMap((rule) => {
		if (!(COMMAND_REQUIREMENTS[rule.name] ?? []).every((key) => host[key] !== undefined)) return [];
		if (rule.name !== "context") return [rule];
		const subcommands =
			rule.subcommands?.filter(
				(name) => CONTEXT_REQUIREMENTS[name] !== undefined && host[CONTEXT_REQUIREMENTS[name]] !== undefined,
			) ?? [];
		return subcommands.length ? [{ ...rule, subcommands }] : [];
	});
}

const RULE_BY_NAME = new Map(ACP_COMMAND_RULES.map((rule) => [rule.name, rule]));

/** A registry name in the allowlist that the registry does not own is a build mistake, not a runtime one. */
for (const rule of ACP_COMMAND_RULES) {
	if (!BUILTIN_SLASH_COMMANDS.some((entry) => entry.name === rule.name)) {
		throw new Error(`ACP_COMMAND_RULES: "${rule.name}" is not a registered slash command`);
	}
}

export const ACP_COMMANDS_CAPABILITY = {
	version: 1,
	list: ACP_COMMANDS_LIST_METHOD,
	invoke: ACP_COMMANDS_INVOKE_METHOD,
	count: ACP_COMMAND_RULES.length,
} as const;

/* -------------------------------------------------------------------------- */
/* Catalog projection                                                          */
/* -------------------------------------------------------------------------- */

export interface AcpCommandFlagSpec {
	name: string;
	takesValue?: boolean;
	repeatable?: boolean;
	values?: string[];
	valueName?: string;
	completionSlot?: string;
}

export interface AcpCommandPositionalSpec {
	name: string;
	required: boolean;
	values?: string[];
	rest?: boolean;
	completionSlot?: string;
}

export interface AcpCommandArgsSpec {
	flags?: AcpCommandFlagSpec[];
	positionals?: AcpCommandPositionalSpec[];
	subcommands?: Record<string, AcpCommandArgsSpec>;
}

export interface AcpCommandDescriptor {
	name: string;
	summary: string;
	/** The registry's own usage line, already rendered from the grammar below. */
	usage: string;
	group: string;
	args: AcpCommandArgsSpec;
	subcommandSummaries?: Record<string, string>;
	/** The bare command is refused; only the projected subcommands are admitted. */
	requiresSubcommand?: true;
	streams?: "dispatch";
	injectsUserTurn?: true;
}

export interface AcpCommandCatalog {
	version: 1;
	commands: AcpCommandDescriptor[];
}

function projectValues(values: ReadonlyArray<string> | undefined): string[] | undefined {
	if (values === undefined || values.length === 0) return undefined;
	return values.slice(0, ACP_MAX_COMMAND_VALUES).map((value) => bounded(value, ACP_MAX_COMMAND_NAME_BYTES));
}

function projectFlag(flag: CommandFlagSpec): AcpCommandFlagSpec {
	const values = projectValues(flag.values);
	return {
		name: bounded(flag.name, ACP_MAX_COMMAND_NAME_BYTES),
		...(flag.takesValue === true ? { takesValue: true } : {}),
		...(flag.repeatable === true ? { repeatable: true } : {}),
		...(values ? { values } : {}),
		...(flag.valueName !== undefined ? { valueName: bounded(flag.valueName, ACP_MAX_COMMAND_NAME_BYTES) } : {}),
		...(flag.completionSlot !== undefined ? { completionSlot: flag.completionSlot } : {}),
	};
}

function projectPositional(positional: CommandPositionalSpec): AcpCommandPositionalSpec {
	const values = projectValues(positional.values);
	return {
		name: bounded(positional.name, ACP_MAX_COMMAND_NAME_BYTES),
		required: positional.required,
		...(values ? { values } : {}),
		...(positional.rest === true ? { rest: true } : {}),
		...(positional.completionSlot !== undefined ? { completionSlot: positional.completionSlot } : {}),
	};
}

/**
 * The grammar, minus the two parser-internal switches. `parseFlagsBeforeRest`
 * and `parseFlagsInRest` describe how this process tokenizes a line, and a
 * client that never builds the line has no use for them; `invokeAcpCommand`
 * takes argv and does the joining itself.
 *
 * `admitted` narrows the subcommand map to the verbs the allowlist exposes, so
 * a palette built from this projection cannot offer a control the server will
 * refuse.
 */
function projectArgs(spec: CommandArgsSpec | undefined, admitted?: ReadonlyArray<string>): AcpCommandArgsSpec {
	if (spec === undefined) return {};
	const flags = (spec.flags ?? []).slice(0, ACP_MAX_COMMAND_FLAGS).map(projectFlag);
	const positionals = (spec.positionals ?? []).slice(0, ACP_MAX_COMMAND_POSITIONALS).map(projectPositional);
	const subcommandEntries = Object.entries(spec.subcommands ?? {})
		.filter(([name]) => admitted === undefined || admitted.includes(name))
		.slice(0, ACP_MAX_COMMAND_SUBCOMMANDS);
	const subcommands: Record<string, AcpCommandArgsSpec> = {};
	for (const [name, sub] of subcommandEntries) {
		subcommands[bounded(name, ACP_MAX_COMMAND_NAME_BYTES)] = projectArgs(sub);
	}
	return {
		...(flags.length > 0 ? { flags } : {}),
		...(positionals.length > 0 ? { positionals } : {}),
		...(subcommandEntries.length > 0 ? { subcommands } : {}),
	};
}

/**
 * The catalog a GUI palette builds its argument UI from. It is derived from
 * `commandReference()` rather than from a second table, because a hand-written
 * copy of 13 grammars drifts on the first flag anyone adds.
 */
export function acpCommandCatalog(host?: AcpCommandHost): AcpCommandCatalog {
	const reference = new Map(commandReference().map((entry) => [entry.name, entry]));
	const commands: AcpCommandDescriptor[] = [];
	for (const rule of availableRules(host)) {
		const entry = reference.get(rule.name);
		if (entry === undefined) continue;
		const summaries: Record<string, string> = {};
		for (const [name, text] of Object.entries(entry.subcommandDescriptions ?? {})) {
			if (rule.subcommands !== undefined && !rule.subcommands.includes(name)) continue;
			summaries[bounded(name, ACP_MAX_COMMAND_NAME_BYTES)] = bounded(text, ACP_MAX_COMMAND_TEXT_BYTES);
		}
		commands.push({
			name: bounded(entry.name, ACP_MAX_COMMAND_NAME_BYTES),
			summary: bounded(entry.description, ACP_MAX_COMMAND_TEXT_BYTES),
			usage: bounded(
				rule.subcommands ? `/${entry.name} <${rule.subcommands.join("|")}> …` : entry.usage,
				ACP_MAX_COMMAND_TEXT_BYTES,
			),
			group: entry.group,
			args: projectArgs(entry.args, rule.subcommands),
			...(Object.keys(summaries).length > 0 ? { subcommandSummaries: summaries } : {}),
			...(rule.subcommands !== undefined ? { requiresSubcommand: true as const } : {}),
			...(rule.streams !== undefined ? { streams: rule.streams } : {}),
			...(rule.injectsUserTurn === true ? { injectsUserTurn: true as const } : {}),
		});
	}
	return { version: 1, commands };
}

/* -------------------------------------------------------------------------- */
/* Headless invocation                                                         */
/* -------------------------------------------------------------------------- */

/**
 * What this process must supply for an allowlisted command to do its work.
 *
 * Three members are required because the composition root always has them and
 * four commands dispatch through them. Everything else is optional in exactly
 * the way `SlashCommandContext` already declares it optional: an absent member
 * omits its command from the bound ACP catalog and refuses wire invocation.
 * Direct slash dispatch retains the TUI-style not-wired diagnostic. The TUI-only members (`echoOperatorCommand`, `showReference`,
 * `showDoctor`, `render`) are deliberately never supplied; each has a
 * documented non-TUI fallback in the registry.
 */
export type AcpCommandHost = Pick<SlashCommandContext, "dispatch" | "bus" | "providers"> &
	Partial<
		Pick<
			SlashCommandContext,
			| "clearSkillSurface"
			| "exportShareArchive"
			| "exportTranscript"
			| "getAgentRoleFacts"
			| "getDecisionBoard"
			| "importShareArchive"
			| "isTurnInFlight"
			| "listWorkerRuns"
			| "oracleBriefing"
			| "getWorkerRosters"
			| "runCompact"
			| "runContextClear"
			| "runContextRecall"
			| "runContextRefresh"
			| "runCouncilDispatch"
			| "runDoctor"
			| "runInit"
			| "runLocalOperation"
			| "seedTaskMemory"
			| "submitOperatorNote"
			| "userTasks"
		>
	> & {
		cwd?: string;
		/**
		 * Submit a user turn. `pendingSkillRequests` arrives already expanded, so
		 * this is `chat.submit(text, {pendingSkillRequests})` and nothing more.
		 */
		submitTurn?: (text: string, options: { pendingSkillRequests?: ReadonlyArray<PendingSkillRequest> }) => void;
		/**
		 * `resources.parsePendingSkillRequests`. Skill expansion happens here, in
		 * the caller of submit, exactly as `interactive-slash-runtime.ts` does it:
		 * `chat.submit` does not expand, so without this an ACP client sending
		 * `/skill foo` would put the literal five-character command into the
		 * model's context as prose.
		 */
		parsePendingSkillRequests?: (
			text: string,
			cwd?: string,
		) => { text: string; pendingSkillRequests: PendingSkillRequest[] };
	};

export interface AcpCommandResult {
	level: NoticeLevel;
	lines: string[];
}

/** A result's level is the loudest notice the command emitted, so the levels need an order. */
const NOTICE_LEVELS: ReadonlyArray<NoticeLevel> = ["info", "success", "warn", "error"];

/** A handler that reaches one of these was dispatched by mistake; failing loudly beats handing it undefined. */
function unreachable(member: string): never {
	throw new Error(`acp commands: ${member} is not reachable from an allowlisted command`);
}

/** Every refusal on this surface is the client's mistake, so they all carry one shape. */
function invalid(reason: string, message: string): AcpRequestError {
	return new AcpRequestError(-32602, message, { code: "invalid_params", reason });
}

/**
 * Rebuild the command line the registry parses.
 *
 * Nothing is quoted. A rest positional is taken verbatim to end of line
 * (`slash-spec.ts:305`), so a quoted task would arrive with its quotes inside
 * the task text, and a client cannot know from the catalog which of its
 * arguments lands in a rest slot. The tokenizer's own metacharacters are
 * therefore refused rather than escaped, and whitespace is admitted only in the
 * final element, which is the one that can be rest text.
 */
function joinArgv(command: string, argv: ReadonlyArray<string>): string {
	if (argv.length > ACP_MAX_COMMAND_ARGV) throw invalid("argv_too_long", "too many command arguments");
	for (const [index, value] of argv.entries()) {
		if (typeof value !== "string") throw invalid("argv_invalid", "command arguments must be strings");
		if (Buffer.byteLength(value, "utf8") > ACP_MAX_COMMAND_ARGV_BYTES) {
			throw invalid("argv_too_long", "a command argument is too long");
		}
		// biome-ignore lint/suspicious/noControlCharactersInRegex: a control character in a command line is the refusal.
		if (/[\u0000-\u001f\u007f"']/u.test(value)) {
			throw invalid("argv_invalid", "a command argument contains a quote or control character");
		}
		if (index < argv.length - 1 && /\s/u.test(value)) {
			throw invalid("argv_invalid", "only the last command argument may contain whitespace");
		}
	}
	return argv.length === 0 ? `/${command}` : `/${command} ${argv.join(" ")}`;
}

/** The parse must land on a kind the allowlisted entry itself declares, or on that entry's usage error. */
function parsedBelongsTo(parsed: SlashCommand, name: string, kinds: ReadonlyArray<SlashCommandKind>): boolean {
	if (parsed.kind === "usage-error") return parsed.command === name;
	return kinds.includes(parsed.kind);
}

/**
 * Run one allowlisted command with no TUI behind it.
 *
 * Doctor completes before replying. Dispatch commands acknowledge admission and
 * keep reporting progress through their existing event stream.
 */
export function invokeAcpCommand(
	request: { command: unknown; argv: unknown },
	host: AcpCommandHost,
): Promise<AcpCommandResult> {
	if (typeof request.command !== "string") throw invalid("invalid_params", "command must be a string");
	const rule = RULE_BY_NAME.get(request.command);
	if (rule === undefined) throw invalid("command_not_exposed", "command is not exposed over ACP");
	const entry = BUILTIN_SLASH_COMMANDS.find((candidate) => candidate.name === rule.name);
	if (entry === undefined) throw invalid("command_not_exposed", "command is not exposed over ACP");

	const argv: string[] = [];
	if (request.argv !== undefined) {
		if (!Array.isArray(request.argv)) throw invalid("argv_invalid", "argv must be an array of strings");
		for (const value of request.argv) argv.push(value as string);
	}
	if (rule.subcommands !== undefined && !rule.subcommands.includes(argv[0] ?? "")) {
		throw invalid("subcommand_not_exposed", "this command is exposed only through its subcommands");
	}
	// The registry submits `/skill <name>` as chat text and expects the caller to
	// have expanded it first. Without the expander the model would receive the
	// command line as prose, which reads like an answer and is not one.
	// `off` is the reserved name only when it stands alone; `/skill off x` invokes
	// a skill called `off` and still submits.
	const clearsSkillSurface = argv.length === 1 && argv[0] === "off";
	if (rule.name === "skill" && !clearsSkillSurface && host.parsePendingSkillRequests === undefined) {
		throw invalid("not_wired", "skill expansion is not wired in this session");
	}

	const line = joinArgv(rule.name, argv);
	const parsed = parseSlashCommand(line);
	if (!parsedBelongsTo(parsed, rule.name, entry.kinds)) {
		throw invalid("command_not_exposed", "command is not exposed over ACP");
	}

	const lines: string[] = [];
	let rank = 0;
	let truncated = false;
	const push = (text: string): void => {
		for (const raw of text.replace(/\r/gu, "").split("\n")) {
			const trimmed = raw.trimEnd();
			if (trimmed.length === 0) continue;
			if (lines.length >= ACP_MAX_COMMAND_RESULT_LINES) {
				truncated = true;
				return;
			}
			lines.push(bounded(trimmed, ACP_MAX_COMMAND_RESULT_LINE_BYTES));
		}
	};
	const notice = (next: NoticeLevel, text: string): void => {
		rank = Math.max(rank, NOTICE_LEVELS.indexOf(next));
		push(text);
	};

	const finish = (): AcpCommandResult => {
		if (truncated) lines.push(`…output truncated at ${ACP_MAX_COMMAND_RESULT_LINES} lines`);
		return { level: NOTICE_LEVELS[rank] ?? "info", lines };
	};
	const runDoctor = host.runDoctor;
	if (parsed.kind === "doctor" && runDoctor) {
		return Promise.resolve()
			.then(() => runDoctor({ deep: parsed.deep }))
			.then(
				(report) => {
					notice(report.level, report.text);
					return finish();
				},
				(error: unknown) => {
					notice("error", `doctor failed: ${error instanceof Error ? error.message : String(error)}`);
					return finish();
				},
			);
	}
	const ctx = headlessContext(host, notice, push);
	const outcome = dispatchSlashCommand(parsed, ctx);
	if (outcome === "rejected") rank = NOTICE_LEVELS.length - 1;
	// A dispatch command returns before its worker produces anything, and a
	// silent success would read as a control that did nothing.
	if (rule.streams === "dispatch" && lines.length === 0 && outcome === "accepted") {
		push(`${rule.name} started; progress arrives as _clio-coder/event dispatch kinds`);
	}
	return Promise.resolve(finish());
}

/**
 * A `SlashCommandContext` with no terminal behind it.
 *
 * `echoOperatorCommand`, `showReference` and `showDoctor` are left undefined on
 * purpose: each is optional precisely so a host without a chat panel can omit
 * it, and the registry falls back to `io.stdout` or to nothing. `render` is a
 * required member rather than an optional one, so it is a no-op here: there is
 * no frame to schedule. The members below that call `unreachable` belong to
 * commands the allowlist does not expose; they are typed as required by the
 * context, not reachable by any line this module will build.
 */
function headlessContext(
	host: AcpCommandHost,
	notice: (level: NoticeLevel, text: string) => void,
	push: (text: string) => void,
): SlashCommandContext {
	const submitTurn = host.submitTurn;
	return {
		io: { stdout: push, stderr: push },
		notice,
		dispatch: host.dispatch,
		bus: host.bus,
		providers: host.providers,
		...(host.getDecisionBoard ? { getDecisionBoard: host.getDecisionBoard } : {}),
		...(host.getAgentRoleFacts ? { getAgentRoleFacts: host.getAgentRoleFacts } : {}),
		...(host.submitOperatorNote ? { submitOperatorNote: host.submitOperatorNote } : {}),
		...(host.listWorkerRuns ? { listWorkerRuns: host.listWorkerRuns } : {}),
		...(host.exportShareArchive ? { exportShareArchive: host.exportShareArchive } : {}),
		...(host.importShareArchive ? { importShareArchive: host.importShareArchive } : {}),
		...(host.runDoctor ? { runDoctor: host.runDoctor } : {}),
		...(host.oracleBriefing ? { oracleBriefing: host.oracleBriefing } : {}),
		...(host.isTurnInFlight ? { isTurnInFlight: host.isTurnInFlight } : {}),
		...(host.getWorkerRosters ? { getWorkerRosters: host.getWorkerRosters } : {}),
		...(host.runCouncilDispatch ? { runCouncilDispatch: host.runCouncilDispatch } : {}),
		...(host.runContextRecall ? { runContextRecall: host.runContextRecall } : {}),
		...(host.runContextRefresh ? { runContextRefresh: host.runContextRefresh } : {}),
		...(host.runLocalOperation ? { runLocalOperation: host.runLocalOperation } : {}),
		...(host.clearSkillSurface ? { clearSkillSurface: host.clearSkillSurface } : {}),
		...(host.seedTaskMemory ? { seedTaskMemory: host.seedTaskMemory } : {}),
		...(host.userTasks ? { userTasks: host.userTasks } : {}),
		runInit: (options) => {
			if (!host.runInit) {
				notice("error", "context init is not wired in this session");
				return;
			}
			host.runInit(options);
		},
		runContextClear: (options) => {
			if (!host.runContextClear) {
				notice("error", "context reset is not wired in this session");
				return;
			}
			host.runContextClear(options);
		},
		runCompact: (instructions) => {
			if (!host.runCompact) {
				notice("error", "context compact is not wired in this session");
				return;
			}
			host.runCompact(instructions);
		},
		exportTranscript: (path) => {
			if (!host.exportTranscript) {
				notice("error", "export is not wired in this session; no session is bound to this process");
				return;
			}
			host.exportTranscript(path);
		},
		submitChat: (text) => {
			if (!submitTurn) {
				notice("error", "this command submits a user turn, and no chat loop is bound to this process");
				return;
			}
			const expansion = host.parsePendingSkillRequests?.(text, host.cwd);
			if (expansion === undefined) {
				submitTurn(text, {});
				return;
			}
			submitTurn(
				expansion.text,
				expansion.pendingSkillRequests.length > 0 ? { pendingSkillRequests: expansion.pendingSkillRequests } : {},
			);
		},
		render: () => {},
		listPrompts: () => unreachable("listPrompts"),
		listAgents: () => unreachable("listAgents"),
		listDelegationAgents: () => unreachable("listDelegationAgents"),
		shutdown: () => unreachable("shutdown"),
		openUsage: () => unreachable("openUsage"),
		openSideQuestion: () => unreachable("openSideQuestion"),
		openDraft: () => unreachable("openDraft"),
		startHandoff: () => unreachable("startHandoff"),
		openContextView: () => unreachable("openContextView"),
		openTasks: () => unreachable("openTasks"),
		openDecisions: () => unreachable("openDecisions"),
		openMemory: () => unreachable("openMemory"),
		openView: () => unreachable("openView"),
		openModel: () => unreachable("openModel"),
		applyModelRef: () => unreachable("applyModelRef"),
		openSettings: () => unreachable("openSettings"),
		openResume: () => unreachable("openResume"),
		startNewSession: () => unreachable("startNewSession"),
		openTree: () => unreachable("openTree"),
		openMessagePicker: () => unreachable("openMessagePicker"),
		openHelp: () => unreachable("openHelp"),
		openExtensions: () => unreachable("openExtensions"),
		verifyReceipt: () => unreachable("verifyReceipt"),
	};
}

/* -------------------------------------------------------------------------- */
/* Control surface                                                             */
/* -------------------------------------------------------------------------- */

/**
 * What `src/engine/acp/server.ts` is handed instead of this module.
 *
 * The server is a declared Stage 0 seam and the instant shell's chunk budget is
 * measured on its closure (rule6, tests/boundaries/check-boundaries.ts). This
 * module value-imports the whole slash registry, so a direct import would drag
 * the registry into that budget. The composition root already reaches the
 * registry, so it builds the control; the server never learns that a slash
 * command exists.
 */
export interface AcpCommandControl {
	/** Pure and rebuilt per call, so the server memoizes it for a polling client. */
	catalog(): AcpCommandCatalog;
	/** Refusals throw {@link AcpRequestError} with the reason already attached. */
	invoke(request: { command: unknown; argv: unknown }): AcpCommandResult | Promise<AcpCommandResult>;
	/** True when this command name submits a user turn, which a live prompt owns. */
	injectsUserTurn(command: unknown): boolean;
	/** Announced verbatim under `clio-coder/commands`. */
	capability: Readonly<Record<string, unknown>>;
}

/** Binds one host to the control the ACP server takes. */
export function acpCommandControl(host: AcpCommandHost): AcpCommandControl {
	return {
		catalog: () => acpCommandCatalog(host),
		invoke: (request) => {
			const rule = availableRules(host).find((entry) => entry.name === request.command);
			if (!rule) throw invalid("command_unavailable", "command is not available in this host");
			if (rule.subcommands && (!Array.isArray(request.argv) || !rule.subcommands.includes(request.argv[0])))
				throw invalid("subcommand_not_exposed", "subcommand is not available in this host");
			return invokeAcpCommand(request, host);
		},
		injectsUserTurn: (command) => typeof command === "string" && RULE_BY_NAME.get(command)?.injectsUserTurn === true,
		capability: { ...ACP_COMMANDS_CAPABILITY, count: availableRules(host).length },
	};
}
