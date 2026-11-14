import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import type { TrustSurface } from "../../contracts/review.js";
import { routes } from "../../contracts/runtime-routes.js";
import type { SessionTelemetry } from "../../contracts/session-telemetry.js";
import type { Client } from "../api/client.js";
import { TrustReview } from "./TrustReview.js";
import { ignoredSurfaces, TRUST_INTRO } from "./trust-model.js";
import "./artifacts.css";

export function ProjectTrustNotice({
	client,
	sessionId,
	running,
	trust,
}: {
	client: Client;
	sessionId: string;
	/** A turn is running in this task; trusting waits for it. */
	running: boolean;
	trust: SessionTelemetry["trust"];
}) {
	const [reviewing, setReviewing] = useState<TrustSurface | null>(null);
	// The pane already holds this task's snapshot; its workspace is read from there, never fetched here.
	const workspaceId = useQuery({
		queryKey: ["session", sessionId],
		queryFn: () => client.call(routes.session, { params: { id: sessionId }, query: {}, body: {} }),
		enabled: false,
		select: (session) => session.workspaceId,
	}).data;
	const groups = ignoredSurfaces(trust);
	if (!trust?.ignored.length) return null;
	return (
		<details className="project-trust">
			<summary>Project files were ignored</summary>
			<p>{TRUST_INTRO}</p>
			<ul>
				{groups.map((group) => (
					<li key={group.surface}>
						<span className="project-trust__file">{group.files.join(", ")}</span>
						<span>
							{group.surface} · {group.verdict.replaceAll("-", " ")}
						</span>
						<button
							type="button"
							className="project-trust__review"
							disabled={workspaceId === undefined}
							onClick={() => setReviewing(group.surface)}
							aria-label={`Review ${group.surface}`}
						>
							Review
						</button>
					</li>
				))}
			</ul>
			{reviewing !== null && workspaceId !== undefined ? (
				<TrustReview
					client={client}
					workspaceId={workspaceId}
					surface={reviewing}
					sessionId={sessionId}
					running={running}
					onClose={() => setReviewing(null)}
				/>
			) : null}
		</details>
	);
}
