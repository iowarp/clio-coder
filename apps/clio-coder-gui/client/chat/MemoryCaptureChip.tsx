import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { routes } from "../../contracts/runtime-routes.js";
import type { MemoryCapture } from "../../contracts/session-telemetry.js";
import type { SessionSnapshot } from "../../contracts/sessions.js";
import type { Client } from "../api/client.js";
import { memoryCaptureAfter, memoryChipView } from "./memory-capture-model.js";
import { ConversationBanner } from "./SessionStates.js";

/**
 * The chip for what the operator just told Clio to remember or forget: where it was kept, and the two
 * actions the terminal offers as `/remember scope` and `/remember undo`.
 */
export function MemoryCaptureChip({ client, session }: { client: Client; session: SessionSnapshot }) {
	const capture = session.telemetry?.memoryCapture;
	if (capture === undefined) return null;
	// A new capture, or a background reclassification of this one, is a new chip; a local outcome does not carry over.
	const key = `${capture.captureId}:${capture.action}:${capture.scope ?? ""}:${capture.kind ?? ""}`;
	return <CaptureChip key={key} client={client} sessionId={session.id} capture={capture} />;
}

function CaptureChip({ client, sessionId, capture }: { client: Client; sessionId: string; capture: MemoryCapture }) {
	const [shown, setShown] = useState(capture);
	const [dismissed, setDismissed] = useState(false);
	const act = useMutation({
		mutationFn: (argv: string[]) =>
			client.call(routes.invokeSessionCommand, {
				params: { id: sessionId },
				query: {},
				body: { command: "remember", argv },
			}),
		onSuccess: (result, argv) => setShown((current) => memoryCaptureAfter(current, argv, result.level !== "error")),
	});
	if (dismissed) return null;
	const view = memoryChipView(shown);
	return (
		<ConversationBanner
			tone="quiet"
			title={view.title}
			action={
				<span className="budget-banner__actions">
					{view.actions.map((action) => (
						<button
							key={action.argv.join(" ")}
							type="button"
							disabled={act.isPending}
							onClick={() => act.mutate(action.argv)}
						>
							{action.label}
						</button>
					))}
					<button type="button" onClick={() => setDismissed(true)}>
						Dismiss
					</button>
				</span>
			}
		>
			{act.error ? act.error.message : view.detail}
		</ConversationBanner>
	);
}
