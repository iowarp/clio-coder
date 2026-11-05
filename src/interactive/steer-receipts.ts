import type { TelemetryHub } from "../core/telemetry/hub.js";
import { wrapTextWithAnsi } from "../engine/tui.js";
import type { RunningDispatchRef } from "./editor-steer.js";
import { clioTheme, GLYPH } from "./theme/index.js";

/**
 * Where a steer is: sent and not yet taken (`queued`), held by the worker for its next model call (`received`), in
 * the model's context (`delivered`), or lost because the run ended first, before the worker took it
 * (`undelivered`) or after it took it but before its model read it (`unread`).
 */
type SteerState = "queued" | "received" | "delivered" | "undelivered" | "unread";

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

function receiptHead(receipt: SteerReceipt): string {
	const theme = clioTheme();
	const who = receipt.agentId;
	switch (receipt.state) {
		case "delivered":
			return theme.fg("success", `${GLYPH.ok} ${who}'s model has your message`);
		case "received":
			return theme.fg("success", `${GLYPH.ok} ${who} took your message · its model reads it at its next step`);
		case "undelivered":
			return theme.fg("warning", `${GLYPH.warn} message to ${who} not delivered: the run ended before it took it`);
		case "unread":
			return theme.fg("warning", `${GLYPH.warn} ${who} took your message but stopped before its model read it`);
		default:
			return theme.fg("draftState", `${GLYPH.next} message to ${who} · waiting for the worker to take it`);
	}
}

function receiptRows(receipt: SteerReceipt, width: number): string[] {
	const theme = clioTheme();
	const gutter = `${theme.fg("border", "│")} `;
	const body = wrapTextWithAnsi(theme.fg("annotation", receipt.text), Math.max(4, width - 4)).map(
		(line) => `  ${gutter}${line}`,
	);
	return ["", ...wrapTextWithAnsi(receiptHead(receipt), Math.max(4, width)), ...body];
}

/** Whether a worker event is the steer entering its model's context: the user message carrying the steer's words. */
function carriesSteer(event: unknown, text: string): boolean {
	if (typeof event !== "object" || event === null) return false;
	const { type, message } = event as { type?: unknown; message?: { role?: unknown; content?: unknown } };
	if (type !== "message_end" || message?.role !== "user") return false;
	const content = message.content;
	const words =
		typeof content === "string"
			? content
			: Array.isArray(content)
				? content.map((block) => (typeof block?.text === "string" ? block.text : "")).join("\n")
				: "";
	return words.includes(text.trim());
}

/**
 * A steer's own row in the transcript, updated in place as the worker takes it.
 * The footer notice this rides beside is outranked by any standing warning, so a
 * delivery the operator was waiting on could pass without ever being on screen.
 */
export function createSteerReceipts(deps: SteerReceiptsDeps): SteerReceipts {
	const pending: SteerReceipt[] = [];
	const settle = (receipt: SteerReceipt, state: SteerState): void => {
		receipt.state = state;
		if (state !== "received") pending.splice(pending.indexOf(receipt), 1);
		deps.requestRender();
	};
	const forRun = (runId: string): SteerReceipt[] => pending.filter((receipt) => receipt.runId === runId);
	const unsubscribers = [
		deps.bus.subscribe("run.progressed", (payload) => {
			const event = payload.event as { type?: unknown } | null | undefined;
			// Delivery is in order, so an acknowledgement belongs to the oldest waiting steer.
			if (event?.type === "clio_coder_steer_received") {
				const oldest = forRun(payload.runId).find((receipt) => receipt.state === "queued");
				if (oldest !== undefined) settle(oldest, "received");
				return;
			}
			// A taken steer joins the model's context as a user message at the worker's next step.
			for (const receipt of forRun(payload.runId)) {
				if (receipt.state === "received" && carriesSteer(event, receipt.text)) settle(receipt, "delivered");
			}
		}),
		...(["run.completed", "run.failed", "run.aborted"] as const).map((topic) =>
			deps.bus.subscribe(topic, (payload: { runId: string }) => {
				for (const receipt of forRun(payload.runId))
					settle(receipt, receipt.state === "received" ? "unread" : "undelivered");
			}),
		),
	];
	return {
		sent(run, text) {
			const receipt: SteerReceipt = { runId: run.runId, agentId: run.agentId, text, state: "queued" };
			pending.push(receipt);
			deps.append(
				(width) => receiptRows(receipt, width),
				() => receipt.state === "queued" || receipt.state === "received",
			);
			deps.requestRender();
		},
		dispose() {
			for (const unsubscribe of unsubscribers) unsubscribe();
		},
	};
}
