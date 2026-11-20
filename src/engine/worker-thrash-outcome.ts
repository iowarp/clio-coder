import { assistantMessageNeverSent } from "../core/assistant-model.js";
import type { WorkerTelemetryContext } from "../core/telemetry/context.js";
import { telemetryHub } from "../core/telemetry/hub.js";
import type { SurfaceOutcome, SurfaceSettled } from "../core/telemetry/schemas.js";
import { nextFiringId } from "../domains/middleware/fired-record.js";
import { callRepeatsAsRead } from "./loop-guard.js";
import type { AgentEvent, AgentMessage } from "./types.js";

/** Read-class calls after the host note with no write that settle it `ignored` (exploration design A4). */
const IGNORED_AFTER_READS = 10;

/**
 * The settlement of a worker's one thrash host note (exploration design 3.4 and A4, X4). No outcome ledger runs in a
 * worker, so the run settles this one firing itself, under its own run, and the record reaches the parent through
 * the run's telemetry forwarder like the firing row. The note is carried by the first request after it was steered that
 * the run really sent; from then a call that changed the workspace (the run effects recorder's `onWorkspaceChange`, so
 * never a write outside it or in a scratch root) settles it `acted` under that call, as does a final report; ten
 * read-class calls with no such change settle it `ignored`. A run that ends any other way after the note leaves it `moot`, and one that ends
 * before any request carried it leaves it `suppressed`.
 */
export interface ThrashOutcome {
	/** The firing id the thrash note's `middleware.fired` row carries; one per run. */
	fire(): string;
	/** Follow the run's events: the request that carried the note, then the read-class calls after it. */
	observe(event: AgentEvent): void;
	/** A successful call changed the workspace: an admitted note settles `acted` under that call. */
	changed(toolCallId: string): void;
	/** The run is over: settle the note if nothing did yet, from the run's last assistant message. */
	end(messages: ReadonlyArray<AgentMessage>): void;
}

export function createThrashOutcome(deps: { context: WorkerTelemetryContext | undefined }): ThrashOutcome {
	let firing: {
		id: string;
		admittedIn: string | null;
		admitted: boolean;
		settled: boolean;
		reads: number;
	} | null = null;
	const args = new Map<string, unknown>();
	const settle = (outcome: SurfaceOutcome, fact: SurfaceSettled["fact"]): void => {
		if (firing === null || firing.settled) return;
		firing.settled = true;
		if (deps.context === undefined) return;
		telemetryHub().emit(
			"surface.settled",
			{ firingId: firing.id, surface: "worker.thrash", admittedIn: firing.admittedIn, outcome, fact },
			deps.context,
		);
	};
	return {
		fire() {
			const id = nextFiringId();
			firing = { id, admittedIn: null, admitted: false, settled: false, reads: 0 };
			return id;
		},
		observe(event) {
			if (firing === null || firing.settled) return;
			if (event.type === "message_end" && event.message.role === "assistant" && !firing.admitted) {
				// A request the run never sent carried the note to no model; the one that is sent does.
				if (assistantMessageNeverSent(event.message)) return;
				firing.admitted = true;
				const callId = (event.message as { callId?: unknown }).callId;
				if (typeof callId === "string") firing.admittedIn = callId;
				return;
			}
			if (!firing.admitted) return;
			if (event.type === "tool_execution_start") args.set(event.toolCallId, event.args);
			if (event.type !== "tool_execution_end") return;
			const called = args.get(event.toolCallId);
			args.delete(event.toolCallId);
			if (event.isError) return;
			if (!callRepeatsAsRead(event.toolName, called, () => undefined)) return;
			firing.reads += 1;
			if (firing.reads >= IGNORED_AFTER_READS) settle("ignored", { kind: "none" });
		},
		changed(toolCallId) {
			if (firing?.admitted === true) settle("acted", { kind: "receipt", ref: toolCallId });
		},
		end(messages) {
			if (firing === null || firing.settled) return;
			if (!firing.admitted) {
				settle("suppressed", { kind: "none" });
				return;
			}
			const last = [...messages].reverse().find((message) => message.role === "assistant");
			const reported =
				last?.role === "assistant" &&
				last.stopReason === "stop" &&
				last.content.some((block) => block.type === "text" && block.text.trim().length > 0);
			if (reported) settle("acted", { kind: "declaration" });
			else settle("moot", { kind: "scope-end" });
		},
	};
}
