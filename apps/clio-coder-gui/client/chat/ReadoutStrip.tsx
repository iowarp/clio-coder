import { memo } from "react";
import type { Client } from "../api/client.js";
import { readoutAnnouncement, readoutChips } from "./readouts-model.js";
import { useSessionTelemetry } from "./session-telemetry.js";
import "./readouts.css";

/**
 * The engine's live readouts in the top bar: yolo's confinement and window, the rate, the armed skills and a
 * provider retry. Only this strip reads `telemetry.readouts`, so a 4 Hz rate change re-renders it alone.
 */
export const ReadoutStrip = memo(function ReadoutStrip({
	client,
	sessionId,
	turnRunning,
}: {
	client: Client;
	sessionId: string;
	turnRunning: boolean;
}) {
	const chips = readoutChips(useSessionTelemetry(client, sessionId)?.readouts, turnRunning);
	if (chips.length === 0) return null;
	return (
		<span className="wb-readouts">
			{chips.map((chip) => (
				<span
					key={chip.key}
					className="wb-chip wb-readouts__chip"
					data-readout={chip.key}
					data-tone={chip.tone}
					data-dim={chip.dim ? "true" : undefined}
					data-essential={chip.essential ? "true" : undefined}
					title={chip.title ?? chip.text}
				>
					<span>{chip.text}</span>
				</span>
			))}
			<span className="sr-only" aria-live="polite">
				{readoutAnnouncement(chips)}
			</span>
		</span>
	);
});
