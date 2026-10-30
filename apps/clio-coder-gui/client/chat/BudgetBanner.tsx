import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router";
import { routes } from "../../contracts/routes.js";
import type { BudgetBlock } from "../../contracts/session-telemetry.js";
import type { SessionSnapshot } from "../../contracts/sessions.js";
import type { Client } from "../api/client.js";
import { budgetBannerView } from "./budget-model.js";
import { ConversationBanner } from "./SessionStates.js";

/**
 * The session cost ceiling stop, above the transcript beside the approval banner: the turn is
 * waiting on the operator, and the raise is one click through the same settings write the
 * Settings page uses. The engine re-reads the ceiling while the request is parked, so the write
 * resumes the turn; the banner clears when that turn produces output (#424).
 */
export function BudgetBanner({ client, session }: { client: Client; session: SessionSnapshot }) {
	const budget = session.telemetry?.budget;
	if (budget === undefined) return null;
	// A new stop is a new decision, so the previous raise's outcome does not carry over.
	return (
		<BudgetStop
			key={`${budget.currentUsd}:${budget.ceilingUsd}:${budget.raiseToUsd}`}
			client={client}
			workspaceId={session.workspaceId}
			budget={budget}
		/>
	);
}

function BudgetStop({ client, workspaceId, budget }: { client: Client; workspaceId: string; budget: BudgetBlock }) {
	const queries = useQueryClient();
	const raise = useMutation({
		mutationFn: (body: { path: string; value: string }) =>
			client.call(routes.writeSetting, { params: { id: workspaceId }, query: {}, body }),
		onSuccess: () => {
			for (const stale of ["settings-controls", "workspace-settings", "config-graph"])
				void queries.invalidateQueries({ queryKey: [stale] });
		},
	});
	const view = budgetBannerView(budget, {
		raisedTo: raise.isSuccess ? raise.variables.value : null,
		error: raise.error?.message ?? null,
	});
	return (
		<ConversationBanner
			tone={view.tone}
			title={view.title}
			action={
				<span className="budget-banner__actions">
					{view.raise ? (
						<button
							type="button"
							disabled={raise.isPending}
							onClick={() => view.raise && raise.mutate({ path: view.raise.path, value: view.raise.value })}
						>
							{raise.isPending ? "Raising…" : view.raise.label}
						</button>
					) : null}
					<Link to={view.settingsHref}>Open setting</Link>
				</span>
			}
		>
			{view.detail}
		</ConversationBanner>
	);
}
