import { homedir } from "node:os";
import path from "node:path";
import { ToolNames } from "../../core/tool-names.js";
import type { SafetyDecision } from "./contract.js";
import { isSameOrDescendant } from "./path-policy.js";
import {
	extractCommandCdScopedTargets,
	extractCommandDeleteTargets,
	extractCommandWriteTargets,
} from "./protected-artifacts.js";

/** Rule id of the ask for a call the operator's default would contain that sets `unsandboxed: true`. */
export const SANDBOX_ESCAPE_RULE_ID = "sandbox-escape";

export const SANDBOX_ESCAPE_REASON =
	"unsandboxed: true leaves the main-session sandbox, so the command runs as the operator with the operator's credentials and files; it runs only when the operator's request names this escape or the operator approves it";

/**
 * True when the ask would run a command outside the main-session sandbox,
 * whether the escape is the rule that asked or a reason joined to another ask.
 */
export function asksToLeaveSandbox(decision: SafetyDecision): boolean {
	const policy = decision.policy;
	if (policy === undefined) return false;
	return policy.ruleId === SANDBOX_ESCAPE_RULE_ID || policy.reasons.includes(SANDBOX_ESCAPE_REASON);
}

/**
 * True when an operator message mentions the sandbox. The judge's `operator-named`
 * citation is the model's word; an escape it allows also needs the operator's own
 * text to speak of the sandbox, so a judge that misreads a request cannot grant one.
 */
export function operatorMentionsSandbox(messages: ReadonlyArray<string>): boolean {
	return messages.some((text) => /sandbox|unconfined/i.test(text));
}

/**
 * The outside-workspace paths a shell call writes or deletes, or a write or
 * edit call changes, when the operator's own text names every one of them;
 * otherwise empty. A call whose targets cannot be read, or that touches nothing
 * outside the workspace, names nothing. Naming a path is not consent to leave
 * the sandbox, so for an escape the judge uses this only to hand the call to the
 * operator instead of a block; for any call it tells the judge the path is the operator's.
 */
export function operatorNamedOutsideTargets(
	call: { tool: string; args: Readonly<Record<string, unknown>> | undefined },
	messages: ReadonlyArray<string>,
	workspace: string = process.cwd(),
	home: string = homedir(),
): string[] {
	const spelled: string[] = [];
	let base = workspace;
	if (call.tool === ToolNames.Write || call.tool === ToolNames.Edit) {
		const target = call.args?.path;
		if (typeof target !== "string" || target.length === 0) return [];
		spelled.push(target);
	} else if (call.tool === ToolNames.Bash) {
		const command = call.args?.command;
		if (typeof command !== "string" || command.length === 0) return [];
		const cwdArg = call.args?.cwd;
		base = path.resolve(workspace, typeof cwdArg === "string" && cwdArg.length > 0 ? cwdArg : ".");
		spelled.push(
			...extractCommandWriteTargets(command),
			...extractCommandDeleteTargets(command),
			...extractCommandCdScopedTargets(command).map((target) => target.path),
		);
	} else {
		return [];
	}
	const outside = new Map<string, Set<string>>();
	for (const raw of spelled) {
		const resolved = raw === "~" || raw.startsWith("~/") ? path.join(home, raw.slice(1)) : path.resolve(base, raw);
		if (isSameOrDescendant(resolved, workspace)) continue;
		const spellings = outside.get(resolved) ?? new Set([resolved]);
		if (raw.includes("/")) spellings.add(raw.replace(/\/+$/u, ""));
		if (isSameOrDescendant(resolved, home) && resolved !== home) spellings.add(`~/${path.relative(home, resolved)}`);
		outside.set(resolved, spellings);
	}
	if (outside.size === 0) return [];
	for (const spellings of outside.values()) {
		if (![...spellings].some((spelling) => messages.some((text) => namesPath(text, spelling)))) return [];
	}
	return [...outside.keys()];
}

/** True when `text` carries `spelling` as a whole path, not as a prefix or suffix of a longer one. */
function namesPath(text: string, spelling: string): boolean {
	const escaped = spelling.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
	return new RegExp(`(?<![\\w.~/-])${escaped}(?![\\w/-]|\\.[\\w])`, "u").test(text);
}
