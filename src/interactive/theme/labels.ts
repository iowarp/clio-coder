/**
 * Abbreviate a wire model id for chips and dashboards without amputating a
 * meaningful placement prefix or version suffix. `dynamo/qwen3.8-27b` remains
 * visible as selected; only the leaf is shortened when the complete route is
 * wider than 24 characters.
 */
export function abbreviateModelId(modelId: string | null | undefined): string {
	const segments = (modelId ?? "").trim().split("/").filter(Boolean);
	const base = segments.pop() ?? "";
	if (base.length === 0) return "model";
	const prefix = segments[0];
	const maxLeaf = prefix ? Math.max(8, 24 - prefix.length - 1) : 18;
	const parts = base.split("-").filter((part) => part.length > 0);
	let leaf: string;
	if (parts.length <= 1) leaf = base.length > maxLeaf ? base.slice(0, maxLeaf) : base;
	else {
		const kept: string[] = [];
		for (const part of parts) {
			const next = [...kept, part].join("-");
			if (kept.length > 0 && next.length > maxLeaf) break;
			kept.push(part);
		}
		const joined = kept.join("-");
		leaf = joined.length > maxLeaf ? joined.slice(0, maxLeaf) : joined;
	}
	return prefix ? `${prefix}/${leaf}` : leaf;
}

export interface TargetLabelOptions {
	/** Separator between the target id and the model. The narrow rail omits the spaces. */
	separator?: string;
	/** Off for surfaces with room for the whole wire id. */
	abbreviate?: boolean;
}

/**
 * The chat target as one label, with one spelling for the state where there
 * isn't one.
 *
 * Five surfaces answered the same question five different ways: the banner read
 * `not configured/not configured`, the editor rail `no model`, the footer
 * `none · none`, the settings overlay `(unset)`, and the providers overlay
 * `(no model)`. A user comparing them is checking whether Clio knows what it is
 * talking to, and four spellings read as four states.
 *
 * A target with no model and a model with no target are distinct from having
 * neither, so each says which half is missing rather than collapsing to the
 * same phrase. The settings overlay keeps `(unset)`, which labels an empty
 * editable field rather than reporting status.
 */
export function formatTargetLabel(
	targetId: string | null | undefined,
	modelId: string | null | undefined,
	options: TargetLabelOptions = {},
): string {
	const target = (targetId ?? "").trim();
	const model = (modelId ?? "").trim();
	if (target.length === 0 && model.length === 0) return "not configured";
	const shown = options.abbreviate === false ? model : abbreviateModelId(model);
	if (target.length === 0) return `no target · ${shown}`;
	if (model.length === 0) return `${target} · no model`;
	return `${target}${options.separator ?? " · "}${shown}`;
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

/**
 * Context-window fill percentage with one shared unknown grammar. A window
 * that has not been measured yet renders `?%` everywhere (compact footer,
 * expanded quadrant, segmented bar, /context-view overlay): a placeholder for
 * a number that has not arrived, never a value.
 */
export function formatContextPercent(percent: number | null | undefined): string {
	return typeof percent === "number" && Number.isFinite(percent) ? `${percent.toFixed(1)}%` : "?%";
}

export function collapseHomePath(path: string): string {
	const home = process.env.HOME;
	if (!home || home.length === 0) return path;
	if (path === home) return "~";
	return path.startsWith(`${home}/`) ? `~/${path.slice(home.length + 1)}` : path;
}
