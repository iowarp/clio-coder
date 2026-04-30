import type { MiddlewareEffectKind, MiddlewareHook, MiddlewareRule } from "./types.js";

export const BUILTIN_MIDDLEWARE_RULE_IDS = [
	"publish-state-guard",
	"finish-contract-check",
	"proxy-validation-detector",
	"resource-budget-sentinel",
	"framework-reminder",
	"science.no-existence-only-validation",
	"science.preserve-checkpoints",
	"science.unit-vs-scheduler-validation",
] as const;

const BUILTIN_MIDDLEWARE_RULES = [
	{
		id: "publish-state-guard",
		source: "builtin",
		description: "Detects tool flows that may publish or mutate durable harness state.",
		enabled: true,
		hooks: ["before_tool", "after_tool"],
		effectKinds: ["protect_path", "require_validation", "inject_reminder"],
	},
	{
		id: "finish-contract-check",
		source: "builtin",
		description: "Tracks finish-contract advisories around final assistant handoff.",
		enabled: true,
		hooks: ["before_finish", "after_finish"],
		effectKinds: ["inject_reminder", "require_validation"],
	},
	{
		id: "proxy-validation-detector",
		source: "builtin",
		description: "Detects proxy validation patterns after tool execution and blocked tool attempts.",
		enabled: true,
		hooks: ["after_tool", "on_blocked_tool"],
		effectKinds: ["annotate_tool_result", "require_validation"],
	},
	{
		id: "resource-budget-sentinel",
		source: "builtin",
		description: "Observes dispatch, model, and retry hooks for future budget policy decisions.",
		enabled: true,
		hooks: ["before_model", "after_model", "on_retry", "on_dispatch_start", "on_dispatch_end"],
		effectKinds: ["inject_reminder", "require_validation"],
	},
	{
		id: "framework-reminder",
		source: "builtin",
		description: "Carries framework reminders for future model, tool, and compaction boundaries.",
		enabled: true,
		hooks: ["before_model", "before_tool", "on_compaction"],
		effectKinds: ["inject_reminder"],
	},
	{
		id: "science.no-existence-only-validation",
		source: "builtin",
		description:
			"Reminds agents that file existence does not validate scientific artifacts; require shape, schema, dimensions, attributes, or numerical tolerance checks.",
		enabled: true,
		hooks: ["before_finish", "after_tool"],
		effectKinds: ["inject_reminder", "annotate_tool_result"],
	},
	{
		id: "science.preserve-checkpoints",
		source: "builtin",
		description:
			"Marks validated checkpoint and restart artifacts as protected so destructive cleanup tools cannot remove them.",
		enabled: true,
		hooks: ["before_tool", "after_tool"],
		effectKinds: ["protect_path", "inject_reminder"],
	},
	{
		id: "science.unit-vs-scheduler-validation",
		source: "builtin",
		description:
			"Distinguishes local unit validation from scheduler-backed validation (sbatch, srun, qsub, flux run); a scheduler exit code does not validate produced artifacts.",
		enabled: true,
		hooks: ["after_tool", "before_finish"],
		effectKinds: ["inject_reminder", "annotate_tool_result"],
	},
] as const satisfies ReadonlyArray<MiddlewareRule>;

export function listMiddlewareRules(): MiddlewareRule[] {
	return BUILTIN_MIDDLEWARE_RULES.map(cloneRule);
}

export function middlewareRuleIdsForHook(hook: MiddlewareHook): string[] {
	const ids: string[] = [];
	for (const rule of BUILTIN_MIDDLEWARE_RULES) {
		const hooks: ReadonlyArray<MiddlewareHook> = rule.hooks;
		if (rule.enabled && hooks.includes(hook)) ids.push(rule.id);
	}
	return ids;
}

function cloneRule(rule: MiddlewareRule): MiddlewareRule {
	return {
		id: rule.id,
		source: rule.source,
		description: rule.description,
		enabled: rule.enabled,
		hooks: [...rule.hooks],
		effectKinds: [...rule.effectKinds] as MiddlewareEffectKind[],
	};
}
