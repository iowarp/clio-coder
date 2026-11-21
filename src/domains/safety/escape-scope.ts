/**
 * Session scopes for sandbox escapes (M-7). An `unsandboxed: true` call whose only ask is leaving the
 * main-session sandbox can be approved for the rest of the session over an explicit scope: the exact
 * script files it runs (canonical path and content hash), its working directory and the environment
 * assignments it sets. A later rerun of those same unchanged files, from the same cwd with the same env,
 * no longer asks; an edited script, another script, another cwd or other env asks again. No directory
 * is ever a scope. The scope is the harness's own reading of the asked
 * call, shown on the card as the option's label, and a grant is recorded only when the operator picks
 * that option: on the approval card, on an ACP client, or on the option ask_user adds to a question
 * that names leaving the sandbox. Operator free text (a steer, a typed answer) is never a grant.
 *
 * Grants persist as session ledger entries, so a resumed session keeps them and a new session starts
 * with none. Environment values are kept as digests: run_script promises its values are never recorded.
 */

import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { canonicalizePath } from "../../core/path-canonical.js";
import { ToolNames } from "../../core/tool-names.js";
import type { ClassifierCall } from "./action-classifier.js";
import { stepScriptOperand } from "./call-consequence.js";
import type { SafetyDecision } from "./contract.js";
import { isSameOrDescendant } from "./path-policy.js";
import { shellCommandSteps } from "./protected-artifacts.js";
import { redactSecretString } from "./redaction.js";
import { asksToLeaveSandbox, SANDBOX_ESCAPE_REASON, SANDBOX_ESCAPE_RULE_ID } from "./sandbox-escape.js";

/** Ledger entry type of one session escape scope grant. */
export const ESCAPE_SCOPE_CUSTOM_TYPE = "clio-coder.escape-scope";

/** How every session-scope option label starts; ask_user drops an agent-authored option that claims it. */
export const ESCAPE_SCOPE_OPTION_PREFIX = "Approve for this session:";

/** What an escape scope covers, as the harness read it from the asked call. */
export interface EscapeScope {
	/** The script files the call runs: canonical path and `sha256:<hex>` of the content, sorted by path. */
	readonly scripts: ReadonlyArray<EscapeScopeScript>;
	/** The resolved working directory the call runs in. */
	readonly cwd: string;
	/** Environment assignments the call sets, by name, as `sha256:<hex>` digests of their values. */
	readonly env: Readonly<Record<string, string>>;
	/** The same assignments as the card shows them, redacted; never persisted. */
	readonly envShown?: Readonly<Record<string, string>>;
}

/** One script file a scope names. */
export interface EscapeScopeScript {
	readonly path: string;
	readonly sha256: string;
}

/** Where the operator approved a scope. */
export type EscapeScopeSource = "approval-card" | "acp-client" | "ask-user";

const SOURCES: ReadonlySet<string> = new Set<EscapeScopeSource>(["approval-card", "acp-client", "ask-user"]);

/** One recorded grant, as the session ledger holds it. */
export interface EscapeScopeGrant {
	readonly version: 1;
	readonly scope: EscapeScope;
	readonly source: EscapeScopeSource;
	readonly at: string;
}

/** What admission does with an escape a granted scope covers. */
export type ScopedEscapeRoute = "run" | "judge";

