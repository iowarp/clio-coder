/**
 * User-defined middleware hooks: a conservative, receipted automation surface
 * that extensions and project configuration can declare on top of the existing
 * effect machinery. A hook is one of three closed kinds and nothing else:
 *
 *   - `prompt`  injects one small reminder (an `inject_reminder` effect),
 *   - `effect`  emits one existing closed middleware effect verbatim,
 *   - `command` runs an explicit argv (no shell) under the workspace with a
 *               timeout and bounded output, surfaced as one effect.
 *
 * There is no arbitrary script execution: `command` takes an argv array and is
 * run without a shell, so there is no string to inject into. Hooks never
 * replace the safety policy. They can only add effects (including requesting
 * `block_tool`); the durable safety contract
 * still classifies every tool call independently and a hook cannot grant a
 * permission safety would deny.
 *
 * Loading is best-effort: a malformed hook is rejected with a diagnostic and
 * never aborts a turn. Every hook carries source attribution and a content hash,
 * and every execution emits a receipt.
 */

import { createHash } from "node:crypto";
import { isAbsolute, resolve } from "node:path";
import {
	dialectOutputEffects,
	dialectToolCall,
	isUserHookDialect,
	USER_HOOK_DIALECTS,
	type UserHookDialect,
} from "./hook-dialect.js";
import type { MiddlewareHookRegistration } from "./runtime.js";
import {
	type DeclarableMiddlewareEffect,
	isMiddlewareHook,
	isMiddlewareReminderSeverity,
	MIDDLEWARE_HOOKS,
	type MiddlewareEffect,
	type MiddlewareEffectKind,
	type MiddlewareHook,
	type MiddlewareHookInput,
	type MiddlewareReminderSeverity,
} from "./types.js";
import { validateMiddlewareEffect } from "./validate.js";

/**
 * The effects the orchestrator applies at each event. Anything else a hook
 * returns there is dropped, so a user hook pairing an event with an effect it
 * cannot apply is refused at load rather than recorded as "emitted" and
 * ignored. Tool hooks apply through the registry (block_tool before execution
 * only, annotations on the result, tool choice for the next round) and the
 * protected-artifacts guard absorbs protect_path; turn_start and turn_end
 * apply through turn-middleware.ts; on_compaction is observe-only.
 */
const USER_HOOK_APPLIED_EFFECTS: Readonly<Record<MiddlewareHook, ReadonlyArray<MiddlewareEffectKind>>> = {
	before_tool: ["block_tool", "annotate_tool_result", "require_tool", "lock_tools", "protect_path"],
	after_tool: ["annotate_tool_result", "require_tool", "lock_tools", "protect_path"],
	turn_start: ["inject_reminder", "notify_operator", "require_tool", "lock_tools"],
	turn_end: ["inject_reminder", "request_continuation", "notify_operator"],
	on_compaction: [],
};

/** The effect a hook's output produces; null for a command whose output is discarded. Exit 2 is per event and always applies. */
function producedEffectKind(spec: NormalizedUserHookSpec): MiddlewareEffectKind | null {
	if (spec.kind === "prompt") return "inject_reminder";
	if (spec.kind === "effect") return spec.effect.kind;
	if (spec.as === "none") return null;
	return spec.as === "reminder" ? "inject_reminder" : "annotate_tool_result";
}

function applicabilityIssue(on: MiddlewareHook, spec: NormalizedUserHookSpec): string | null {
	const kind = producedEffectKind(spec);
	if (kind === null || USER_HOOK_APPLIED_EFFECTS[on].includes(kind)) return null;
	const events = MIDDLEWARE_HOOKS.filter((hook) => USER_HOOK_APPLIED_EFFECTS[hook].includes(kind));
	return `${on} cannot apply ${kind}; use ${events.length > 0 ? events.join(", ") : "no event"} for this hook`;
}

export type UserHookKind = "command" | "prompt" | "effect";

/**
 * Where a hook came from, lowest precedence first. A later origin overrides an
 * earlier one on an id collision, mirroring the settings-layering order.
 */
export type UserHookOrigin = "extension" | "user" | "project" | "project.local";

export const USER_HOOK_ORIGIN_ORDER: ReadonlyArray<UserHookOrigin> = ["extension", "user", "project", "project.local"];

