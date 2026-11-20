import type { DelegationToolGovernance } from "../../core/defaults.js";
import { AcpAuthRequiredError, AcpProtocolError } from "./errors.js";
import { boundAcpSessionUpdate, routeNonJsonRpcStdout, type StdioTransportOptions } from "./transport.js";
import type { AcpInitializeResponse, AcpPromptResponse, AcpRequestPermissionResponse } from "./types.js";

type Version = readonly [number, number, number];

/** Oldest `agy` CLIO Coder drives over ACP (maintainer ruling); older builds are refused with an upgrade message. */
const MIN_VERSION: Version = [1, 5, 1];
/** From 1.5.0 a second `session/prompt` steers the running turn; `session/cancel` would also stop its subagents. */
const PROMPT_STEERING_SINCE: Version = [1, 5, 0];
const DEFAULT_MODE = "default";
/** A permission request with this tool call id prefix is agy asking the user a fixed-choice question. */
const QUESTION_ID_PREFIX = "interaction_";
const SECURITY_WARNING_KEY = "agy.security.warning";
/** ACP tool kinds: an `interaction_*` request of one of these kinds is a tool call, mediated like any other. */
const TOOL_KINDS = new Set(["execute", "edit", "delete", "move", "fetch", "read", "search"]);
/** `rawInput` keys AcpToolMediator maps to a tool whatever the kind: a tool name, command, path, URL or pattern. */
const RAW_TOOL_KEYS = [
	"command",
	"cmd",
	"shell",
	"tool",
	"toolName",
	"tool_name",
	"name",
	"path",
	"file_path",
	"filePath",
	"notebook_path",
	"url",
	"pattern",
];
const PROFILE_FLAGS = new Set(["--gemini-dir", "--gemini_dir", "--app-data-dir", "--app_data_dir"]);
/** agy's own JSON-RPC code and text for a session request made before sign-in (probed on 1.5.13). */
const AUTH_REQUIRED_CODE = -32000;
const AUTH_REQUIRED_TEXT = /\bauthentication required\b/iu;
const MAX_QUESTION_CHARS = 2_000;
const MAX_CHOICES = 16;
const MAX_CHOICE_CHARS = 200;
const MAX_WARNING_CHARS = 1_000;
/** ACP kinds whose targets AcpToolMediator reads from `locations` and `rawInput`, so a named agy tool of one passes on. */
const MEDIATED_KINDS = new Set(["edit", "delete", "move", "fetch", "read", "search"]);

/** The request that returns agy to `default`: the stable session mode, or a `mode` session config option. */
export type AntigravityModeReset =
	| { method: "session/set_mode"; params: { sessionId: string; modeId: string } }
	| { method: "session/set_config_option"; params: { sessionId: string; configId: string; value: string } };

/** A fixed-choice question agy put to the user through `session/request_permission`, bounded for the run feed. */
export interface AntigravityQuestion {
	questionId: string;
	question: string;
	choices: string[];
	/** The choices an operator may pick, each with the `optionId` agy takes back. */
	options: Array<{ optionId: string; label: string }>;
	securityWarning?: string;
}

