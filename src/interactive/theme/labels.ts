import { sanitizeCallTargetText } from "../../domains/safety/call-target.js";
import { stripTerminalSequences, truncateToWidth, visibleWidth } from "../../engine/tui.js";

const identitySegments = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** Keep both placement and the distinguishing suffix when an identity must fit. */
export function fitIdentityLabel(value: string, width: number): string {
	value = sanitizeCallTargetText(value);
	const room = Math.max(0, Math.floor(width));
	if (visibleWidth(value) <= room) return value;
	if (room <= 1) return room === 1 ? "…" : "";
	const tailBudget = Math.ceil((room - 1) / 2);
	let tail = "";
	for (const { segment } of [...identitySegments.segment(value)].reverse()) {
		if (visibleWidth(segment + tail) > tailBudget) break;
		tail = segment + tail;
	}
	const headBudget = room - 1 - visibleWidth(tail);
	let head = "";
	for (const { segment } of identitySegments.segment(value)) {
		if (visibleWidth(head + segment) > headBudget) break;
		head += segment;
	}
	return `${head}…${tail}`;
}

/** Compact wire identity with explicit omission and its version/quantization suffix. */
export function abbreviateModelId(modelId: string | null | undefined): string {
	const value = sanitizeCallTargetText(modelId ?? "");
	if (value.length === 0) return "model";
	if (visibleWidth(value) <= 24) return value;
	const slash = value.lastIndexOf("/");
	if (slash < 0) return fitIdentityLabel(value, 24);
	const placement = value.slice(0, slash);
	const model = value.slice(slash + 1);
	const modelBudget = Math.min(18, visibleWidth(model));
	return `${fitIdentityPrefix(placement, 23 - modelBudget)}/${fitIdentityLabel(model, modelBudget)}`;
}

/** Raw route fields stay separate until the surface knows its terminal-cell budget. */
export interface TargetIdentity {
	targetId: string | null | undefined;
	modelId: string | null | undefined;
}

function fitIdentityPrefix(value: string, width: number): string {
	return stripTerminalSequences(truncateToWidth(value, Math.max(0, width), "…", false));
}

export interface TargetLabelOptions {
	/** Separator between the target id and the model. The narrow rail omits the spaces. */
	separator?: string;
	/** Off for surfaces with room for the whole wire id. */
	abbreviate?: boolean;
	/** Fit raw target/model fields once, preserving family and suffix before placement. */
	width?: number;
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
	const target = sanitizeCallTargetText(targetId ?? "");
	const model = sanitizeCallTargetText(modelId ?? "");
	const fit = (label: string): string => (options.width === undefined ? label : fitIdentityLabel(label, options.width));
	if (target.length === 0 && model.length === 0) return fit("not configured");
	if (options.width !== undefined && target.length > 0 && model.length > 0) {
		const width = Math.max(0, Math.floor(options.width));
		const separator = options.separator ?? " · ";
		const full = `${target}${separator}${model}`;
		if (visibleWidth(full) <= width) return full;
		const leaf = model.slice(model.lastIndexOf("/") + 1);
		const available = width - visibleWidth(separator);
		if (available < 9) return fitIdentityLabel(leaf, width);
		const modelBudget = Math.min(visibleWidth(leaf), Math.max(8, Math.ceil(available * 0.7)));
		const targetBudget = Math.min(visibleWidth(target), available - modelBudget);
		return `${fitIdentityPrefix(target, targetBudget)}${separator}${fitIdentityLabel(leaf, available - targetBudget)}`;
	}
	const shown = options.abbreviate === false ? model : abbreviateModelId(model);
	if (target.length === 0) return fit(`no target · ${shown}`);
	if (model.length === 0) return fit(`${target} · no model`);
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