/** Default and bounds for a command hook's wall-clock timeout. */
export const USER_HOOK_COMMAND_TIMEOUT_DEFAULT_MS = 2_000;
export const USER_HOOK_COMMAND_TIMEOUT_MIN_MS = 100;
export const USER_HOOK_COMMAND_TIMEOUT_MAX_MS = 5_000;
/** Hard cap on command output captured into an effect, in characters. */
export const USER_HOOK_COMMAND_OUTPUT_MAX_CHARS = 4_000;
/** Cap on a prompt hook's injected message, in characters. */
export const USER_HOOK_PROMPT_MAX_CHARS = 2_000;
/** Cap on the JSON payload a command hook reads on stdin; a larger tool result is left out and flagged. */
const USER_HOOK_PAYLOAD_MAX_BYTES = 256 * 1024;
/** The exit status by which a command hook blocks what its event can block. */
export const USER_HOOK_BLOCK_EXIT_CODE = 2;

/**
 * Provenance of an installed package that supplied hook declarations, as the
 * composition root attributes it. Middleware treats it as opaque identity
 * data; it neither reads packages nor knows how the digests were produced.
 */
export interface UserHookPackageProvenance {
	version?: string;
	id: string;
	/** Install scope label of the package (for example "user" or "project"). */
	scope: string;
	/** Path recorded at install, when known. */
	sourcePath?: string;
	/** Canonical filesystem identity of the installed package root. */
	canonicalRoot: string;
	/** SHA-256 of the manifest bytes covered by the installed-tree digest. */
	manifestDigest: string;
	/** Installed-tree digest recorded at install and reverified by the supplier. */
	contentDigest: string;
}

/**
 * Attribution for a hook declared by an installed package. The declaration
 * bytes behind `declarationsDigest` are the ones the supplier hashed during
 * content verification and captured; nothing here was re-read from a mutable
 * path after verification.
 */
export interface UserHookExtensionSource {
	provenance: UserHookPackageProvenance;
	/** Generation the declarations were admitted under; 0 for an ephemeral build. */
	generation: number;
	/** SHA-256 of the captured hooks.yaml bytes. */
	declarationsDigest: string;
}

export interface UserHookSource {
	origin: UserHookOrigin;
	/** File path or `extensionId:path` the declaration was read from. */
	sourcePath: string;
	/** Extension id when origin is "extension". */
	sourceId?: string;
	/** Present exactly when origin is "extension". */
	extension?: UserHookExtensionSource;
}

export interface NormalizedCommandHook {
	kind: "command";
	argv: string[];
	cwd?: string;
	timeoutMs: number;
	/** Effect kind that carries the bounded output of a run that did not block; `none` discards it. */
	as: "annotate" | "reminder" | "none";
	/** `hook_event_name` in the stdin payload; the Clio event when unset. */
	eventName?: string;
	/** Another agent's hook protocol: its tool names and `tool_input` shapes on stdin, its JSON decisions on stdout. */
	dialect?: UserHookDialect;
}

export interface NormalizedPromptHook {
	kind: "prompt";
	message: string;
	severity: MiddlewareReminderSeverity;
}

export interface NormalizedEffectHook {
	kind: "effect";
	effect: DeclarableMiddlewareEffect;
}

export type NormalizedUserHookSpec = NormalizedCommandHook | NormalizedPromptHook | NormalizedEffectHook;

export interface NormalizedUserHook {
	id: string;
	source: UserHookSource;
	hash: string;
	on: MiddlewareHook;
	tools?: string[];
	enabled: boolean;
	/** `session`: a turn_start hook that runs on the first turn of each session only. */
	once?: "session";
	spec: NormalizedUserHookSpec;
}

export interface NormalizeUserHookOptions {
	/** Absolute workspace root; a command `cwd` must resolve under it. */
	workspaceRoot: string;
}

export interface NormalizeUserHookResult {
	hook?: NormalizedUserHook;
	issues: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stableHash(value: unknown): string {
	return createHash("sha256").update(canonicalJson(value)).digest("hex").slice(0, 16);
}

function canonicalJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	if (isRecord(value)) {
		const keys = Object.keys(value).sort();
		return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
	}
	return JSON.stringify(value) ?? "null";
}

