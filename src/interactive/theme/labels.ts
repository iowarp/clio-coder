export function abbreviateModelId(modelId: string | null | undefined): string {
	const base = (modelId ?? "").trim().split("/").filter(Boolean).pop() ?? "";
	if (base.length === 0) return "model";
	const parts = base.split("-").filter((part) => part.length > 0);
	if (parts.length <= 1) return base.length > 18 ? base.slice(0, 18) : base;
	const kept: string[] = [];
	for (const part of parts) {
		const next = [...kept, part].join("-");
		if (kept.length >= 2 && next.length > 14) break;
		kept.push(part);
	}
	return kept.length > 0 ? kept.join("-") : base;
}

/**
 * Compact duration used everywhere the TUI shows elapsed time (footer chips,
 * dispatch cards, task island rows): sub-second in ms, sub-minute in seconds
 * with one decimal under 10s, then `XmYs`.
 */
export function formatCompactMs(value: number): string {
	const ms = Math.max(0, Math.round(value));
	if (ms < 1000) return `${ms}ms`;
	const seconds = ms / 1000;
	return seconds < 60
		? `${seconds.toFixed(seconds >= 10 ? 0 : 1)}s`
		: `${Math.floor(seconds / 60)}m${Math.round(seconds % 60)}s`;
}

export function collapseHomePath(path: string): string {
	const home = process.env.HOME;
	if (!home || home.length === 0) return path;
	if (path === home) return "~";
	return path.startsWith(`${home}/`) ? `~/${path.slice(home.length + 1)}` : path;
}
