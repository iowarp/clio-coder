/** Small session-local hint budget. No timers, model calls, or persistent state. */
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
	}): string | null => {
		if (!input.enabled || input.quiet) {
			current = null;
			return null;
		}
		const choices: [string, boolean, string][] = [
			["agents", input.agentActive, `${input.dashboardKey} → Activity shows agents' current actions.`],
			["context", input.contextBusy, "/context shows what occupies your context window."],
			["tools", input.toolsUsed, "/view lets you inspect recorded tool calls and results."],
			["welcome", true, "Explore /help · guidance in /settings"],
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