function digest(value: string | Buffer): string {
	return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

const DIGEST = /^sha256:[0-9a-f]{64}$/u;
/** The largest script file a scope hashes; a larger one gets only the one-call approval. */
const SCOPE_SCRIPT_MAX_BYTES = 16 * 1024 * 1024;

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/u;

/**
 * The reach of one escape: every script it runs, where it runs and what environment it sets. For a call that
 * leaves the sandbox but runs anything but script files, redirects into a file, or runs a script that is not a
 * readable regular file inside `roots` (the workspace and scratch roots), why no scope exists, completing
 * "Clio offers no session option for this call because". Null for a call that does not leave the sandbox.
 */
function escapeReach(call: ClassifierCall, roots: ReadonlyArray<string>, cwdBase: string): EscapeScope | string | null {
	const args = call.args;
	if (args?.unsandboxed !== true) return null;
	const cwd = path.resolve(cwdBase, typeof args.cwd === "string" && args.cwd.length > 0 ? args.cwd : ".");
	const spelled: string[] = [];
	const raw = new Map<string, string>();
	const envShown: Record<string, string> = {};
	const assign = (name: string, value: string, shown: string): boolean => {
		const prior = raw.get(name);
		if (prior !== undefined && prior !== digest(value)) return false;
		raw.set(name, digest(value));
		envShown[name] = shown;
		return true;
	};
	const unfixedEnv = "its environment assignments are not one fixed set of names and values";
	if (call.tool === ToolNames.RunScript) {
		if (typeof args.script !== "string" || args.script.length === 0) return "it names no script file";
		spelled.push(args.script);
		const env = args.env;
		if (env !== undefined) {
			if (env === null || typeof env !== "object" || Array.isArray(env)) return unfixedEnv;
			for (const [name, value] of Object.entries(env as Record<string, unknown>)) {
				if (!ENV_NAME.test(name) || typeof value !== "string") return unfixedEnv;
				// run_script records keys, never values, so the card names the key alone.
				if (!assign(name, value, "…")) return unfixedEnv;
			}
		}
	} else if (call.tool === ToolNames.Bash) {
		if (typeof args.command !== "string" || args.command.trim().length === 0) return "it runs no command";
		const steps = shellCommandSteps(args.command);
		if (steps.length === 0) return "Clio cannot read its command as steps";
		for (const step of steps) {
			if (step.truncatingRedirects.length > 0) return "it redirects output into a file";
			const operand = stepScriptOperand(step);
			if (operand === undefined) return "a step of its command runs something other than a script file";
			spelled.push(operand);
			for (const assignment of step.assignments ?? []) {
				const at = assignment.indexOf("=");
				const name = assignment.slice(0, at);
				const value = assignment.slice(at + 1);
				if (!assign(name, value, redactSecretString(value))) return unfixedEnv;
			}
		}
	} else {
		return "a session option covers only bash and run_script calls";
	}
	const scripts = new Map<string, string>();
	for (const operand of spelled) {
		const file = canonicalizePath(path.resolve(cwd, operand));
		if (file === null) return `its script ${redactSecretString(operand)} does not resolve to a file`;
		if (!roots.some((root) => isSameOrDescendant(file, root))) {
			return `its script ${file} lies outside the workspace and scratch roots`;
		}
		if (scripts.has(file)) continue;
		const unreadable = `its script ${file} is not a readable file of at most 16 MiB that Clio can hash`;
		try {
			const stat = statSync(file);
			if (!stat.isFile() || stat.size > SCOPE_SCRIPT_MAX_BYTES) return unreadable;
			scripts.set(file, digest(readFileSync(file)));
		} catch {
			return unreadable;
		}
	}
	return {
		scripts: [...scripts.entries()]
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([file, sha256]) => ({ path: file, sha256 })),
		cwd: canonicalizePath(cwd) ?? cwd,
		env: Object.fromEntries([...raw.entries()].sort(([a], [b]) => a.localeCompare(b))),
		envShown,
	};
}

/**
 * The scope a session-scope option offers for an asked escape, or null when the call gets only the
 * one-call approval. Maintainer ruling on M-7 Q2: the exact script files the call runs, by canonical path
 * and content hash, the exact cwd and the exact env assignments.
 */
function deriveEscapeScope(
	call: ClassifierCall,
	roots: ReadonlyArray<string>,
	cwdBase: string = process.cwd(),
): EscapeScope | null {
	const reach = escapeReach(call, roots, cwdBase);
	return typeof reach === "string" ? null : reach;
}

/**
 * True when `call` lies inside a granted `scope` (M-7 Q2 ruling): it runs from the same cwd, sets exactly
 * the scope's env assignments with the same values, and every script it runs is one of the scope's files
 * with the content it had when approved. An edited or another script asks again.
 */
function escapeScopeCovers(
	scope: EscapeScope,
	call: ClassifierCall,
	roots: ReadonlyArray<string>,
	cwdBase: string = process.cwd(),
): boolean {
	const reach = escapeReach(call, roots, cwdBase);
	if (reach === null || typeof reach === "string" || reach.cwd !== scope.cwd) return false;
	const covered = reach.scripts.every((script) =>
		scope.scripts.some((granted) => granted.path === script.path && granted.sha256 === script.sha256),
	);
	if (!covered) return false;
	const names = Object.keys(reach.env);
	if (names.length !== Object.keys(scope.env).length) return false;
	return names.every((name) => scope.env[name] === reach.env[name]);
}

