import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import type { AgentCapabilities } from "../../contracts/capabilities.js";
import { routes } from "../../contracts/runtime-routes.js";
import type { SessionSnapshot } from "../../contracts/sessions.js";
import type { Client } from "../api/client.js";
import { Icon } from "../design/icons.js";
import { useDetailsDismiss } from "../interaction/use-details-dismiss.js";
import { useMenuShortcut } from "../interaction/use-shortcut.js";
import { type AutonomyLevel, autonomyMenu, currentAutonomy, UNRECOGNIZED_MODE_NOTE } from "./autonomy-model.js";
import { useSessionTelemetry } from "./session-telemetry.js";

const LEVELS: Readonly<Record<AutonomyLevel, { label: string; short: string; icon: "shield" | "bolt" }>> = {
	default: { label: "Ask first", short: "Ask first", icon: "shield" },
	yolo: { label: "Run without approvals", short: "Auto-run", icon: "bolt" },
};

/**
 * How much CLIO Coder may do without stopping for you, for this task only. Each mode reads as the
 * engine describes it. Running without approvals takes a second, explicit press; questions still reach you either way.
 */
export function AutonomyPill({
	client,
	sessionId,
	capabilities,
	locked,
	chord,
}: {
	client: Client;
	sessionId: string;
	capabilities: AgentCapabilities | undefined;
	/** A turn is running, so the level cannot change under it. */
	locked: boolean;
	/** Alt+Y opens the menu; false while the task is not open. */
	chord: boolean;
}) {
	const queries = useQueryClient();
	const pushed = useSessionTelemetry(client, sessionId)?.autonomy;
	const panel = useRef<HTMLDetailsElement>(null);
	const [open, setOpen] = useState(false);
	const [confirming, setConfirming] = useState(false);
	useDetailsDismiss(panel, open);
	const supported = capabilities?.session?.autonomy === true;
	const current = useQuery({
		queryKey: ["session-autonomy", sessionId],
		queryFn: () => client.call(routes.sessionAutonomy, { params: { id: sessionId }, query: {}, body: {} }),
		enabled: supported,
		retry: false,
	});
	const set = useMutation({
		mutationFn: (level: AutonomyLevel) =>
			client.call(routes.setSessionAutonomy, { params: { id: sessionId }, query: {}, body: { level } }),
		onSuccess: () => {
			// Runtime notifications may already report a newer choice than this delayed acknowledgement.
			const reported = () => queries.getQueryData<SessionSnapshot>(["session", sessionId])?.telemetry?.autonomy;
			if (!reported()) {
				const queryKey = ["session-autonomy", sessionId];
				void queries.cancelQueries({ queryKey }).then(() => {
					if (!reported()) return queries.invalidateQueries({ queryKey });
				});
			}
			setConfirming(false);
			if (panel.current) panel.current.open = false;
		},
	});
	useMenuShortcut("autonomyMenu", panel, open, setOpen, { enabled: chord && supported && !!current.data });
	if (!supported || !current.data) return null;
	const autonomy = currentAutonomy(current.data, pushed);
	const level = autonomy.level;
	const menu = autonomyMenu(autonomy);
	const selected = menu.rows.find((row) => row.current);
	const meta =
		menu.unrecognized !== undefined
			? {
					title: `Mode: ${menu.unrecognized}. ${UNRECOGNIZED_MODE_NOTE}`,
					short: `Mode: ${menu.unrecognized}`,
					icon: "shield" as const,
				}
			: {
					title: `${LEVELS[level].label}. ${selected?.description ?? ""}`,
					short: LEVELS[level].short,
					icon: LEVELS[level].icon,
				};
	const choose = (next: AutonomyLevel) => {
		if (menu.unrecognized !== undefined || next === level) return;
		if (next === "yolo" && !confirming) setConfirming(true);
		else set.mutate(next);
	};
	return (
		<details
			className="autonomy"
			data-level={menu.unrecognized !== undefined ? "unrecognized" : level}
			ref={panel}
			onToggle={(event) => {
				setOpen(event.currentTarget.open);
				if (!event.currentTarget.open) setConfirming(false);
			}}
		>
			<summary title={meta.title}>
				<Icon name={meta.icon} />
				<span>{meta.short}</span>
				<Icon name="chevronDown" />
			</summary>
			<fieldset className="autonomy__panel">
				<legend className="autonomy__title">Working freedom for this task</legend>
				{menu.rows.map((row) => (
					<button
						key={row.level}
						type="button"
						className="autonomy__option"
						aria-pressed={row.current}
						disabled={locked || set.isPending || row.disabled}
						onClick={() => choose(row.level)}
					>
						<Icon name={row.current ? "check" : LEVELS[row.level].icon} />
						<span>
							<strong>{LEVELS[row.level].label}</strong>
							{/* Engine text renders as plain text, never as markup. */}
							<small>{row.description}</small>
						</span>
					</button>
				))}
				{menu.unrecognized !== undefined ? <p className="autonomy__note">{UNRECOGNIZED_MODE_NOTE}</p> : null}
				{confirming && menu.unrecognized === undefined ? (
					<div className="autonomy__confirm" role="alert">
						<p>{menu.confirmation}</p>
						<div>
							<button type="button" className="primary" disabled={set.isPending} onClick={() => set.mutate("yolo")}>
								{set.isPending ? "Switching…" : "Run without approvals"}
							</button>
							<button type="button" onClick={() => setConfirming(false)}>
								Keep approvals
							</button>
						</div>
					</div>
				) : null}
				{locked ? <p className="autonomy__note">You can change this when the current turn finishes.</p> : null}
				{set.error ? (
					<p className="autonomy__note" role="alert">
						{set.error.message}
					</p>
				) : null}
			</fieldset>
		</details>
	);
}