function readStringArray(value: unknown): string[] | null {
	if (!Array.isArray(value)) return null;
	const out: string[] = [];
	for (const item of value) {
		if (typeof item !== "string" || item.length === 0) return null;
		out.push(item);
	}
	return out;
}

function normalizeCommandSpec(
	raw: Record<string, unknown>,
	options: NormalizeUserHookOptions,
	issues: string[],
): NormalizedCommandHook | null {
	const argv = readStringArray(raw.argv);
	if (!argv || argv.length === 0) {
		issues.push("command.argv must be a non-empty array of non-empty strings");
		return null;
	}
	const spec: NormalizedCommandHook = {
		kind: "command",
		argv,
		cwd: resolve(options.workspaceRoot),
		timeoutMs: USER_HOOK_COMMAND_TIMEOUT_DEFAULT_MS,
		as: "annotate",
	};
	if (raw.cwd !== undefined) {
		if (typeof raw.cwd !== "string" || raw.cwd.length === 0) {
			issues.push("command.cwd must be a non-empty string");
			return null;
		}
		const resolved = isAbsolute(raw.cwd) ? resolve(raw.cwd) : resolve(options.workspaceRoot, raw.cwd);
		if (!isWithin(resolved, options.workspaceRoot)) {
			issues.push("command.cwd must resolve under the workspace root");
			return null;
		}
		spec.cwd = resolved;
	}
	if (raw.timeoutMs !== undefined) {
		if (typeof raw.timeoutMs !== "number" || !Number.isFinite(raw.timeoutMs)) {
			issues.push("command.timeoutMs must be a number");
			return null;
		}
		spec.timeoutMs = Math.min(
			USER_HOOK_COMMAND_TIMEOUT_MAX_MS,
			Math.max(USER_HOOK_COMMAND_TIMEOUT_MIN_MS, Math.floor(raw.timeoutMs)),
		);
	}
	if (raw.as !== undefined) {
		if (raw.as !== "annotate" && raw.as !== "reminder" && raw.as !== "none") {
			issues.push('command.as must be "annotate", "reminder" or "none"');
			return null;
		}
		spec.as = raw.as;
	}
	if (raw.eventName !== undefined) {
		if (typeof raw.eventName !== "string" || !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(raw.eventName)) {
			issues.push("command.eventName must be an identifier of at most 64 characters");
			return null;
		}
		spec.eventName = raw.eventName;
	}
	if (raw.dialect !== undefined) {
		if (!isUserHookDialect(raw.dialect)) {
			issues.push(`command.dialect must be ${USER_HOOK_DIALECTS.map((name) => JSON.stringify(name)).join(" or ")}`);
			return null;
		}
		spec.dialect = raw.dialect;
	}
	return spec;
}

function normalizePromptSpec(raw: Record<string, unknown>, issues: string[]): NormalizedPromptHook | null {
	if (typeof raw.message !== "string" || raw.message.trim().length === 0) {
		issues.push("prompt.message must be a non-empty string");
		return null;
	}
	let severity: MiddlewareReminderSeverity = "info";
	if (raw.severity !== undefined) {
		if (typeof raw.severity !== "string" || !isMiddlewareReminderSeverity(raw.severity)) {
			issues.push("prompt.severity must be info, advisory, warn, or hard-block");
			return null;
		}
		severity = raw.severity;
	}
	return { kind: "prompt", message: raw.message.slice(0, USER_HOOK_PROMPT_MAX_CHARS), severity };
}

function normalizeEffectSpec(raw: Record<string, unknown>, issues: string[]): NormalizedEffectHook | null {
	const result = validateMiddlewareEffect(raw.effect ?? raw, "effect");
	if (!result.valid) {
		for (const issue of result.issues) issues.push(`effect: ${issue.message}`);
		return null;
	}
	return { kind: "effect", effect: result.effect };
}

function isWithin(child: string, parent: string): boolean {
	const rel = resolve(child);
	const base = resolve(parent);
	return rel === base || rel.startsWith(`${base}/`);
}

/**
 * Validate one raw hook declaration into a normalized hook, or return the
 * reasons it was rejected. Never throws.
 */