/**
 * Whether a covered escape runs at admission or still goes to the safety judge with the grant as its
 * approval. Maintainer ruling on M-7 Q3: it runs, without the judge; admission consults a grant only when
 * leaving the sandbox is the call's sole ask reason (`onlyAsksToLeaveSandbox`), so any other ask still asks.
 */
export function scopedEscapeRoute(): ScopedEscapeRoute {
	return "run";
}

/** True when an ask's only reason is leaving the sandbox, so a scope grant answers all of it. */
function onlyAsksToLeaveSandbox(decision: SafetyDecision): boolean {
	const policy = decision.policy;
	if (decision.kind !== "ask" || policy === undefined || policy.ruleId !== SANDBOX_ESCAPE_RULE_ID) return false;
	if (decision.confirmationRuleId !== undefined) return false;
	return policy.reasons.length > 0 && policy.reasons.every((reason) => reason === SANDBOX_ESCAPE_REASON);
}

/** The scope as one line: the script files with their short hashes, the cwd and the env assignments it covers. */
export function describeEscapeScope(scope: EscapeScope): string {
	const names = Object.keys(scope.env);
	const env =
		names.length === 0
			? "no env assignments"
			: `env ${names.map((name) => `${name}=${scope.envShown?.[name] ?? "…"}`).join(" ")}`;
	const files = scope.scripts.map((script) => `${script.path} (${script.sha256.slice(0, 19)})`).join(", ");
	return `${scope.scripts.length === 1 ? "script" : "scripts"} ${files} · cwd ${scope.cwd} · ${env}`;
}

/** The option label every surface shows: `Approve for this session: <scope>`. */
export function escapeScopeOptionLabel(scope: EscapeScope): string {
	return `${ESCAPE_SCOPE_OPTION_PREFIX} ${describeEscapeScope(scope)}`;
}

/** What choosing the option does, in one sentence. */
export function escapeScopeOptionConsequence(scope: EscapeScope): string {
	const files = scope.scripts.map((script) => script.path).join(", ");
	return `Runs this call outside the sandbox, and for the rest of this session every unsandboxed rerun of ${files}, unchanged, from ${scope.cwd} with exactly these env assignments, without asking. An edited script, another script, cwd or env still asks.`;
}

function validScope(value: unknown): EscapeScope | null {
	if (value === null || typeof value !== "object") return null;
	const { scripts, cwd, env } = value as Record<string, unknown>;
	if (!Array.isArray(scripts) || scripts.length === 0) return null;
	const files: EscapeScopeScript[] = [];
	for (const script of scripts as unknown[]) {
		if (script === null || typeof script !== "object") return null;
		const { path: file, sha256 } = script as Record<string, unknown>;
		if (typeof file !== "string" || !path.isAbsolute(file) || typeof sha256 !== "string" || !DIGEST.test(sha256))
			return null;
		files.push({ path: file, sha256 });
	}
	if (typeof cwd !== "string" || !path.isAbsolute(cwd)) return null;
	if (env === null || typeof env !== "object" || Array.isArray(env)) return null;
	const pairs = Object.entries(env as Record<string, unknown>);
	if (!pairs.every(([name, digested]) => ENV_NAME.test(name) && typeof digested === "string" && DIGEST.test(digested)))
		return null;
	return { scripts: files, cwd, env: Object.fromEntries(pairs) as Record<string, string> };
}

/** A recorded grant read back from a ledger entry, or null for anything else. */
function escapeScopeGrantOf(entry: unknown): EscapeScopeGrant | null {
	if (entry === null || typeof entry !== "object") return null;
	const { kind, customType, data } = entry as Record<string, unknown>;
	if (kind !== "custom" || customType !== ESCAPE_SCOPE_CUSTOM_TYPE || data === null || typeof data !== "object")
		return null;
	const record = data as Record<string, unknown>;
	if (record.version !== 1 || typeof record.source !== "string" || !SOURCES.has(record.source)) return null;
	if (typeof record.at !== "string") return null;
	const scope = validScope(record.scope);
	if (scope === null) return null;
	return { version: 1, scope, source: record.source as EscapeScopeSource, at: record.at };
}

