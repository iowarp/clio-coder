/**
 * Result of an operator-initiated attach to detach conversion. The message is
 * the line the keypress feedback renders, so a refusal names the topology that
 * refused rather than reading as a dropped key.
 */
export type DispatchBackgroundOutcome = { ok: true; message: string } | { ok: false; message: string };

export interface DispatchBackgroundControl {
	/** Tool call the control belongs to; one attached dispatch owns one control. */
	toolCallId: string;
	/** Operator-facing name of the call, used in both outcome messages. */
	label: string;
	convert(): DispatchBackgroundOutcome;
}

/**
 * Live attached dispatches that the operator may send to the background. An
 * attached `dispatch` call registers one control for as long as it awaits its
 * runs; the TUI keybinding fires the newest one. Absent from a deps bundle
 * (workers, headless) nothing registers and attached dispatch behaves exactly
 * as it did before.
 */
export interface DispatchBackgroundRegistry {
	/** Returns the deregistration handle; calling it more than once is harmless. */
	register(control: DispatchBackgroundControl): () => void;
	/** Fire the newest still-registered control. */
	backgroundNewest(): DispatchBackgroundOutcome;
	/** How many attached dispatches are currently registered. */
	size(): number;
}

export function createDispatchBackgroundRegistry(): DispatchBackgroundRegistry {
	// Map insertion order is registration order, and the newest attached dispatch
	// is the one the operator just watched start, so the keypress takes the last
	// entry rather than asking a UI projection which segment is newest.
	const controls = new Map<string, DispatchBackgroundControl>();
	return {
		register(control) {
			controls.set(control.toolCallId, control);
			return () => {
				if (controls.get(control.toolCallId) === control) controls.delete(control.toolCallId);
			};
		},
		backgroundNewest() {
			let newest: DispatchBackgroundControl | undefined;
			for (const control of controls.values()) newest = control;
			if (newest === undefined) {
				return { ok: false, message: "background: no attached dispatch is running" };
			}
			return newest.convert();
		},
		size: () => controls.size,
	};
}
