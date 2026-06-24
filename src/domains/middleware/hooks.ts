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
 * replace the safety policy. They register after the guard hooks and can only
 * add effects (including requesting `block_tool`); the durable safety contract
 * still classifies every tool call independently and a hook cannot grant a
 * permission safety would deny.
 *
 * Loading is best-effort: a malformed hook is rejected with a diagnostic and
 * never aborts a turn. Every hook carries source attribution and a content hash,
 * and every execution emits a receipt.
 */

import { createHash } from "node:crypto";
import { isAbsolute, resolve } from "node:path";
import type { MiddlewareHookRegistration } from "./runtime.js";
import {
	isMiddlewareHook,
	isMiddlewareReminderSeverity,
	type MiddlewareEffect,
	type MiddlewareHook,
	type MiddlewareReminderSeverity,
} from "./types.js";
import { validateMiddlewareEffect } from "./validate.js";

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

export interface UserHookSource {
	origin: UserHookOrigin;
	/** File path or `extensionId:path` the declaration was read from. */
	sourcePath: string;
	/** Extension id when origin is "extension". */
	sourceId?: string;
}

export interface NormalizedCommandHook {
	kind: "command";
	argv: string[];
	cwd?: string;
	timeoutMs: number;
	/** Effect kind that carries the bounded command output. */
	as: "annotate" | "reminder";
}

export interface NormalizedPromptHook {
	kind: "prompt";
	message: string;
	severity: MiddlewareReminderSeverity;
}

export interface NormalizedEffectHook {
	kind: "effect";
	effect: MiddlewareEffect;
}

export type NormalizedUserHookSpec = NormalizedCommandHook | NormalizedPromptHook | NormalizedEffectHook;

export interface NormalizedUserHook {
	id: string;
	source: UserHookSource;
	hash: string;
	on: MiddlewareHook;
	tools?: string[];
	enabled: boolean;
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
		if (raw.as !== "annotate" && raw.as !== "reminder") {
			issues.push('command.as must be "annotate" or "reminder"');
			return null;
		}
		spec.as = raw.as;
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
			issues.push("prompt.severity must be info, warn, or hard-block");
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
	let spec: NormalizedUserHookSpec | null = null;
	if (raw.kind === "command") spec = normalizeCommandSpec(raw, options, issues);
	else if (raw.kind === "prompt") spec = normalizePromptSpec(raw, issues);
	else if (raw.kind === "effect") spec = normalizeEffectSpec(raw, issues);
	else issues.push('kind must be "command", "prompt", or "effect"');

	if (issues.length > 0 || spec === null || raw.on === undefined || typeof raw.on !== "string") {
		return { issues };
	}
	const on = raw.on as MiddlewareHook;
	const hash = stableHash({ on, tools: tools ?? null, spec });
	const id =
		typeof raw.id === "string" && raw.id.length > 0 ? raw.id : `${source.sourceId ?? source.origin}.${spec.kind}.${hash}`;
	const hook: NormalizedUserHook = { id, source, hash, on, enabled, spec };
	if (tools !== undefined) hook.tools = tools;
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

export type UserHookOutcome = "emitted" | "command-ok" | "command-failed" | "command-timeout" | "skipped";

export interface HookReceipt {
	at: number;
	hookId: string;
	origin: UserHookOrigin;
	sourcePath: string;
	hash: string;
	hook: MiddlewareHook;
	kind: UserHookKind;
	outcome: UserHookOutcome;
	effectKinds?: string[];
	exitCode?: number;
	outputChars?: number;
	toolName?: string;
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
	options: { cwd?: string; timeoutMs: number },
) => UserHookCommandResult;

export interface UserHookRegistrationDeps {
	recordReceipt: HookReceiptSink;
	/** Synchronous command runner. Injected so tests need no real subprocess. */
	runCommand: UserHookCommandRunner;
	now?: () => number;
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
 * tool names exactly like every other registration, emits a receipt on each
 * execution, and never throws into a turn.
 */
export function userHookToRegistration(
	hook: NormalizedUserHook,
	deps: UserHookRegistrationDeps,
): MiddlewareHookRegistration {
	const now = deps.now ?? Date.now;
	const baseReceipt = (input: { toolName?: string }): Omit<HookReceipt, "outcome"> => ({
		at: now(),
		hookId: hook.id,
		origin: hook.source.origin,
		sourcePath: hook.source.sourcePath,
		hash: hook.hash,
		hook: hook.on,
		kind: hook.spec.kind,
		...(input.toolName !== undefined ? { toolName: input.toolName } : {}),
	});
	const registration: MiddlewareHookRegistration = {
		id: hook.id,
		description: `${hook.spec.kind} hook from ${hook.source.origin} (${hook.source.sourcePath})`,
		hooks: [hook.on],
		evaluate: (input) => {
			if (!hook.enabled) return [];
			try {
				return evaluateHook(hook, deps, baseReceipt(input));
			} catch {
				// A hook must never throw into a turn; report a skipped receipt.
				deps.recordReceipt({ ...baseReceipt(input), outcome: "skipped" });
				return [];
			}
		},
	};
	if (hook.tools !== undefined) registration.toolNames = [...hook.tools];
	return registration;
}

function evaluateHook(
	hook: NormalizedUserHook,
	deps: UserHookRegistrationDeps,
	base: Omit<HookReceipt, "outcome">,
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
	const result = deps.runCommand(hook.spec.argv, {
		timeoutMs: hook.spec.timeoutMs,
		...(hook.spec.cwd !== undefined ? { cwd: hook.spec.cwd } : {}),
	});
	const output = (result.stdout || result.stderr || "").trim();
	if (result.timedOut) {
		deps.recordReceipt({ ...base, outcome: "command-timeout", exitCode: result.code ?? -1, outputChars: output.length });
		return [];
	}
	const outcome: UserHookOutcome = result.code === 0 ? "command-ok" : "command-failed";
	deps.recordReceipt({ ...base, outcome, exitCode: result.code ?? -1, outputChars: output.length });
	if (output.length === 0) return [];
	const effect = commandEffect(hook.spec, output);
	return [effect];
}
