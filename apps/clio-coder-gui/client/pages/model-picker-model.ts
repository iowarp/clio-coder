import { ACP_TARGET_MODEL_LIMIT } from "../../contracts/wire.js";

export { ACP_TARGET_MODEL_LIMIT, MODEL_TARGET_PATHS } from "../../contracts/wire.js";
// The model picker's decisions: which ids a target offers, how the saved value sits among them, and
// which setting names the target a model field belongs to. Pure, so node:test covers it.

/** Not a model id anyone can save: an id is a non-empty string without a NUL byte. */
export const OTHER_MODEL = "\u0000other";

export interface ModelOption {
	readonly value: string;
	readonly label: string;
}

/**
 * The select's options, in reading order: the target's own default, the saved value when the target
 * no longer lists it (so opening the form never rewrites it), the catalog sorted for scanning, and a
 * way to type an id the catalog does not show.
 */
export function modelOptions(
	models: readonly string[],
	value: string,
	defaultModel: string | null,
	/** What the empty choice means where "the target's default" is not the right words. */
	emptyLabel?: string,
): ModelOption[] {
	const catalog = [...new Set(models)].sort((left, right) => left.localeCompare(right, "en-US"));
	const options: ModelOption[] = [
		{
			value: "",
			label: emptyLabel ?? (defaultModel ? `Use connection default · ${defaultModel}` : "Use connection default"),
		},
	];
	if (value !== "" && !catalog.includes(value))
		options.push({ value, label: `${value} · not in this connection's list` });
	for (const model of catalog) options.push({ value: model, label: model });
	options.push({ value: OTHER_MODEL, label: "Advanced: unverified model id…" });
	return options;
}

/** True when the catalog is as long as the wire allows, so a model the operator wants may be cut. */
export const catalogMayBeCut = (models: readonly string[], limit = ACP_TARGET_MODEL_LIMIT): boolean =>
	models.length >= limit;

/** After a target change, keep the model only if the new target lists it; otherwise use its default. */
export function modelAfterTargetChange(model: string, models: readonly string[] | null): string {
	return model !== "" && models !== null && models.includes(model) ? model : "";
}