/** What the ledger needs from its host: the current session's entries, a way to record one, and the roots. */
export interface EscapeScopeLedgerPort {
	/** The current session id, or null with no session. */
	session(): string | null;
	/** Every entry of the current session's ledger, or an empty list. */
	entries(): ReadonlyArray<unknown>;
	/** Records one grant on the current session's ledger. */
	append(grant: EscapeScopeGrant): void;
	/** The canonical workspace and scratch roots a scoped script must lie in. */
	roots(): ReadonlyArray<string>;
}

/** The session's escape scopes: the grants on record and the one offer an ask_user card may carry. */
export interface EscapeScopeLedger {
	/** The scope a session-scope option offers for this ask, or null when only the one-call approval applies. */
	scopeFor(call: ClassifierCall, decision: SafetyDecision): EscapeScope | null;
	/**
	 * For a sandbox escape that gets no session option, why not, completing "Clio offers no session option for
	 * this call because"; null for a call that is no escape or that has an option.
	 */
	noScopeReason(call: ClassifierCall, decision: SafetyDecision): string | null;
	/** The grant that covers this ask, or null. */
	covering(call: ClassifierCall, decision: SafetyDecision): EscapeScopeGrant | null;
	/** Records a grant the operator chose for the current session. */
	grant(scope: EscapeScope, source: EscapeScopeSource): void;
	/** Holds `scope` as the option the next ask_user question that names leaving the sandbox carries. */
	offer(scope: EscapeScope): void;
	/** The scope on offer for this session, or null. */
	pendingOffer(): EscapeScope | null;
}

export function createEscapeScopeLedger(port: EscapeScopeLedgerPort): EscapeScopeLedger {
	// Grants this process made, by session, so a session whose ledger cannot record one keeps it anyway.
	const made = new Map<string, EscapeScopeGrant[]>();
	let offered: { session: string | null; scope: EscapeScope } | null = null;
	const session = (): string | null => {
		try {
			return port.session();
		} catch {
			return null;
		}
	};
	const grants = (): EscapeScopeGrant[] => {
		const id = session();
		if (id === null) return [];
		let recorded: EscapeScopeGrant[] = [];
		try {
			recorded = port.entries().flatMap((entry) => {
				const grant = escapeScopeGrantOf(entry);
				return grant === null ? [] : [grant];
			});
		} catch {
			// An unreadable ledger loses only the recorded grants; this process's own still hold.
		}
		return [...recorded, ...(made.get(id) ?? [])];
	};
	return {
		scopeFor(call, decision) {
			if (!onlyAsksToLeaveSandbox(decision)) return null;
			try {
				return deriveEscapeScope(call, port.roots());
			} catch {
				return null;
			}
		},
		noScopeReason(call, decision) {
			if (call.args?.unsandboxed !== true || !asksToLeaveSandbox(decision)) return null;
			if (!onlyAsksToLeaveSandbox(decision)) {
				return "it needs approval for more than leaving the sandbox, and a session option answers only that";
			}
			try {
				const reach = escapeReach(call, port.roots(), process.cwd());
				return typeof reach === "string" ? reach : null;
			} catch {
				return null;
			}
		},
		covering(call, decision) {
			if (!onlyAsksToLeaveSandbox(decision)) return null;
			try {
				const roots = port.roots();
				return grants().find((grant) => escapeScopeCovers(grant.scope, call, roots)) ?? null;
			} catch {
				return null;
			}
		},
		grant(scope, source) {
			const id = session();
			if (id === null) return;
			const { envShown: _shown, ...kept } = scope;
			const grant: EscapeScopeGrant = { version: 1, scope: kept, source, at: new Date().toISOString() };
			try {
				port.append(grant);
			} catch {
				made.set(id, [...(made.get(id) ?? []), grant]);
			}
			if (offered?.session === id) offered = null;
		},
		offer(scope) {
			offered = { session: session(), scope };
		},
		pendingOffer() {
			const id = session();
			return offered !== null && offered.session === id && id !== null ? offered.scope : null;
		},
	};
}
