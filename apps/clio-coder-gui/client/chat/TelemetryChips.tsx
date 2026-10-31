import { memo } from "react";
import type { SessionSnapshot } from "../../contracts/sessions.js";
import type { Client } from "../api/client.js";
import { Explained } from "../telemetry/Explained.js";
import { contextMeter } from "./overview-model.js";
import type { PaneView } from "./pane-model.js";
import {
	settledTurns,
	useContextLedger,
	useSessionCapabilities,
	useSessionTelemetry,
	useSessionUsage,
	useTelemetrySession,
} from "./session-telemetry.js";
import type { Spend } from "./session-usage-model.js";
import { sessionSpend, tokensText } from "./session-usage-model.js";

const RING = 2 * Math.PI * 6;
const SOURCE_TITLE: Record<Spend["source"], string> = {
	telemetry: "The read model's figures for this chat",
	none: "The recorded cost for this chat",
};

/**
 * The top bar's live readout: how full the window is and what the chat has spent. Each chip opens the
 * pane on the view that explains it. The figures are the ones the pane shows, from the same reads.
 */
export const TelemetryChips = memo(function TelemetryChips({
	client,
	sessionId,
	state,
	turns,
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
	const usage = useSessionUsage(client, sessionId, settled, open && !!capabilities.data?.telemetry);
	const telemetry = useSessionTelemetry(client, sessionId);
	// The live hint's ledger carries the same server displays as the ledger read (#434).
	const live = telemetry?.usage?.context;
	const meter = ledger.data ? contextMeter(ledger.data) : live ? contextMeter(live) : null;
	const cold = useTelemetrySession(client, sessionId, true);
	const context = telemetry?.usage?.session?.context ?? cold.data?.context;
	const spend = sessionSpend({
		usage: usage.data,
		live: turns.at(-1)?.status === "running" || !usage.data || usage.isPlaceholderData ? telemetry?.usage : undefined,
		cold: cold.data,
	});
	const contextId = `${sessionId}-chip-context`;
	const spendId = `${sessionId}-chip-spend`;
	return (
		<>
			{meter ? (
				<div id={contextId} className="wb-chip wb-chip--meter" data-tone={meter.tone}>
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
					<Explained
						client={client}
						label="Context share"
						value={context?.share.display ?? "not journaled"}
						factRef={context?.share.ref ?? null}
					/>
				</div>
			) : null}
			{spend.cost || spend.tokens !== null ? (
				<div id={spendId} className="wb-chip wb-chip--figure" title={SOURCE_TITLE[spend.source]}>
					{spend.tokens !== null ? (
						<Explained client={client} label="Tokens" value={tokensText(spend.tokens, "tok")} factRef={spend.refs.tokens} />
					) : null}
					{spend.cost ? <Explained client={client} label="Cost" value={spend.cost} factRef={spend.refs.cost} /> : null}
				</div>
			) : null}
		</>
	);
});
