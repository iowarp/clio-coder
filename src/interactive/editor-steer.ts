/**
 * `@<target> <text>` operator-target syntax for steering running dispatches
 * from the editor. Not a slash command: the intercept lives beside the bash
 * `!` intercept in the editor submit path.
 *
 * The target token is deliberately a bare word (letters, digits, underscore,
 * hyphen). File completion consults the same predicate and quotes an otherwise
 * ambiguous root-level extensionless reference before it reaches this parser.
 */

export interface EditorSteerMention {
	target: string;
	text: string;
}

export interface RunningDispatchRef {
	runId: string;
	agentId: string;
}

export type SteerTargetResolution =
	| { kind: "match"; run: RunningDispatchRef }
	| { kind: "ambiguous"; candidates: RunningDispatchRef[] }
	| { kind: "none" };

const STEER_TARGET_TOKEN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const STEER_MENTION = /^@(\S+)\s+(\S[\s\S]*)$/;

export function isEditorSteerTargetToken(value: string): boolean {
	return STEER_TARGET_TOKEN.test(value);
}

export function parseEditorSteerMention(text: string): EditorSteerMention | null {
	const match = STEER_MENTION.exec(text.trim());
	if (!match?.[1] || !match[2] || !isEditorSteerTargetToken(match[1])) return null;
	return { target: match[1], text: match[2].trim() };
}

/**
 * Resolve a steer target against the running dispatches: exact agentId match
 * first, then runId prefix. One hit steers; several ask for a runId prefix;
 * none reports the running set.
 */
export function resolveSteerTarget(target: string, running: ReadonlyArray<RunningDispatchRef>): SteerTargetResolution {
	const byAgent = running.filter((run) => run.agentId === target);
	if (byAgent.length === 1 && byAgent[0]) return { kind: "match", run: byAgent[0] };
	if (byAgent.length > 1) return { kind: "ambiguous", candidates: [...byAgent] };
	const byRunId = running.filter((run) => run.runId.startsWith(target));
	if (byRunId.length === 1 && byRunId[0]) return { kind: "match", run: byRunId[0] };
	if (byRunId.length > 1) return { kind: "ambiguous", candidates: [...byRunId] };
	return { kind: "none" };
}

export function formatSteerCandidates(runs: ReadonlyArray<RunningDispatchRef>): string {
	return runs.map((run) => `${run.agentId} (${run.runId})`).join(", ");
}
