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

export function collapseHomePath(path: string): string {
	const home = process.env.HOME;
	if (!home || home.length === 0) return path;
	if (path === home) return "~";
	return path.startsWith(`${home}/`) ? `~/${path.slice(home.length + 1)}` : path;
}
