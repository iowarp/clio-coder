import type { ScrollPosition } from "../render/follow-latest.js";
import type { ChatTurn } from "./turns.js";

export const TRANSCRIPT_PAGE_SIZE = 24;
export type TranscriptView = ScrollPosition & { startTurnId: string | null };

/** Keep the displayed start anchored as later turns arrive; search still reads the complete projection. */
export function transcriptStart(turns: readonly ChatTurn[], startTurnId: string | null): number {
	const held = startTurnId === null ? -1 : turns.findIndex((turn) => turn.turnId === startTurnId);
	return held < 0 ? Math.max(0, turns.length - TRANSCRIPT_PAGE_SIZE) : held;
}

/** Reading position is local to this window and cannot carry across a runtime or branch replacement. */
export function createTranscriptViewStore() {
	const views = new Map<string, { scope: number; view: TranscriptView }>();
	return {
		read: (id: string, scope: number) => {
			const saved = views.get(id);
			return saved?.scope === scope ? saved.view : undefined;
		},
		remember: (id: string, scope: number, view: TranscriptView) => {
			views.delete(id);
			if (views.size >= 32) views.delete(views.keys().next().value ?? "");
			views.set(id, { scope, view });
		},
	};
}
