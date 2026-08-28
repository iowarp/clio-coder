/**
 * What a target advertised when it was asked, for runtimes with no static
 * catalog. `models` is the id list the probe returned and `resident` the
 * subset the server reports as loaded, when it reports load state at all.
 */
export interface LiveModelInventory {
	targetId: string;
	url?: string | undefined;
	models: ReadonlyArray<string>;
	resident: ReadonlyArray<string>;
}

export interface ValidateModelInput {
	runtimeId: string;
	modelId: string;
	knownModels: ReadonlyArray<string>;
	/**
	 * The live list, when one was fetched. It is consulted only when the static
	 * catalog is empty, so the catalog stays the authority for cloud runtimes
	 * and the probe becomes the authority where there is nothing else.
	 */
	live?: LiveModelInventory | undefined;
	force: boolean;
}

export type ValidateModelResult =
	| { ok: true; warning?: string }
	| { ok: false; reason: string; knownModels: ReadonlyArray<string> };

const SAMPLE_SIZE = 10;

function sample(models: ReadonlyArray<string>): string {
	const shown = models.slice(0, SAMPLE_SIZE).join(", ");
	return models.length > SAMPLE_SIZE ? `${shown}, …` : shown;
}

function describeLiveTarget(live: LiveModelInventory): string {
	return live.url ? `target '${live.targetId}' at ${live.url}` : `target '${live.targetId}'`;
}

/** The refusal `configure` prints for a model the live target does not advertise. */
export function formatUnadvertisedModelReason(modelId: string, live: LiveModelInventory): string {
	const resident = live.resident.length > 0 ? live.resident.join(", ") : "none";
	return (
		`${describeLiveTarget(live)} does not advertise model '${modelId}'. ` +
		`Advertised (${live.models.length}): ${sample(live.models)}. Resident instances: ${resident}. ` +
		"Pass one of the advertised ids with --model, or --force to save a model the target cannot serve."
	);
}

export function validateModelChoice(input: ValidateModelInput): ValidateModelResult {
	const { runtimeId, modelId, knownModels, live, force } = input;
	if (knownModels.length === 0) return validateAgainstLive(modelId, live, force);
	if (knownModels.includes(modelId)) return { ok: true };
	if (force) {
		return {
			ok: true,
			warning: `model '${modelId}' not in ${runtimeId} catalog (use without --force to reject)`,
		};
	}
	return {
		ok: false,
		reason: `model '${modelId}' not in ${runtimeId} catalog. Known: ${sample(knownModels)}. Use --force to skip validation.`,
		knownModels: knownModels.slice(0, SAMPLE_SIZE),
	};
}

/**
 * With no catalog, the live list is the only evidence there is. An empty
 * catalog used to be an early `ok` on its own, which is how a placeholder id
 * was written next to the very list that ruled it out.
 */
function validateAgainstLive(
	modelId: string,
	live: LiveModelInventory | undefined,
	force: boolean,
): ValidateModelResult {
	if (!live || live.models.length === 0) return { ok: true };
	if (live.models.includes(modelId)) return { ok: true };
	const reason = formatUnadvertisedModelReason(modelId, live);
	if (force) return { ok: true, warning: `${reason.replace(/ Pass one of.*$/u, "")} Saved anyway because of --force.` };
	return { ok: false, reason, knownModels: live.models.slice(0, SAMPLE_SIZE) };
}
