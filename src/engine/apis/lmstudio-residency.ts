/**
 * LM Studio-specific residency arithmetic, kept pure so the fit and duplicate
 * rules are testable without a server connection.
 *
 * LM Studio's `/api/v1/models` response exposes no total or free GPU memory,
 * and a GPU offload cap does not prove that a load fits
 * rather than failing an oversized load, so a request that does not fit is
 * served from CPU at a fraction of the speed instead of erroring. Fit therefore
 * cannot be computed from memory arithmetic; it is bounded by evidence.
 *
 * The evidence rule: while another model is resident on the same server, an
 * explicit load is capped at {@link CO_RESIDENT_CONTEXT_CEILING} tokens.
 * The KV cache of a long context is what actually overflows the card (measured
 * on an RTX 5090: a 27B Q4 model loaded at its 262,144-token default beside a
 * resident 26B model produced 25 tokens in 2m18s, and the same model at 131,072
 * answered a 9,019-token prompt in 9.7s). Operators who know their card holds
 * more raise the ceiling with CLIO_CODER_LMSTUDIO_CORESIDENT_CONTEXT; a target
 * serving one model alone is never clamped.
 */

/**
 * Largest automatic load context Clio requests while another model is resident
 * on the same LM Studio server.
 */
export const CO_RESIDENT_CONTEXT_CEILING = 131_072;

/** Operator override for {@link CO_RESIDENT_CONTEXT_CEILING}; 0 or `off` disables clamping. */
export function coResidentContextCeiling(env: NodeJS.ProcessEnv = process.env): number | undefined {
	const raw = (env.CLIO_CODER_LMSTUDIO_CORESIDENT_CONTEXT ?? "").trim().toLowerCase();
	if (raw.length === 0) return CO_RESIDENT_CONTEXT_CEILING;
	if (raw === "off" || raw === "0" || raw === "false") return undefined;
	const parsed = Number.parseInt(raw, 10);
	if (!Number.isFinite(parsed) || parsed <= 0) return CO_RESIDENT_CONTEXT_CEILING;
	return parsed;
}

/** One loaded instance as LM Studio reports it: a model key plus its instance identity. */
export interface LmStudioResidentInstance {
	modelKey: string;
	/** Per-instance identifier. Two instances of one model key differ here. */
	identifier?: string;
	sizeBytes?: number;
}

export interface ContextFitInput {
	/** Context length the load would otherwise request. */
	requested: number;
	/** Instances already resident on the target, including the requested model. */
	resident: ReadonlyArray<LmStudioResidentInstance>;
	/** Requested model's wire id, so its own instances are not counted as neighbours. */
	keepModelId: string;
	ceiling?: number | undefined;
}

export interface ContextFitResult {
	/** Context length to load with. */
	contextLength: number;
	/** Set when the ceiling lowered the request; carries the original value. */
	clampedFrom?: number;
	/** Model keys resident alongside the requested model. */
	neighbours: string[];
}

/**
 * Clamp a just-in-time load's context length to what the target has evidence of
 * holding. Only co-residency triggers the clamp: a server with nothing else
 * loaded gets the full requested window.
 */
export function fitLoadContextLength(input: ContextFitInput): ContextFitResult {
	const neighbours = [...new Set(input.resident.filter((e) => e.modelKey !== input.keepModelId).map((e) => e.modelKey))];
	const ceiling = input.ceiling;
	if (neighbours.length === 0 || ceiling === undefined || input.requested <= ceiling) {
		return { contextLength: input.requested, neighbours };
	}
	return { contextLength: ceiling, clampedFrom: input.requested, neighbours };
}
