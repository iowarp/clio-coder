import type { DelegationToolGovernance } from "../../core/defaults.js";
import { AcpAuthRequiredError, AcpProtocolError } from "./errors.js";
import { boundAcpSessionUpdate, routeNonJsonRpcStdout, type StdioTransportOptions } from "./transport.js";
import type { AcpInitializeResponse, AcpRequestPermissionResponse } from "./types.js";

type Version = readonly [number, number, number];

/** Oldest `agy` CLIO Coder drives over ACP (maintainer ruling); older builds are refused with an upgrade message. */
const MIN_VERSION: Version = [1, 5, 1];
/** From 1.5.0 a second `session/prompt` steers the running turn; `session/cancel` would also stop its subagents. */
const PROMPT_STEERING_SINCE: Version = [1, 5, 0];
const DEFAULT_MODE = "default";
/** A permission request with this tool call id prefix is agy asking the user a fixed-choice question. */
const QUESTION_ID_PREFIX = "interaction_";
const SECURITY_WARNING_KEY = "agy.security.warning";
const PROFILE_FLAGS = new Set(["--gemini-dir", "--gemini_dir", "--app-data-dir", "--app_data_dir"]);
/** agy's own JSON-RPC code and text for a session request made before sign-in (probed on 1.5.13). */
const AUTH_REQUIRED_CODE = -32000;
const AUTH_REQUIRED_TEXT = /\bauthentication required\b/iu;
const MAX_QUESTION_CHARS = 2_000;
const MAX_CHOICES = 16;
const MAX_CHOICE_CHARS = 200;
const MAX_WARNING_CHARS = 1_000;

/** A fixed-choice question agy put to the user through `session/request_permission`, bounded for the run feed. */
export interface AntigravityQuestion {
	questionId: string;
	question: string;
	choices: string[];
	securityWarning?: string;
	/** A delegation has no operator to choose, so the question is answered cancelled. */
	answer: "cancelled";
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
	/** `session/set_mode` params that return agy to `default` while Clio mediates, or null when nothing changes. */
	defaultMode(sessionId: string, session: unknown): { sessionId: string; modeId: string } | null;
	/** The typed sign-in failure for agy's `Authentication required`, or the error unchanged. */
	authFailure(error: unknown): unknown;
	/** Whether a mid-turn steer goes out as another `session/prompt`. */
	steersByPrompt(): boolean;
	/** The question a `session/request_permission` carries, or null when it is a tool approval. */
	question(params: unknown): AntigravityQuestion | null;
	/** The answer to a question: no choice is made on the operator's behalf. */
	questionResponse(): AcpRequestPermissionResponse;
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

function bounded(text: string, chars: number): string {
	const collapsed = text.replace(/\s+/gu, " ").trim();
	return collapsed.length <= chars ? collapsed : `${collapsed.slice(0, chars - 1)}…`;
}

function shellWord(word: string): string {
	return /^[\w@%+=:,./~-]+$/u.test(word) ? word : `'${word.replace(/'/gu, `'\\''`)}'`;
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
			const modes = isRecord(session) && isRecord(session.modes) ? session.modes : null;
			const current = modes?.currentModeId;
			if (typeof current !== "string" || current === DEFAULT_MODE) return null;
			const available = Array.isArray(modes?.availableModes) ? modes.availableModes : [];
			if (!available.some((mode) => isRecord(mode) && mode.id === DEFAULT_MODE)) {
				throw new Error(
					`Antigravity session started in mode '${bounded(current, 64)}' and offers no '${DEFAULT_MODE}' mode, so CLIO Coder cannot mediate its tool calls`,
				);
			}
			return { sessionId, modeId: DEFAULT_MODE };
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
			if (typeof id !== "string" || !id.startsWith(QUESTION_ID_PREFIX)) return null;
			const options = Array.isArray(params.options) ? params.options : [];
			const choices = options
				.slice(0, MAX_CHOICES)
				.map((option) => (isRecord(option) ? (typeof option.name === "string" ? option.name : option.optionId) : undefined))
				.filter((choice): choice is string => typeof choice === "string")
				.map((choice) => bounded(choice, MAX_CHOICE_CHARS));
			const title = typeof toolCall.title === "string" ? toolCall.title : "";
			const warning = securityWarning(options);
			return {
				questionId: bounded(id, 128),
				question: title.trim().length > 0 ? bounded(title, MAX_QUESTION_CHARS) : "(no question text)",
				choices,
				...(warning !== undefined ? { securityWarning: warning } : {}),
				answer: "cancelled",
			};
		},
		questionResponse: () => ({ outcome: { outcome: "cancelled" } }),
	};
}
