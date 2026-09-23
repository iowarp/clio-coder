// The model picker's decisions: which ids a target offers, how the saved value sits among them, and
// which setting names the target a model field belongs to. Pure, so node:test covers it.

/** Not a model id anyone can save: an id is a non-empty string without a NUL byte. */
export const OTHER_MODEL = "\u0000other";

/** Clio Coder's ACP target list carries at most this many models per target (src/engine/acp/server.ts). */
export const ACP_TARGET_MODEL_LIMIT = 64;

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
		{ value: "", label: emptyLabel ?? (defaultModel ? `Target default · ${defaultModel}` : "Target default") },
	];
	if (value !== "" && !catalog.includes(value)) options.push({ value, label: `${value} · not in this target's list` });
	for (const model of catalog) options.push({ value: model, label: model });
	options.push({ value: OTHER_MODEL, label: "Another model id…" });
	return options;
}

/** True when the catalog is as long as the wire allows, so a model the operator wants may be cut. */
export const catalogMayBeCut = (models: readonly string[], limit = ACP_TARGET_MODEL_LIMIT): boolean =>
	models.length >= limit;

/**
 * The target setting a model setting belongs to. Compaction runs on the orchestrator, so its model
 * is one of the chat target's.
 */
export const MODEL_TARGET_PATHS: Readonly<Record<string, string>> = {
	"chat.model": "chat.target",
	"fleet.default.model": "fleet.default.target",
	"context.memory.model": "context.memory.target",
	"context.compaction.model": "chat.target",
};

/** After a target change, keep the model only if the new target lists it; otherwise use its default. */
export function modelAfterTargetChange(model: string, models: readonly string[] | null): string {
	return model !== "" && models !== null && models.includes(model) ? model : "";
}
