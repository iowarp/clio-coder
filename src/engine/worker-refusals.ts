import { isAbsolute, sep } from "node:path";
import { redactCommandOutputSecrets } from "../domains/evidence/redact.js";
import type { ClassifierCall } from "../domains/safety/action-classifier.js";
import { describeCallTarget } from "../domains/safety/call-target.js";
import type { SafetyDecision } from "../domains/safety/contract.js";
import { redactSecretString } from "../domains/safety/redaction.js";

/**
 * Execute refusals a non-interactive worker absorbs before its run ends. The
 * model reads each refusal as a tool result and may take another route; a
 * model that keeps proposing commands nobody can approve is stuck, and the
 * limit turns that loop into a typed permission_required outcome.
 */
export const WORKER_REFUSAL_LIMIT = 3;

const REFUSED_COMMAND_MAX_CHARS = 200;

export interface WorkerRefusal {
	tool: string;
	/** The exact command, or its first 200 characters, with credentials scrubbed. */
	command: string;
	/** The rule that refused the call, as the audit record names it. */
	rule: string;
}

/**
 * A worker's write aimed outside its workspace is nearly always a mistyped root,
 * most often its checkout's instead of its task worktree's. Nobody can approve
 * that here, so the refusal says where the work belongs instead of inviting a
 * retry through another tool.
 */
export function outsideWorkspaceHint(args: unknown, cwd: string): string {
	const path = typeof args === "object" && args !== null ? (args as { path?: unknown }).path : undefined;
	if (typeof path !== "string" || !isAbsolute(path)) return "";
	if (path === cwd || path.startsWith(`${cwd}${sep}`)) return "";
	return `. ${path} is outside your workspace root ${cwd}; write inside that root instead`;
}

/**
 * Name what was refused. Bash and verify carry the command the policy
 * evaluated (verify's resolved argv); other execute tools fall back to the
 * call's allowlisted target preview.
 */
export function describeWorkerRefusal(call: ClassifierCall, decision: SafetyDecision): WorkerRefusal {
	const raw = decision.policy?.command ?? describeCallTarget(call.tool, call.args);
	const scrubbed = redactCommandOutputSecrets(redactSecretString(raw.trim()));
	const command =
		scrubbed.length <= REFUSED_COMMAND_MAX_CHARS ? scrubbed : `${scrubbed.slice(0, REFUSED_COMMAND_MAX_CHARS)}…`;
	const rule =
		(decision.kind === "ask" ? decision.confirmationRuleId : undefined) ??
		decision.policy?.ruleId ??
		decision.policy?.reasonCode ??
		"autonomy";
	return { tool: call.tool, command: command.length > 0 ? command : "(no command)", rule };
}

export function formatWorkerRefusal(refusal: WorkerRefusal): string {
	return `${refusal.tool} \`${refusal.command}\` refused by rule ${refusal.rule}`;
}

/** Final reason once the limit is reached; it names every refused command for the receipt. */
export function workerRefusalLimitReason(refusals: ReadonlyArray<WorkerRefusal>): string {
	const listed = refusals.map((refusal, index) => `${index + 1}) ${formatWorkerRefusal(refusal)}`).join("; ");
	return `permission refusal limit reached: the worker ended after ${refusals.length} refused commands with no approval route: ${listed}`;
}
