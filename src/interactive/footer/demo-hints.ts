/**
 * Idle footer tips for demo guidance: a small session-local budget, one tip at
 * a time. No timers or model calls; a tip whose feature the operator already
 * uses (the harness profile) is skipped.
 */
export function createDemoHints() {
	const seen = new Set<string>();
	let current: { id: string; until: number } | null = null;
	let nextAt = 0;
	return (input: {
		enabled: boolean;
		now: number;
		quiet: boolean;
		agentActive: boolean;
		toolsUsed: boolean;
		contextBusy: boolean;
		dashboardKey: string;
		/** True when the operator already uses `feature`; absent means nothing is learned. */
		learned?: (feature: string) => boolean;
	}): string | null => {
		if (!input.enabled || input.quiet) {
			current = null;
			return null;
		}
		const learned = input.learned ?? (() => false);
		const choices: [string, boolean, string][] = [
			["agents", input.agentActive, `${input.dashboardKey} → Activity shows agents' current actions.`],
			["context", input.contextBusy && !learned("/context"), "/context shows what occupies your context window."],
			["tools", input.toolsUsed && !learned("/view"), "/view lets you inspect recorded tool calls and results."],
			["welcome", !learned("/help"), "Explore /help · guidance in /settings"],
		];
		if (current && input.now < current.until) {
			const active = choices.find(([id, eligible]) => id === current?.id && eligible);
			if (active) return active[2];
		}
		current = null;
		if (input.now < nextAt) return null;
		const choice = choices.find(([id, eligible]) => eligible && !seen.has(id));
		if (!choice) return null;
		seen.add(choice[0]);
		// Do not introduce the welcome tip after a more specific lesson.
		seen.add("welcome");
		current = { id: choice[0], until: input.now + 10_000 };
		nextAt = input.now + 60_000;
		return choice[2];
	};
}
