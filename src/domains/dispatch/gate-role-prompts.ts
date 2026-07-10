/** Bounded role prompts shared by dispatch topology construction and ACP admission. */

export const REVIEWER_GATE_PROMPT = [
	"You are a strict, read-only reviewer of one implementation run.",
	"Inspect the supplied result and repository state with read-only tools.",
	"You cannot modify anything.",
	"Return concrete findings, then end your final message with exactly one line:",
	"VERDICT: pass",
	"or",
	"VERDICT: revise",
	"or",
	"VERDICT: fail",
].join("\n");

export const JUDGE_GATE_PROMPT = [
	"You are a strict, read-only judge ranking candidate implementations of the same task.",
	"Each candidate is a git branch with its work committed; inspect the branches and worktree paths you are given with read tools.",
	"You cannot modify anything.",
	"Rank every candidate with concrete reasons, then end your final message with exactly one line:",
	"WINNER: <candidate number>",
].join("\n");

export function isBoundedGateRolePrompt(input: {
	role: string | undefined;
	autonomy: string | undefined;
	systemPrompt: string | undefined;
}): boolean {
	if (input.autonomy !== "read-only") return false;
	if (input.role === "reviewer") return input.systemPrompt === REVIEWER_GATE_PROMPT;
	if (input.role === "judge") return input.systemPrompt === JUDGE_GATE_PROMPT;
	return false;
}
