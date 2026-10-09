import { memo } from "react";
import type { SessionSnapshot } from "../../contracts/sessions.js";
import type { Client } from "../api/client.js";
import { compactCount, contextMeter } from "./overview-model.js";
import type { PaneView } from "./pane-model.js";
import {
	settledTurns,
	useContextLedger,
	useSessionCapabilities,
	useSessionTelemetry,
	useSessionUsage,
} from "./session-telemetry.js";
import { sessionSpend } from "./session-usage-model.js";

const RING = 2 * Math.PI * 6;

/**
 * The top bar's live readout: how full the window is and what the chat has spent. Each chip opens the
 * pane on the view that explains it. The figures are the ones the pane shows, from the same reads.
 */
export const TelemetryChips = memo(function TelemetryChips({
	client,
	sessionId,
	state,
	turns,
	onOpen,
}: {
	client: Client;
	sessionId: string;
	state: SessionSnapshot["state"];
	turns: SessionSnapshot["turns"];
	onOpen: (view: PaneView, trigger: string) => void;
}) {
	const open = state === "open";
	const capabilities = useSessionCapabilities(client, sessionId, open);
	const settled = settledTurns(turns);
	const ledger = useContextLedger(client, sessionId, settled, open && !!capabilities.data?.context);
	const usage = useSessionUsage(client, sessionId, settled, open && !!capabilities.data?.usage);
	const telemetry = useSessionTelemetry(client, sessionId);
	const meter = ledger.data
		? contextMeter(ledger.data)
		: telemetry?.usage
			? contextMeter({
					usedTokens: telemetry.usage.used,
					contextWindow: telemetry.usage.size,
					percent: null,
					measured: null,
				})
			: null;
	const spend = sessionSpend(
		turns,
		usage.data,
		turns.at(-1)?.status === "running" || !usage.data || usage.isPlaceholderData ? telemetry?.usage : undefined,
	);
	const contextId = `${sessionId}-chip-context`;
	const spendId = `${sessionId}-chip-spend`;
	return (
		<>
			{meter ? (
				<button
					id={contextId}
					type="button"
					className="wb-chip wb-chip--meter"
					data-tone={meter.tone}
					aria-label={`${meter.text}. Open the context window.`}
					title={meter.text}
					onClick={() => onOpen("context", contextId)}
				>
					<svg className="wb-ring" viewBox="0 0 16 16" aria-hidden="true">
						<circle cx="8" cy="8" r="6" className="wb-ring__track" />
						<circle
							cx="8"
							cy="8"
							r="6"
							className="wb-ring__fill"
							strokeDasharray={`${(meter.percent / 100) * RING} ${RING}`}
						/>
					</svg>
					<span>{Math.round(meter.percent)}%</span>
				</button>
			) : null}
			{spend.cost || spend.tokens > 0 || spend.missingTokenCalls ? (
				<button
					id={spendId}
					type="button"
					className="wb-chip wb-chip--figure"
					aria-label={`${spend.tokens.toLocaleString("en-US")} tokens${spend.cost ? ` · ${spend.cost}` : ""}. Open usage.`}
					title={spend.source === "clio" ? "Clio's accounting for this chat" : "Summed from this chat's turns"}
					onClick={() => onOpen("usage", spendId)}
				>
					<span className="wb-chip__tokens">
						{compactCount(spend.tokens)} tok
						{spend.missingTokenCalls
							? ` +? (${spend.missingTokenCalls} call${spend.missingTokenCalls === 1 ? "" : "s"})`
							: ""}
					</span>
					{spend.cost ? <span>{spend.cost}</span> : null}
				</button>
			) : null}
		</>
	);
});