export function normalizeUserHook(
	raw: unknown,
	source: UserHookSource,
	options: NormalizeUserHookOptions,
): NormalizeUserHookResult {
	const issues: string[] = [];
	if (!isRecord(raw)) {
		return { issues: ["hook declaration must be an object"] };
	}
	if (raw.on === undefined || typeof raw.on !== "string" || !isMiddlewareHook(raw.on)) {
		issues.push("on must be one of before_tool, after_tool, turn_start, turn_end, on_compaction");
	}
	let tools: string[] | undefined;
	if (raw.tools !== undefined) {
		const parsed = readStringArray(raw.tools);
		if (!parsed) issues.push("tools must be an array of non-empty tool names");
		else tools = parsed;
	}
	let enabled = true;
	if (raw.enabled !== undefined) {
		if (typeof raw.enabled !== "boolean") issues.push("enabled must be a boolean");
		else enabled = raw.enabled;
	}
	let once: "session" | undefined;
	if (raw.once !== undefined) {
		if (raw.once !== "session") issues.push('once must be "session"');
		else if (raw.on !== "turn_start") issues.push("once applies to turn_start hooks only");
		else once = "session";
	}
	let spec: NormalizedUserHookSpec | null = null;
	if (raw.kind === "command") spec = normalizeCommandSpec(raw, options, issues);
	else if (raw.kind === "prompt") spec = normalizePromptSpec(raw, issues);
	else if (raw.kind === "effect") spec = normalizeEffectSpec(raw, issues);
	else issues.push('kind must be "command", "prompt", or "effect"');

	if (issues.length > 0 || spec === null || raw.on === undefined || typeof raw.on !== "string") {
		return { issues };
	}
	const on = raw.on as MiddlewareHook;
	const inapplicable = applicabilityIssue(on, spec);
	if (inapplicable !== null) return { issues: [inapplicable] };
	const hash = stableHash({ on, tools: tools ?? null, spec, ...(once ? { once } : {}) });
	const id =
		typeof raw.id === "string" && raw.id.length > 0 ? raw.id : `${source.sourceId ?? source.origin}.${spec.kind}.${hash}`;
	const hook: NormalizedUserHook = { id, source, hash, on, enabled, spec };
	if (tools !== undefined) hook.tools = tools;
	if (once !== undefined) hook.once = once;
	return { hook, issues };
}

export interface UserHookDeclarationBatch {
	source: UserHookSource;
	/** Parsed declarations; the loader tolerates `unknown[]` or `{ hooks: [] }`. */
	declarations: unknown;
}

export interface UserHookLoadIssue {
	source: UserHookSource;
	index: number;
	issues: string[];
}

export interface UserHookLoadResult {
	hooks: NormalizedUserHook[];
	/** Hooks dropped because a higher-precedence source declared the same id. */
	overridden: Array<{ winner: UserHookSource; loser: NormalizedUserHook }>;
	issues: UserHookLoadIssue[];
}

function declarationsArray(declarations: unknown): unknown[] {
	if (Array.isArray(declarations)) return declarations;
	if (isRecord(declarations) && Array.isArray(declarations.hooks)) return declarations.hooks;
	return [];
}

/**
 * Load and merge user hooks across sources. Sources are merged in
 * {@link USER_HOOK_ORIGIN_ORDER}; on an id collision the higher-precedence
 * origin wins and the loser is reported for the inspector. Malformed
 * declarations are collected as issues and never throw.
 */
export function loadUserHooks(
	batches: ReadonlyArray<UserHookDeclarationBatch>,
	options: NormalizeUserHookOptions,
): UserHookLoadResult {
	const ordered = [...batches].sort(
		(a, b) => USER_HOOK_ORIGIN_ORDER.indexOf(a.source.origin) - USER_HOOK_ORIGIN_ORDER.indexOf(b.source.origin),
	);
	const byId = new Map<string, NormalizedUserHook>();
	const overridden: UserHookLoadResult["overridden"] = [];
	const issues: UserHookLoadIssue[] = [];
	for (const batch of ordered) {
		const declarations = declarationsArray(batch.declarations);
		declarations.forEach((raw, index) => {
			const result = normalizeUserHook(raw, batch.source, options);
			if (!result.hook) {
				issues.push({ source: batch.source, index, issues: result.issues });
				return;
			}
			const existing = byId.get(result.hook.id);
			if (existing) overridden.push({ winner: batch.source, loser: existing });
			byId.set(result.hook.id, result.hook);
		});
	}
	return { hooks: [...byId.values()], overridden, issues };
}

