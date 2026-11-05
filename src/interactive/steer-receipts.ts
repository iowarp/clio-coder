import type { TelemetryHub } from "../core/telemetry/hub.js";
import { wrapTextWithAnsi } from "../engine/tui.js";
import type { RunningDispatchRef } from "./editor-steer.js";
import { clioTheme, GLYPH } from "./theme/index.js";

type SteerState = "queued" | "received" | "undelivered";

interface SteerReceipt {
	runId: string;
	agentId: string;
	text: string;
	state: SteerState;
}

export interface SteerReceiptsDeps {
	bus: Pick<TelemetryHub, "subscribe">;
	append(render: (width: number) => string[], isLive: () => boolean): void;
	requestRender(): void;
}

export interface SteerReceipts {
	sent(run: RunningDispatchRef, text: string): void;
	dispose(): void;
}

function receiptRows(receipt: SteerReceipt, width: number): string[] {
	const theme = clioTheme();
	const head =
		receipt.state === "received"
			? theme.fg("success", `${GLYPH.ok} steer received by ${receipt.agentId}`)
			: receipt.state === "undelivered"
				? theme.fg("warning", `${GLYPH.warn} steer to ${receipt.agentId} not delivered: the run ended first`)
				: theme.fg("draftState", `${GLYPH.next} steer to ${receipt.agentId} · waiting for the worker to take it`);
	const gutter = `${theme.fg("border", "│")} `;
	const body = wrapTextWithAnsi(theme.fg("annotation", receipt.text), Math.max(4, width - 4)).map(
		(line) => `  ${gutter}${line}`,
	);
	return ["", ...wrapTextWithAnsi(head, Math.max(4, width)), ...body];
}

/**
 * A steer's own row in the transcript, updated in place as the worker takes it.
 * The footer notice this rides beside is outranked by any standing warning, so a
 * delivery the operator was waiting on could pass without ever being on screen.
 */
export function createSteerReceipts(deps: SteerReceiptsDeps): SteerReceipts {
	const pending: SteerReceipt[] = [];
	const settle = (runId: string, state: SteerState, all: boolean): void => {
		let changed = false;
		for (let index = 0; index < pending.length; ) {
			const receipt = pending[index];
			if (receipt?.runId !== runId) {
				index += 1;
				continue;
			}
			receipt.state = state;
			pending.splice(index, 1);
			changed = true;
			if (!all) break;
		}
		if (changed) deps.requestRender();
	};
	const unsubscribers = [
		deps.bus.subscribe("run.progressed", (payload) => {
			const event = payload.event as { type?: unknown } | null | undefined;
			// Delivery is in order, so an acknowledgement belongs to the oldest waiting steer.
			if (event?.type === "clio_coder_steer_received") settle(payload.runId, "received", false);
		}),
		deps.bus.subscribe("run.completed", (payload) => settle(payload.runId, "undelivered", true)),
		deps.bus.subscribe("run.failed", (payload) => settle(payload.runId, "undelivered", true)),
	];
	return {
		sent(run, text) {
			const receipt: SteerReceipt = { runId: run.runId, agentId: run.agentId, text, state: "queued" };
			pending.push(receipt);
			deps.append(
				(width) => receiptRows(receipt, width),
				() => receipt.state === "queued",
			);
			deps.requestRender();
		},
		dispose() {
			for (const unsubscribe of unsubscribers) unsubscribe();
		},
	};
}
