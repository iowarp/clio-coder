/**
 * Reading an ACP peer's session config options for model and thinking-level selection. ACP v1 announces both as
 * `select` options (categories `model` and `thought_level`); Antigravity (`agy acp`) also names a model with its
 * effort as one legacy `<model>-<level>` id, which only an agy delegation splits here.
 */

import { AcpError } from "./errors.js";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export interface PeerSelectOption {
	id: string;
	currentValue: string | null;
	values: string[];
}

/**
 * The `select` config option in a category, preferring the one whose id is
 * `preferId` and otherwise the first. ACP v1 uses session config options for
 * model and thinking level; their values may be grouped. A 0.6.2 Clio peer
 * announced its `target` option in the `model` category ahead of `model`.
 */
export function peerSelectOption(
	configOptions: unknown,
	category: "model" | "thought_level",
	preferId?: string,
): PeerSelectOption | null {
	if (!Array.isArray(configOptions)) return null;
	let first: PeerSelectOption | null = null;
	for (const option of configOptions) {
		if (!isRecord(option) || option.category !== category || option.type !== "select") continue;
		if (typeof option.id !== "string" || option.id.length === 0) continue;
		const values: string[] = [];
		for (const entry of Array.isArray(option.options) ? option.options : []) {
			if (!isRecord(entry)) continue;
			if (typeof entry.value === "string") values.push(entry.value);
			else if (Array.isArray(entry.options)) {
				for (const grouped of entry.options) {
					if (isRecord(grouped) && typeof grouped.value === "string") values.push(grouped.value);
				}
			}
		}
		const parsed = {
			id: option.id,
			currentValue: typeof option.currentValue === "string" ? option.currentValue : null,
			values,
		};
		if (option.id === preferId) return parsed;
		first ??= parsed;
	}
	return first;
}

const OFFERED_LIMIT = 16;
const OFFERED_VALUE_CHARS = 64;

/**
 * The peer's offered values as a bounded failure-message suffix, so a coordinator learns the valid choices from the
 * run outcome. Values are peer text: each is cut, and the list stops at a fixed count.
 */
export function offeredChoices(values: ReadonlyArray<string> | undefined): string {
	if (values === undefined || values.length === 0) return "; the peer offers none";
	const shown = values
		.slice(0, OFFERED_LIMIT)
		.map((value) => (value.length > OFFERED_VALUE_CHARS ? `${value.slice(0, OFFERED_VALUE_CHARS)}...` : value));
	const more = values.length > OFFERED_LIMIT ? ` (+${values.length - OFFERED_LIMIT} more)` : "";
	return `; offered: ${shown.join(", ")}${more}`;
}

/** Efforts agy spells as a model id suffix (`gemini-3.8-flash-high`); its thinking levels run minimal to xhigh. */
const EFFORT_SUFFIXES = new Set(["minimal", "low", "medium", "high", "xhigh", "max"]);

function effortSuffix(id: string, base: string): string | null {
	if (!id.startsWith(`${base}-`)) return null;
	const suffix = id.slice(base.length + 1);
	return EFFORT_SUFFIXES.has(suffix.toLowerCase()) ? suffix : null;
}

export interface PeerModelRequest {
	model?: string;
	thinkingLevel?: string;
}

/**
 * An agy request in the shape its options take. An id agy does not offer as a model that is `<offered model>-<level>`
 * becomes that model plus the level, in the offered spelling when the current options list it; a level asked for
 * separately must agree, and the adapter checks it against the options the model switch returns (agy offers some
 * models no level). Otherwise, with no `thought_level` option, efforts may live in the model ids: `<model>` plus a level
 * becomes `<model>-<level>`, and a bare base resolves to the current or only variant. Anything else passes through for
 * the ordinary checks to accept or refuse.
 */
export function legacyModelRequest(
	request: PeerModelRequest,
	modelOption: PeerSelectOption | null,
	thoughtOption: PeerSelectOption | null,
): PeerModelRequest {
	const model = request.model;
	const ids = modelOption?.values ?? [];
	if (model === undefined || ids.includes(model)) return request;
	const at = model.lastIndexOf("-");
	const base = at > 0 ? model.slice(0, at) : "";
	const level = at > 0 ? effortSuffix(model, base) : null;
	if (level !== null && ids.includes(base)) {
		const offered = thoughtOption?.values.find((value) => value.toLowerCase() === level.toLowerCase()) ?? level;
		if (request.thinkingLevel !== undefined && request.thinkingLevel.toLowerCase() !== offered.toLowerCase()) {
			throw new AcpError(
				"acp_model_unavailable",
				`ACP peer does not offer requested model '${model}' with thinking level '${request.thinkingLevel}': the id names thinking level '${level}'`,
			);
		}
		return { model: base, thinkingLevel: offered };
	}
	if (thoughtOption !== null) return request;
	const variants = ids.filter((id) => effortSuffix(id, model) !== null);
	if (variants.length === 0) return request;
	if (request.thinkingLevel !== undefined) {
		const variant = variants.find(
			(id) => effortSuffix(id, model)?.toLowerCase() === request.thinkingLevel?.toLowerCase(),
		);
		return { model: variant ?? `${model}-${request.thinkingLevel}` };
	}
	const current = modelOption?.currentValue ?? null;
	if (current !== null && variants.includes(current)) return { model: current };
	if (variants.length === 1) return { model: variants[0] ?? model };
	throw new AcpError(
		"acp_model_unavailable",
		`ACP peer offers multiple efforts for requested model '${model}'; specify thinkingLevel${offeredChoices(variants)}`,
	);
}
