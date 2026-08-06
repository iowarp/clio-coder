export interface EvalChaosMarker {
	seed: number;
	faultInjected: boolean;
	exitCode: number;
	orphanedChildren: number;
}

export interface EvalChaosObservation {
	markerCount: number;
	marker: EvalChaosMarker | null;
}

export interface EvalChaosFold {
	/** Feed a raw stdout chunk; partial trailing lines are held until completed. */
	push(chunk: string): void;
	observation(): EvalChaosObservation;
}

export const EMPTY_CHAOS_OBSERVATION: EvalChaosObservation = { markerCount: 0, marker: null };

/** Fold the SIGINT harness marker from stdout before bounded artifact truncation can erase it. */
export function createChaosFold(): EvalChaosFold {
	let markerCount = 0;
	let marker: EvalChaosMarker | null = null;
	let pending = "";

	const consume = (line: string): void => {
		if (line.trim().length === 0) return;
		let parsed: unknown;
		try {
			parsed = JSON.parse(line) as unknown;
		} catch {
			return;
		}
		if (!isRecord(parsed) || parsed.type !== "clio_soak_chaos") return;
		markerCount += 1;
		marker = parseChaosMarker(parsed);
	};

	return {
		push(chunk: string): void {
			pending += chunk;
			for (;;) {
				const newline = pending.indexOf("\n");
				if (newline === -1) break;
				consume(pending.slice(0, newline).replace(/\r$/u, ""));
				pending = pending.slice(newline + 1);
			}
		},
		observation(): EvalChaosObservation {
			if (pending.length > 0) {
				consume(pending.replace(/\r$/u, ""));
				pending = "";
			}
			return { markerCount, marker: marker === null ? null : { ...marker } };
		},
	};
}

export function addChaosObservations(left: EvalChaosObservation, right: EvalChaosObservation): EvalChaosObservation {
	const markerCount = left.markerCount + right.markerCount;
	return {
		markerCount,
		marker: markerCount === 1 ? (left.marker ?? right.marker) : null,
	};
}

/** Emit canonical metrics only for one fully valid marker; every other shape is unmeasured. */
export function chaosMetricEntries(observation: EvalChaosObservation): Record<string, number | boolean> {
	if (observation.markerCount !== 1 || observation.marker === null) return {};
	return {
		"chaos.seed": observation.marker.seed,
		"chaos.faultInjected": observation.marker.faultInjected,
		"chaos.exitCode": observation.marker.exitCode,
		"process.orphanedChildren": observation.marker.orphanedChildren,
	};
}

export function parseChaosMarker(event: Record<string, unknown>): EvalChaosMarker | null {
	if (event.type !== "clio_soak_chaos") return null;
	const { seed, faultInjected, exitCode, orphanedChildren } = event;
	if (!isFiniteInteger(seed) || typeof faultInjected !== "boolean" || !isFiniteInteger(exitCode)) return null;
	if (!isFiniteInteger(orphanedChildren) || orphanedChildren < 0) return null;
	return { seed, faultInjected, exitCode, orphanedChildren };
}

function isFiniteInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && Number.isInteger(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
