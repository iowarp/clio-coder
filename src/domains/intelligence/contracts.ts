/**
 * Shape-only declarations for the intelligence domain. v0.1 ships the domain
 * disabled; the types exist so later slices + TUI overlays can type against
 * them without a refactor.
 */

export type IntentKind = "compose" | "edit" | "investigate" | "idle";

export interface IntentObservation {
	at: number;
	kind: IntentKind;
	confidence: number;
	hints: ReadonlyArray<string>;
}

export interface IntentEvent {
	observation: IntentObservation;
	sessionId: string | null;
	turnId: string | null;
}

export interface IntelligenceContract {
	enabled(): boolean;
	/** Synchronously returns the latest observations collected. Empty when disabled. */
	observations(): ReadonlyArray<IntentObservation>;
}