// --- receipts --------------------------------------------------------------

/** `skipped` is the trust gate holding a hook back; `failed` is a hook that threw while it ran. */
export type UserHookOutcome = "emitted" | "command-ok" | "command-failed" | "command-timeout" | "skipped" | "failed";

/** Bounded extension attribution carried on every receipt of an extension hook. */
export interface HookReceiptExtension {
	id: string;
	scope: string;
	canonicalRoot: string;
	manifestDigest: string;
	contentDigest: string;
	declarationsDigest: string;
	generation: number;
}

export interface HookReceipt {
	extensionVersion?: string;
	sessionId?: string;
	/** The dispatched run whose call the hook ran for; absent for the session's own calls. */
	runId?: string;
	turnId?: string;
	at: number;
	hookId: string;
	origin: UserHookOrigin;
	sourcePath: string;
	hash: string;
	/** `prompt_submit` is an extension runtime point with no middleware hook of its own. */
	hook: MiddlewareHook | "prompt_submit";
	/** `runtime` is an extension runtime hook; it never comes from a hooks.yaml file. */
	kind: UserHookKind | "runtime";
	outcome: UserHookOutcome | "runtime-ok" | "runtime-failed" | "runtime-timeout";
	effectKinds?: string[];
	/** With `runs`, the total over the runs this receipt stands for. */
	durationMs?: number;
	/** Present when one receipt stands for several effect-free runs of a hook in one turn (C-33). */
	runs?: number;
	/** With `runs`, the longest of those runs. */
	maxDurationMs?: number;
	/** The command hook's own wall-clock limit, so a receipt shows how close a run came to it. */
	timeoutMs?: number;
	exitCode?: number;
	outputChars?: number;
	toolName?: string;
	extension?: HookReceiptExtension;
}

export type HookReceiptSink = (receipt: HookReceipt) => void;

// --- command runner --------------------------------------------------------

export interface UserHookCommandResult {
	code: number | null;
	timedOut: boolean;
	stdout: string;
	stderr: string;
}

export type UserHookCommandRunner = (
	argv: string[],
	options: { cwd?: string; timeoutMs: number /** JSON event payload written to the command's stdin. */; input?: string },
) => UserHookCommandResult;

export interface UserHookRegistrationDeps {
	recordReceipt: HookReceiptSink;
	/** Synchronous command runner. Injected so tests need no real subprocess. */
	runCommand: UserHookCommandRunner;
	now?: () => number;
	/** Published project hooks stop executing after their approved surface changes or is revoked. */
	isTrusted?: () => boolean;
}

function reminderEffect(message: string, severity: MiddlewareReminderSeverity): MiddlewareEffect {
	return severity === "info" ? { kind: "inject_reminder", message } : { kind: "inject_reminder", message, severity };
}

function commandEffect(hook: NormalizedCommandHook, output: string): MiddlewareEffect {
	const message = output.slice(0, USER_HOOK_COMMAND_OUTPUT_MAX_CHARS);
	return hook.as === "reminder" ? { kind: "inject_reminder", message } : { kind: "annotate_tool_result", message };
}

/**
 * Turn one normalized hook into a coded registration that plugs into the
 * existing ordered evaluation path. The registration filters by hook event and
 * tool names exactly like every other registration and emits a receipt on each
 * execution. A throw is receipted as `failed` and rethrown for the middleware
 * runtime to isolate, which reports its message and lets the turn continue.
 */
