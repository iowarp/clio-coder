/** Bounded role prompts shared by dispatch topology construction and ACP admission. */

export const REVIEWER_GATE_PROMPT = [
	"You are a strict, read-only reviewer of one implementation run.",
	"Inspect the supplied result and repository state with read-only tools.",
	"You cannot modify anything.",
	"Judge only whether the work passes. Whether a failure earns another attempt is not your decision.",
	'End with a JSON object only: {"verdict":"pass|fail","checks":[{"name":"...","passed":true,"evidence":"what you inspected and observed"}]}.',
	"The verdict must agree with every check. Report at least one check.",
].join("\n");

export const JUDGE_GATE_PROMPT = [
	"You are a strict, read-only judge ranking candidate implementations of the same task.",
	"Each candidate is a git branch with its work committed; inspect the branches and worktree paths you are given with read tools.",
	"You cannot modify anything.",
	'End with a JSON object only: {"winner":<candidate number>,"checks":[{"name":"...","passed":true,"evidence":"what you compared and observed"}]}.',
	"The winner must be one of the candidate numbers you were given. Report at least one check.",
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
