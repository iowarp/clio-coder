import type { SessionSnapshot } from "../../contracts/sessions.js";

export type SessionControlRequest = Readonly<{
	sessionId: string;
	workspaceId: string;
	title: string;
	action: "stop" | "close";
	turnId: string | null;
	key: string;
	epoch: string | null;
	stage: "sending" | "unresolved" | "complete";
	message: string;
	restarted: boolean;
}>;

export function observedControlOutcome(request: SessionControlRequest, snapshot: SessionSnapshot): string | null {
	if (snapshot.id !== request.sessionId) return null;
	if (request.action === "close") return snapshot.state === "closed" ? "This session is closed." : null;
	const turn = snapshot.turns.find((row) => row.id === request.turnId);
	if (!turn || turn.status === "running") return null;
	return {
		succeeded: "The original turn finished before this refresh. It is no longer running.",
		failed: "The original turn failed. Open the session to review its result.",
		cancelled: "The original turn is stopped.",
	}[turn.status];
}

/** A route change or a card filter cannot discard an unresolved control request. */
export function createSessionControlStore() {
	let records: readonly SessionControlRequest[] = [];
	const listeners = new Set<() => void>();
	const publish = (next: readonly SessionControlRequest[]) => {
		records = next;
		for (const listener of listeners) listener();
	};
	return {
		read: () => records,
		subscribe: (listener: () => void) => {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		begin: (request: SessionControlRequest): boolean => {
			if (records.some((row) => row.sessionId === request.sessionId && row.stage !== "complete")) return false;
			const held = records.filter((row) => row.sessionId !== request.sessionId);
			if (held.length >= 64) {
				const settled = held.findIndex((row) => row.stage === "complete");
				if (settled < 0) throw new Error("Resolve one of the 64 retained session controls before starting another.");
				held.splice(settled, 1);
			}
			publish([...held, request]);
			return true;
		},
		patch: (key: string, update: Partial<Pick<SessionControlRequest, "stage" | "message" | "epoch" | "restarted">>) => {
			publish(records.map((row) => (row.key === key ? { ...row, ...update } : row)));
		},
		remove: (key: string) => publish(records.filter((row) => row.key !== key || row.stage === "sending")),
	};
}
