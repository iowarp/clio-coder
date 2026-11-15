/**
 * Who started a submitted turn, as hooks and observers read it. An extension
 * that keeps run state across a prompt template's turns needs to tell an
 * operator's new prompt from Clio's own continuation of a stopped turn: both
 * fire prompt_submit, turn_start and turn_end, and a continuation still runs
 * under the template's tool scope (WTF-P campaign, 2026-11-15).
 */
export type TurnOriginKind = "operator" | "continuation" | "job" | "peer";

export interface TurnOrigin {
	origin: TurnOriginKind;
	/** A yolo continuation's place against its cap; the first continuation is 1. */
	continuation?: { index: number; cap: number };
	/** The prompt template whose tool scope bounds the turn, when one does. */
	template?: string;
}

type ScalarMetadata = Record<string, string | number | boolean>;

/** Flattened onto middleware metadata, which carries scalars only. */
export function turnOriginMetadata(origin: TurnOrigin | null): ScalarMetadata {
	if (origin === null) return {};
	return {
		turnOrigin: origin.origin,
		...(origin.continuation === undefined
			? {}
			: { turnContinuationIndex: origin.continuation.index, turnContinuationCap: origin.continuation.cap }),
		...(origin.template === undefined ? {} : { turnTemplate: origin.template }),
	};
}

export function turnOriginFromMetadata(metadata: Readonly<Record<string, unknown>> | undefined): TurnOrigin | null {
	const kind = metadata?.turnOrigin;
	if (kind !== "operator" && kind !== "continuation" && kind !== "job" && kind !== "peer") return null;
	const index = metadata?.turnContinuationIndex;
	const cap = metadata?.turnContinuationCap;
	const template = metadata?.turnTemplate;
	return {
		origin: kind,
		...(typeof index === "number" && typeof cap === "number" ? { continuation: { index, cap } } : {}),
		...(typeof template === "string" && template.length > 0 ? { template } : {}),
	};
}