export interface AntigravityShims {
	/** Explicit, not omitted: agy drops its native diff edits when the client claims `fs.writeTextFile`. */
	readonly clientCapabilities: Record<string, unknown>;
	readonly transportHooks: Required<Pick<StdioTransportOptions, "transformStdout" | "transformSessionUpdate">>;
	/** Throws unless the peer reports a version at or above 1.5.1; records what it advertised. */
	admit(init: AcpInitializeResponse): void;
	/** `session/new` params; the system prompt rides `_meta` when agy advertises the append capability. */
	sessionNew(
		cwd: string,
		systemPrompt: string | undefined,
	): { params: Record<string, unknown>; systemPromptSent: boolean };
	/**
	 * The request that returns agy to `default` while Clio mediates, or null when nothing changes. Throws when the
	 * session reports no mode at all, or no `default` one, under a governance that needs agy to ask.
	 */
	defaultMode(sessionId: string, session: unknown): AntigravityModeReset | null;
	/** Throws when a `session/set_config_option` answer still shows a mode other than `default`. */
	confirmMode(response: unknown): void;
	/**
	 * One result for a turn that took steer prompts, from its responses in the order they settled: the last one,
	 * except that a stop reason other than `end_turn` (or a missing one) is never hidden by a later `end_turn`, and
	 * usage is the sum of every response's counts.
	 */
	settleTurn(settled: ReadonlyArray<AcpPromptResponse>): AcpPromptResponse;
	/** The typed sign-in failure for agy's `Authentication required`, or the error unchanged. */
	authFailure(error: unknown): unknown;
	/** Whether a mid-turn steer goes out as another `session/prompt`. */
	steersByPrompt(): boolean;
	/** The question a `session/request_permission` carries, or null when it is a tool approval. */
	question(params: unknown): AntigravityQuestion | null;
	/** The answer to a question: the operator's offered choice, else cancelled; no choice is made on their behalf. */
	questionResponse(question: AntigravityQuestion, optionId: string | null): AcpRequestPermissionResponse;
	/**
	 * A tool approval with agy's own tool shape rewritten into one AcpToolMediator judges (probed on 1.5.13):
	 * `run_command` becomes the shell command it runs, `run_workflow` the inline script it runs, a named tool of a
	 * mediated kind passes on, and any other named tool becomes an unknown tool named `agy:<name>`, which the
	 * mediator denies. A request without a tool name is returned unchanged.
	 */
	toolRequest(params: unknown): unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `major.minor.patch` with any prerelease or build suffix ignored; null when the text is not a version. */
function parseVersion(value: unknown): Version | null {
	if (typeof value !== "string") return null;
	const match = /^v?(\d+)\.(\d+)\.(\d+)/u.exec(value.trim());
	if (match === null) return null;
	return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function atLeast(version: Version, floor: Version): boolean {
	for (let index = 0; index < 3; index++) {
		const left = version[index] ?? 0;
		const right = floor[index] ?? 0;
		if (left !== right) return left > right;
	}
	return true;
}

interface ModeOption {
	id: string;
	current: string | null;
	values: string[];
}

/** The `select` session config option in category `mode`, its values flattened out of any groups. */
function modeOption(configOptions: unknown): ModeOption | null {
	if (!Array.isArray(configOptions)) return null;
	for (const option of configOptions) {
		if (!isRecord(option) || option.category !== "mode" || option.type !== "select") continue;
		if (typeof option.id !== "string" || option.id.length === 0) continue;
		const values: string[] = [];
		for (const entry of Array.isArray(option.options) ? option.options : []) {
			if (!isRecord(entry)) continue;
			if (typeof entry.value === "string") values.push(entry.value);
			for (const grouped of Array.isArray(entry.options) ? entry.options : []) {
				if (isRecord(grouped) && typeof grouped.value === "string") values.push(grouped.value);
			}
		}
		return { id: option.id, current: typeof option.currentValue === "string" ? option.currentValue : null, values };
	}
	return null;
}

/** Per-key sums of the numeric counts in each usage record; `estimated` holds when any record says so. */
function summedUsage(records: ReadonlyArray<unknown>): Record<string, unknown> | undefined {
	const sum: Record<string, unknown> = {};
	let any = false;
	for (const record of records) {
		if (!isRecord(record)) continue;
		any = true;
		for (const [key, value] of Object.entries(record)) {
			if (typeof value === "number" && Number.isFinite(value)) {
				const prior = sum[key];
				sum[key] = (typeof prior === "number" ? prior : 0) + value;
			} else if (key === "estimated" && value === true) sum.estimated = true;
		}
	}
	return any ? sum : undefined;
}

/**
 * A permission request shaped like a tool call: a tool kind, file locations, or a `rawInput` key the mediator maps
 * to a tool. Ambiguous requests count as tools, so they are mediated rather than answered as questions.
 */
function hasToolShape(toolCall: Record<string, unknown>): boolean {
	const kind = typeof toolCall.kind === "string" ? toolCall.kind.toLowerCase() : "";
	if (TOOL_KINDS.has(kind)) return true;
	const locations = toolCall.locations;
	if (locations !== undefined && locations !== null && (!Array.isArray(locations) || locations.length > 0)) return true;
	const raw = toolCall.rawInput;
	return isRecord(raw) && RAW_TOOL_KEYS.some((key) => Object.hasOwn(raw, key));
}

function bounded(text: string, chars: number): string {
	const collapsed = text.replace(/\s+/gu, " ").trim();
	return collapsed.length <= chars ? collapsed : `${collapsed.slice(0, chars - 1)}…`;
}

function shellWord(word: string): string {
	return /^[\w@%+=:,./~-]+$/u.test(word) ? word : `'${word.replace(/'/gu, `'\\''`)}'`;
}

function rawText(raw: Record<string, unknown>, ...keys: string[]): string | undefined {
	for (const key of keys) {
		const value = raw[key];
		if (typeof value === "string" && value.trim().length > 0) return value;
	}
	return undefined;
}

/**
 * The shell command an agy tool call runs, or undefined when it cannot say: `run_command`'s command line, entered from
 * its own working directory when it names one, and `run_workflow`'s script as inline Python, which the policy never
 * reads as a plain read (always single-quoted, so the script stays one word).
 */
function agyCommand(name: string, raw: Record<string, unknown>): string | undefined {
	if (name === "run_command") {
		const command = rawText(raw, "CommandLine", "commandLine", "command");
		if (command === undefined) return undefined;
		const dir = rawText(raw, "Cwd", "cwd");
		return dir === undefined ? command : `cd ${shellWord(dir)} && ${command}`;
	}
	if (name === "run_workflow") {
		const script = rawText(raw, "Script", "script");
		return script === undefined ? undefined : `python3 -c '${script.replace(/'/gu, `'\\''`)}'`;
	}
	return undefined;
}