export function userHookToRegistration(
	hook: NormalizedUserHook,
	deps: UserHookRegistrationDeps,
): MiddlewareHookRegistration {
	const now = deps.now ?? Date.now;
	// Attribution is fixed when the registration is built, so a receipt written
	// by a registration from an older generation names that generation even
	// after a newer one is active.
	const extension = hook.source.extension === undefined ? undefined : receiptExtension(hook.source.extension);
	const baseReceipt = (input: {
		toolName?: string;
		sessionId?: string;
		turnId?: string;
	}): Omit<HookReceipt, "outcome"> => ({
		at: now(),
		hookId: hook.id,
		origin: hook.source.origin,
		sourcePath: hook.source.sourcePath,
		hash: hook.hash,
		hook: hook.on,
		kind: hook.spec.kind,
		...(extension !== undefined ? { extension: { ...extension } } : {}),
		...(hook.source.extension?.provenance.version !== undefined
			? { extensionVersion: hook.source.extension.provenance.version }
			: {}),
		...(input.toolName !== undefined ? { toolName: input.toolName } : {}),
		...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
		...(input.turnId !== undefined ? { turnId: input.turnId } : {}),
	});
	const sessionsRun = new Set<string>();
	const run = (input: MiddlewareHookInput): MiddlewareEffect[] => {
		if (!hook.enabled) return [];
		if (hook.once === "session") {
			const session = input.sessionId ?? "";
			if (sessionsRun.has(session)) return [];
			sessionsRun.add(session);
		}
		try {
			if (deps.isTrusted?.() === false) {
				deps.recordReceipt({ ...baseReceipt(input), outcome: "skipped" });
				return [];
			}
			return evaluateHook(hook, deps, baseReceipt(input), input);
		} catch (err) {
			try {
				deps.recordReceipt({ ...baseReceipt(input), outcome: "failed" });
			} catch {
				// The receipt sink may be what threw; the runtime still reports the error.
			}
			// The middleware runtime isolates the throw and reports its message as hook_failed, so the turn continues.
			throw err;
		}
	};
	// A turn_start command can refuse its turn with exit 2, and only the awaited turn_start phase gates a turn
	// (turn-middleware awaitTurnStart), so such a hook runs there and not in the synchronous phase.
	const gatesTurn = hook.spec.kind === "command" && hook.on === "turn_start";
	const registration: MiddlewareHookRegistration = {
		id: hook.id,
		description: `${hook.spec.kind} hook from ${hook.source.origin} (${hook.source.sourcePath})`,
		hooks: [hook.on],
		// The operator declared the trigger; the class names its kind, point and layer (#431).
		evidence: `${hook.spec.kind}-hook:${hook.on}@${hook.source.origin.replace(".", "-")}`,
		evaluate: (input) => (gatesTurn ? [] : run(input)),
		...(gatesTurn ? { awaited: true as const, evaluateAsync: async (input: MiddlewareHookInput) => run(input) } : {}),
	};
	// A command's first run is its costly one (a cold spawn), not in-process warmup.
	if (hook.spec.kind === "command") registration.spawnsProcess = true;
	if (hook.tools !== undefined) registration.toolNames = [...hook.tools];
	return registration;
}

function receiptExtension(source: UserHookExtensionSource): HookReceiptExtension {
	return {
		id: source.provenance.id,
		scope: source.provenance.scope,
		canonicalRoot: source.provenance.canonicalRoot,
		manifestDigest: source.provenance.manifestDigest,
		contentDigest: source.provenance.contentDigest,
		declarationsDigest: source.declarationsDigest,
		generation: source.generation,
	};
}

/**
 * The event a command hook reads as one JSON object on stdin, in the field
 * names coding-agent hook scripts already parse. A dialect names the tool and
 * shapes its arguments as that agent does; results stay Clio's own shapes. A
 * result that would push the payload past its cap is left out and flagged.
 */
function hookPayload(hook: NormalizedUserHook, spec: NormalizedCommandHook, input: MiddlewareHookInput): string {
	const call =
		input.toolName === undefined
			? undefined
			: spec.dialect !== undefined
				? dialectToolCall(spec.dialect, input.toolName, input.toolArgs)
				: { name: input.toolName, input: input.toolArgs };
	const payload: Record<string, unknown> = {
		hook_event_name: spec.eventName ?? hook.on,
		...(input.sessionId !== undefined ? { session_id: input.sessionId } : {}),
		...(input.turnId !== undefined ? { turn_id: input.turnId } : {}),
		...(input.runId !== undefined ? { run_id: input.runId } : {}),
		cwd: spec.cwd ?? process.cwd(),
		...(call !== undefined ? { tool_name: call.name } : {}),
		...(call?.input !== undefined ? { tool_input: call.input } : {}),
		...(input.toolResultDetails !== undefined ? { tool_response: input.toolResultDetails } : {}),
		...(hook.on === "turn_start" && input.text !== undefined ? { prompt: input.text } : {}),
		...(hook.on === "turn_end" && input.text !== undefined ? { last_assistant_message: input.text } : {}),
	};
	let text = JSON.stringify(payload);
	if (Buffer.byteLength(text) > USER_HOOK_PAYLOAD_MAX_BYTES && payload.tool_response !== undefined) {
		delete payload.tool_response;
		payload.tool_response_omitted = true;
		text = JSON.stringify(payload);
	}
	return text;
}

