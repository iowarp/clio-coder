/** Sealed records written before 0.5.6 use these spellings. Keep them readable without rewriting their integrity-covered bytes. */
export const LEGACY_YOLO_IDS = {
	authorityBasis: "full-auto-policy",
	gateOutcome: "full-auto-applied",
	gateAuthority: "full-auto-gate-policy",
	gateReason: "full-auto-applied-winner",
	gateDetailPrefix: "full-auto applied ",
	councilApproval: "full-auto",
} as const;

export function normalizeYoloAuthorityBasis(value: unknown): unknown {
	return value === LEGACY_YOLO_IDS.authorityBasis ? "yolo-policy" : value;
}

export function normalizeYoloGateOutcome(value: unknown): unknown {
	return value === LEGACY_YOLO_IDS.gateOutcome ? "yolo-applied" : value;
}

export function normalizeYoloCouncilApproval(value: unknown): unknown {
	return value === LEGACY_YOLO_IDS.councilApproval ? "yolo" : value;
}

export function normalizeYoloGateAuthority(value: string): string {
	return value === LEGACY_YOLO_IDS.gateAuthority ? "yolo-gate-policy" : value;
}