/** See {@link AntigravityShims.toolRequest}. */
function agyToolRequest(params: unknown): unknown {
	if (!isRecord(params) || !isRecord(params.toolCall)) return params;
	const toolCall = params.toolCall;
	const name = typeof toolCall.name === "string" ? toolCall.name.trim() : "";
	if (name.length === 0) return params;
	const kind = typeof toolCall.kind === "string" ? toolCall.kind.toLowerCase() : "";
	const raw = isRecord(toolCall.rawInput) ? toolCall.rawInput : isRecord(toolCall.args) ? toolCall.args : {};
	const command = agyCommand(name, raw);
	if (command === undefined && MEDIATED_KINDS.has(kind) && name !== "run_command" && name !== "run_workflow")
		return params;
	const base = {
		...(toolCall.toolCallId !== undefined ? { toolCallId: toolCall.toolCallId } : {}),
		...(typeof toolCall.title === "string" ? { title: toolCall.title } : {}),
	};
	const normalized =
		command !== undefined
			? { ...base, kind: "execute", rawInput: { command } }
			: { ...base, kind: "other", rawInput: { toolName: `agy:${bounded(name, 64)}` } };
	return { ...params, toolCall: normalized };
}

/** The profile flags of the launch, as given or in `--flag=value` form, with `~` already expanded by the launcher. */
function profileArgs(args: ReadonlyArray<string>): string[] {
	const out: string[] = [];
	for (let index = 0; index < args.length; index++) {
		const arg = args[index] ?? "";
		const flag = arg.split("=", 1)[0] ?? "";
		if (!PROFILE_FLAGS.has(flag)) continue;
		if (arg.includes("=")) out.push(arg);
		else if (index + 1 < args.length) out.push(arg, args[++index] ?? "");
	}
	return out;
}

