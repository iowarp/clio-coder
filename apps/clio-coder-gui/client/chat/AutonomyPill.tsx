import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import type { AgentCapabilities } from "../../contracts/capabilities.js";
import { routes } from "../../contracts/routes.js";
import type { Client } from "../api/client.js";
import { Icon } from "../design/icons.js";
import { useDetailsDismiss } from "../interaction/use-details-dismiss.js";

/** The two levels the agent reports, as the contract spells them. */
type AutonomyLevel = "default" | "yolo";

const LEVELS: Readonly<Record<AutonomyLevel, { label: string; short: string; lands: string; icon: "check" | "play" }>> =
	{
		default: {
			label: "Ask first",
			short: "Ask first",
			lands:
				"Reads, edits and recognised commands run. Unrecognised shell commands, plan-scale dispatch and anything that publishes outside the project wait for your approval.",
			icon: "check",
		},
		yolo: {
			label: "Run without asking",
			short: "Auto-run",
			lands: "Nothing waits for approval in this task. Clio runs commands and edits on its own judgement.",
			icon: "play",
		},
	};

/**
 * How much Clio may do without asking, for this task only. Turning approvals off takes a second,
 * explicit press, because the cost of a slip here is a command nobody saw.
 */
export function AutonomyPill({
	client,
	sessionId,
	capabilities,
	locked,
}: {
	client: Client;
	sessionId: string;
	capabilities: AgentCapabilities | undefined;
	/** A turn is running, so the level cannot change under it. */
	locked: boolean;
}) {
	const queries = useQueryClient();
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
		onSuccess: (value) => {
			queries.setQueryData(["session-autonomy", sessionId], value);
			setConfirming(false);
			if (panel.current) panel.current.open = false;
		},
	});
	if (!supported || !current.data) return null;
	const level = current.data.level;
	const meta = LEVELS[level];
	const choose = (next: AutonomyLevel) => {
		if (next === level) return;
		if (next === "yolo" && !confirming) setConfirming(true);
		else set.mutate(next);
	};
	return (
		<details
			className="autonomy"
			data-level={level}
			ref={panel}
			onToggle={(event) => {
				setOpen(event.currentTarget.open);
				if (!event.currentTarget.open) setConfirming(false);
			}}
		>
			<summary title={`${meta.label}. ${meta.lands}`}>
				<Icon name={meta.icon} />
				<span>{meta.short}</span>
				<Icon name="chevronDown" />
			</summary>
			<fieldset className="autonomy__panel">
				<legend className="autonomy__title">Working freedom for this task</legend>
				{(Object.keys(LEVELS) as AutonomyLevel[]).map((value) => (
					<button
						key={value}
						type="button"
						className="autonomy__option"
						aria-pressed={value === level}
						disabled={locked || set.isPending}
						onClick={() => choose(value)}
					>
						<Icon name={value === level ? "check" : LEVELS[value].icon} />
						<span>
							<strong>{LEVELS[value].label}</strong>
							<small>{LEVELS[value].lands}</small>
						</span>
					</button>
				))}
				{confirming ? (
					<div className="autonomy__confirm" role="alert">
						<p>
							Turn off approvals for this task? Clio will run commands and edits without asking. It lasts until the task
							closes.
						</p>
						<div>
							<button type="button" className="primary" disabled={set.isPending} onClick={() => set.mutate("yolo")}>
								{set.isPending ? "Turning off…" : "Turn off approvals"}
							</button>
							<button type="button" onClick={() => setConfirming(false)}>
								Keep asking
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
