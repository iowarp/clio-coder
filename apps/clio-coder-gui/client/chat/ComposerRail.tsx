import { memo } from "react";
import type { SessionSnapshot } from "../../contracts/sessions.js";
import type { Client } from "../api/client.js";
import { compactCount, contextMeter } from "./overview-model.js";
import { usePaneActions } from "./pane-context.js";
import {
	sessionSpend,
	settledTurns,
	useContextLedger,
	useSessionCapabilities,
	useSessionUsage,
} from "./session-telemetry.js";
import "./composer-rail.css";

/**
 * One quiet line under the composer: how full the window is and what the chat has used, where the
 * operator's eyes already are while writing. The model is the route picker's, inside the composer, so
 * it is not repeated here. Each figure opens the pane on the view that explains it.
 */
export const ComposerRail = memo(function ComposerRail({
	client,
	sessionId,
	state,
	turns,
}: {
	client: Client;
	sessionId: string;
	state: SessionSnapshot["state"];
	turns: SessionSnapshot["turns"];
}) {
	const pane = usePaneActions();
	const open = state === "open";
	const capabilities = useSessionCapabilities(client, sessionId, open);
	const settled = settledTurns(turns);
	const ledger = useContextLedger(client, sessionId, settled, open && !!capabilities.data?.context);
	const usage = useSessionUsage(client, sessionId, settled, open && !!capabilities.data?.usage);
	const meter = ledger.data ? contextMeter(ledger.data) : null;
	const spend = sessionSpend(turns, usage.data);
	if (!meter && spend.tokens === 0 && spend.cost === null) return null;
	const segment = (view: "context" | "usage") => (pane ? { onClick: () => pane.show(view) } : { disabled: true });
	return (
		<nav className="composer-rail" aria-label="This chat's context and usage">
			{meter ? (
				<button
					type="button"
					className="composer-rail__item"
					data-tone={meter.tone}
					title={meter.text}
					{...segment("context")}
				>
					<span className="composer-rail__bar" aria-hidden="true">
						<span style={{ width: `${meter.percent}%` }} />
					</span>
					<span>
						{Math.round(meter.percent)}% of {compactCount(ledger.data?.contextWindow ?? 0)}
					</span>
					<span className="sr-only">context window used</span>
				</button>
			) : null}
			{spend.tokens > 0 || spend.cost ? (
				<button
					type="button"
					className="composer-rail__item"
					title={spend.source === "clio" ? "Clio's accounting for this chat" : "Summed from this chat's turns"}
					{...segment("usage")}
				>
					{spend.tokens > 0 ? <span>{compactCount(spend.tokens)} tokens</span> : null}
					{spend.cost ? <span>{spend.cost}</span> : null}
				</button>
			) : null}
		</nav>
	);
});