/** `agy.security.warning` from an option's `_meta`, as a flat key or a nested path. */
function securityWarning(options: ReadonlyArray<unknown>): string | undefined {
	for (const option of options) {
		if (!isRecord(option) || !isRecord(option._meta)) continue;
		const meta = option._meta;
		const nested = isRecord(meta.agy) && isRecord(meta.agy.security) ? meta.agy.security.warning : undefined;
		const warning = meta[SECURITY_WARNING_KEY] ?? nested;
		if (typeof warning === "string" && warning.trim().length > 0) return bounded(warning, MAX_WARNING_CHARS);
	}
	return undefined;
}

/**
 * Antigravity CLI (`agy acp`) shims, applied only to that peer. `command` and `launchArgs` are the resolved launch
 * (profile `~` expanded), so the sign-in hint names the profile this run actually used.
 */
export function createAntigravityShims(input: {
	command: string;
	launchArgs: ReadonlyArray<string>;
	toolGovernance: DelegationToolGovernance;
}): AntigravityShims {
	let appendsSystemPrompt = false;
	let promptSteering = false;
	const profile = profileArgs(input.launchArgs);
	const loginCommand = [input.command, "acp", ...profile, "--login"].map(shellWord).join(" ");
	return {
		clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
		transportHooks: {
			transformStdout: routeNonJsonRpcStdout,
			transformSessionUpdate: (params) => boundAcpSessionUpdate(params),
		},
		admit(init) {
			const found = init.agentInfo?.version;
			const version = parseVersion(found);
			if (version === null || !atLeast(version, MIN_VERSION)) {
				const shown = typeof found === "string" && found.trim().length > 0 ? bounded(found, 64) : "no version";
				throw new Error(
					`Antigravity CLI ${shown} is not supported: CLIO Coder needs agy ${MIN_VERSION.join(".")} or later over ACP; upgrade agy and retry`,
				);
			}
			promptSteering = atLeast(version, PROMPT_STEERING_SINCE);
			const caps = init.agentCapabilities;
			const meta = isRecord(caps) && isRecord(caps._meta) ? caps._meta.antigravity : undefined;
			appendsSystemPrompt = isRecord(meta) && isRecord(meta.systemPrompt) && meta.systemPrompt.append === true;
		},
		sessionNew(cwd, systemPrompt) {
			const params: Record<string, unknown> = { cwd, mcpServers: [] };
			const text = systemPrompt?.trim() ?? "";
			if (!appendsSystemPrompt || text.length === 0) return { params, systemPromptSent: false };
			params._meta = { antigravity: { systemPrompt: { append: text } } };
			return { params, systemPromptSent: true };
		},
		defaultMode(sessionId, session) {
			// agent-managed hands approvals to agy itself; every other governance needs agy to ask, which only
			// the default mode does for edits and commands.
			if (input.toolGovernance === "agent-managed") return null;
			const unmediated = (detail: string): Error =>
				new Error(`Antigravity session ${detail}, so CLIO Coder cannot mediate its tool calls`);
			const modes = isRecord(session) && isRecord(session.modes) ? session.modes : null;
			const current = modes?.currentModeId;
			if (typeof current === "string") {
				if (current === DEFAULT_MODE) return null;
				const available = Array.isArray(modes?.availableModes) ? modes.availableModes : [];
				if (!available.some((mode) => isRecord(mode) && mode.id === DEFAULT_MODE))
					throw unmediated(`started in mode '${bounded(current, 64)}' and offers no '${DEFAULT_MODE}' mode`);
				return { method: "session/set_mode", params: { sessionId, modeId: DEFAULT_MODE } };
			}
			const option = modeOption(isRecord(session) ? session.configOptions : undefined);
			if (option === null) throw unmediated("reported no mode (neither modes nor a mode config option)");
			if (option.current === DEFAULT_MODE) return null;
			if (!option.values.includes(DEFAULT_MODE))
				throw unmediated(`offers no '${DEFAULT_MODE}' value for its mode option '${bounded(option.id, 64)}'`);
			return {
				method: "session/set_config_option",
				params: { sessionId, configId: option.id, value: DEFAULT_MODE },
			};
		},
		confirmMode(response) {
			const option = modeOption(isRecord(response) ? response.configOptions : undefined);
			if (option !== null && option.current !== null && option.current !== DEFAULT_MODE)
				throw new Error(
					`Antigravity kept mode '${bounded(option.current, 64)}' after CLIO Coder selected '${DEFAULT_MODE}', so CLIO Coder cannot mediate its tool calls`,
				);
		},
		settleTurn(responses) {
			// A null or otherwise non-object JSON-RPC result is an answer without a stop reason, not a crash.
			const settled = responses.map((response): AcpPromptResponse => (isRecord(response) ? response : {}));
			const last = settled.at(-1) ?? {};
			const unfinished = settled.filter((response) => response.stopReason !== "end_turn").at(-1);
			const usage = summedUsage(settled.map((response) => response.usage ?? response.tokenUsage));
			const { stopReason: _lastStop, tokenUsage: _lastTokens, ...rest } = last;
			const stopReason = unfinished !== undefined ? unfinished.stopReason : last.stopReason;
			return {
				...rest,
				...(stopReason !== undefined ? { stopReason } : {}),
				...(usage !== undefined ? { usage } : {}),
			};
		},
		authFailure(error) {
			if (!(error instanceof AcpProtocolError) || !isRecord(error.data)) return error;
			const { code, message } = error.data;
			if (code !== AUTH_REQUIRED_CODE || typeof message !== "string" || !AUTH_REQUIRED_TEXT.test(message)) return error;
			return new AcpAuthRequiredError(
				`Antigravity CLI answered Authentication required for this profile; sign in once in a terminal with: ${loginCommand}`,
				loginCommand,
			);
		},
		steersByPrompt: () => promptSteering,
		question(params) {
			if (!isRecord(params) || !isRecord(params.toolCall)) return null;
			const toolCall = params.toolCall;
			const id = toolCall.toolCallId;
			if (typeof id !== "string" || !id.startsWith(QUESTION_ID_PREFIX) || hasToolShape(toolCall)) return null;
			const options = Array.isArray(params.options) ? params.options : [];
			const choices = options
				.slice(0, MAX_CHOICES)
				.map((option) => (isRecord(option) ? (typeof option.name === "string" ? option.name : option.optionId) : undefined))
				.filter((choice): choice is string => typeof choice === "string")
				.map((choice) => bounded(choice, MAX_CHOICE_CHARS));
			const title = typeof toolCall.title === "string" ? toolCall.title : "";
			const warning = securityWarning(options);
			const offered = options
				.slice(0, MAX_CHOICES)
				.filter(
					(option): option is Record<string, unknown> & { optionId: string } =>
						isRecord(option) && typeof option.optionId === "string" && option.optionId.length > 0,
				)
				.map((option) => ({
					optionId: option.optionId,
					label: bounded(
						typeof option.name === "string" && option.name.trim().length > 0 ? option.name : option.optionId,
						MAX_CHOICE_CHARS,
					),
				}));
			return {
				questionId: bounded(id, 128),
				question: title.trim().length > 0 ? bounded(title, MAX_QUESTION_CHARS) : "(no question text)",
				choices,
				options: offered,
				...(warning !== undefined ? { securityWarning: warning } : {}),
			};
		},
		questionResponse: (question, optionId) =>
			optionId !== null && question.options.some((option) => option.optionId === optionId)
				? { outcome: { outcome: "selected", optionId } }
				: { outcome: { outcome: "cancelled" } },
		toolRequest: agyToolRequest,
	};
}