/** What exit 2 does at each event: refuse the call or the turn, tell the model, or keep the turn going. */
function blockEffect(on: MiddlewareHook, message: string): MiddlewareEffect | undefined {
	if (on === "before_tool" || on === "turn_start")
		return { kind: "block_tool", reason: message, severity: "hard-block" };
	if (on === "after_tool") return { kind: "annotate_tool_result", message, severity: "warn" };
	if (on === "turn_end") return { kind: "request_continuation", message, note: "a hook asked to continue" };
	return undefined;
}

function evaluateHook(
	hook: NormalizedUserHook,
	deps: UserHookRegistrationDeps,
	base: Omit<HookReceipt, "outcome">,
	input: MiddlewareHookInput,
): MiddlewareEffect[] {
	if (hook.spec.kind === "prompt") {
		const effect = reminderEffect(hook.spec.message, hook.spec.severity);
		deps.recordReceipt({ ...base, outcome: "emitted", effectKinds: ["inject_reminder"] });
		return [effect];
	}
	if (hook.spec.kind === "effect") {
		deps.recordReceipt({ ...base, outcome: "emitted", effectKinds: [hook.spec.effect.kind] });
		return [hook.spec.effect];
	}
	const startedAt = performance.now();
	const result = deps.runCommand(hook.spec.argv, {
		timeoutMs: hook.spec.timeoutMs,
		...(hook.spec.cwd !== undefined ? { cwd: hook.spec.cwd } : {}),
		input: hookPayload(hook, hook.spec, input),
	});
	// The run blocks the event loop, and a before_tool or after_tool run is billed to the tool's own duration.
	const timing = { durationMs: Math.round(performance.now() - startedAt), timeoutMs: hook.spec.timeoutMs };
	const output = (result.stdout || result.stderr || "").trim();
	if (result.timedOut) {
		deps.recordReceipt({
			...base,
			outcome: "command-timeout",
			exitCode: result.code ?? -1,
			outputChars: output.length,
			...timing,
		});
		return [];
	}
	const outcome: UserHookOutcome = result.code === 0 ? "command-ok" : "command-failed";
	// A dialect hook that exits 0 may answer in JSON on stdout, which decides as exit 2 does.
	const decided =
		result.code === 0 && hook.spec.dialect !== undefined
			? dialectOutputEffects(hook.on, result.stdout, hook.id, USER_HOOK_COMMAND_OUTPUT_MAX_CHARS)
			: null;
	if (decided !== null) {
		deps.recordReceipt({
			...base,
			outcome,
			exitCode: 0,
			outputChars: output.length,
			...timing,
			...(decided.length > 0 ? { effectKinds: decided.map((effect) => effect.kind) } : {}),
		});
		return decided;
	}
	// Exit 2 blocks: its standard error (else its output) is the reason the model or the operator reads.
	const effect =
		result.code === USER_HOOK_BLOCK_EXIT_CODE
			? blockEffect(
					hook.on,
					((result.stderr || result.stdout).trim() || `blocked by hook ${hook.id}`).slice(
						0,
						USER_HOOK_COMMAND_OUTPUT_MAX_CHARS,
					),
				)
			: output.length === 0 || hook.spec.as === "none"
				? undefined
				: commandEffect(hook.spec, output);
	deps.recordReceipt({
		...base,
		outcome,
		exitCode: result.code ?? -1,
		outputChars: output.length,
		...timing,
		...(effect !== undefined ? { effectKinds: [effect.kind] } : {}),
	});
	return effect !== undefined ? [effect] : [];
}
