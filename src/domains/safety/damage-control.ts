/**
 * Rule-driven hard-block interceptor. Rules are loaded from
 * `damage-control-rules.yaml` by rule-pack-loader and compiled once at load;
 * this module is pure data shapes + matching.
 */

export interface DamageControlRule {
	id: string;
	description: string;
	pattern: RegExp;
	class: string;
	block: boolean;
	ask?: boolean;
}

export interface DamageControlRuleset {
	version: number;
	rules: ReadonlyArray<DamageControlRule>;
}

export interface DamageControlMatch {
	ruleId: string;
	reason: string;
	actionClass: string;
	block: boolean;
	ask?: boolean;
}

export function match(commandString: string, ruleset: DamageControlRuleset): DamageControlMatch | null {
	if (commandString.length === 0) return null;
	for (const rule of ruleset.rules) {
		if (rule.pattern.test(commandString)) {
			const match: DamageControlMatch = {
				ruleId: rule.id,
				reason: `matched ${rule.id}: ${rule.description}`,
				actionClass: rule.class,
				block: rule.block,
			};
			if (rule.ask !== undefined) match.ask = rule.ask;
			return match;
		}
	}
	return null;
}
