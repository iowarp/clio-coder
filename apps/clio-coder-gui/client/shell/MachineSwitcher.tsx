import { useRef, useState } from "react";
import type { Client } from "../api/client.js";
import { Icon } from "../design/icons.js";
import { TONE_GLYPHS } from "../design/status.js";
import { useDetailsDismiss } from "../interaction/use-details-dismiss.js";
import { attachmentStatus, machineChoices, machineDestination, switcherLabel } from "./machine-switcher-model.js";
import { useMachineAttach } from "./use-machine-attach.js";

/**
 * Which machine's app this window shows. The list always comes from the app on this machine, so it
 * is the same whichever node the window is looking at; choosing a node starts its own GUI over SSH
 * when needed and then leaves for it.
 */
export function MachineSwitcher({
	local,
	current,
	remoteHost,
}: {
	local: Client;
	/** The registered node this window shows, or null for this machine. */
	current: string | null;
	remoteHost: string | undefined;
}) {
	const { attachments, error, loading, pending, open } = useMachineAttach(local);
	const ref = useRef<HTMLDetailsElement>(null);
	const [opened, setOpened] = useState(false);
	useDetailsDismiss(ref, opened);
	const choices = machineChoices(attachments, current);
	const label = switcherLabel(current, remoteHost);
	return (
		<details className="wb-menu wb-machine" ref={ref} onToggle={(event) => setOpened(event.currentTarget.open)}>
			<summary className="wb-action" aria-label={`Machine: ${label}. Switch machine`} title="Switch machine">
				<Icon name="system" />
				<span className="wb-machine__label">{label}</span>
				<Icon name="chevronDown" />
			</summary>
			{/* biome-ignore lint/a11y/useKeyWithClickEvents: the click only closes the menu after an item, whose own button handles the keyboard. */}
			<div
				className="wb-menu__panel wb-machine__panel"
				role="menu"
				aria-label="Machines"
				onClick={(event) => {
					if (event.target instanceof Element && event.target.closest('[role="menuitem"]') && ref.current)
						ref.current.open = false;
				}}
			>
				{choices.map((choice) => {
					const status = attachmentStatus(pending === choice.id ? "connecting" : choice.state);
					return (
						<button
							type="button"
							role="menuitem"
							className="wb-menu__item wb-machine__item"
							key={choice.id}
							aria-current={choice.current ? "true" : undefined}
							disabled={choice.current || pending !== null}
							title={choice.detail ?? undefined}
							onClick={() => {
								if (choice.state === "local" || choice.state === "ready")
									window.location.assign(machineDestination(choice.state === "local" ? null : choice.id));
								else open(choice.id);
							}}
						>
							<Icon name={choice.current ? "check" : "system"} />
							<span className="wb-machine__choice">
								<strong>{choice.label}</strong>
								<small>
									{choice.host ? `${choice.host} · ` : ""}
									<span data-tone={status.tone}>
										<span aria-hidden="true">{TONE_GLYPHS[status.tone]}</span> {status.label}
									</span>
								</small>
							</span>
						</button>
					);
				})}
				{loading ? <p className="wb-note">Reading machines…</p> : null}
				{error ? (
					<p className="wb-note" role="alert">
						Machines unavailable.
					</p>
				) : null}
				{!loading && !error && attachments.length === 0 ? (
					<p className="wb-note">No registered machines yet. Add one under Machines.</p>
				) : null}
			</div>
		</details>
	);
}
