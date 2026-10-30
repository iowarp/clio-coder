// Decisions for the machine switcher and the Open action on Machines, kept free of React so
// node:test can exercise every branch. A view of a registered node's own GUI lives under
// `/m/<id>/`; switching is a document navigation, so nothing cached for one machine survives
// into another.

import type { MachineAttachment, MachineAttachmentState } from "../../contracts/machines.js";

export type AttachTone = "neutral" | "running" | "success" | "warn" | "fail";

export interface MachineChoice {
	readonly id: string;
	readonly label: string;
	readonly host: string;
	readonly state: MachineAttachmentState | "local";
	readonly detail: string | null;
	readonly current: boolean;
}

/** The app on this machine first, then every registered node by id. */
export function machineChoices(attachments: readonly MachineAttachment[], current: string | null): MachineChoice[] {
	return [
		{ id: "local", label: "This machine", host: "", state: "local", detail: null, current: current === null },
		...[...attachments]
			.sort((a, b) => a.id.localeCompare(b.id))
			.map(
				(attachment): MachineChoice => ({
					id: attachment.id,
					label: attachment.id,
					host: attachment.host,
					state: attachment.state,
					detail: attachment.detail,
					current: attachment.id === current,
				}),
			),
	];
}

export function attachmentStatus(state: MachineAttachmentState | "local"): { label: string; tone: AttachTone } {
	switch (state) {
		case "local":
			return { label: "Here", tone: "neutral" };
		case "connecting":
			return { label: "Connecting…", tone: "running" };
		case "ready":
			return { label: "Connected", tone: "success" };
		case "failed":
			return { label: "Failed", tone: "fail" };
		case "version-mismatch":
			return { label: "Version mismatch", tone: "warn" };
		default:
			return { label: "Not connected", tone: "neutral" };
	}
}

/** Where the app for a machine opens: the root for this machine, the node prefix for a registered node. */
export function machineDestination(id: string | null): string {
	return id === null || id === "local" ? "/" : `/m/${encodeURIComponent(id)}/`;
}

/** What the switcher shows: a remote view always carries the node's own label from its meta. */
export function switcherLabel(current: string | null, remoteHost: string | undefined): string {
	if (current === null) return "This machine";
	return remoteHost && remoteHost !== current ? `${current} · ${remoteHost}` : current;
}

/** The command that puts this build on a node that refused for its version; null in every other state. */
export function attachInstallCommand(attachment: Pick<MachineAttachment, "id" | "state">): string | null {
	return attachment.state === "version-mismatch" ? `clio-coder fleet nodes install ${attachment.id} --yes` : null;
}

/** Whether a list is still moving and worth re-reading on a short interval. */
export function attachmentsSettling(attachments: readonly MachineAttachment[]): boolean {
	return attachments.some(
		(attachment) => attachment.state === "connecting" || (attachment.state === "failed" && attachment.retryAt !== null),
	);
}

/**
 * What an Open that is waiting on `pending` should do once the list answers: go there when it is
 * ready, stop waiting when it ended, keep waiting otherwise.
 */
export function pendingOutcome(
	attachments: readonly MachineAttachment[],
	pending: string | null,
): { kind: "go"; destination: string } | { kind: "stop" } | { kind: "wait" } {
	if (pending === null) return { kind: "stop" };
	const row = attachments.find((attachment) => attachment.id === pending);
	if (!row) return { kind: "wait" };
	if (row.state === "ready") return { kind: "go", destination: machineDestination(pending) };
	if (row.state === "failed" || row.state === "version-mismatch" || row.state === "detached") return { kind: "stop" };
	return { kind: "wait" };
}

/** The button for a machine: what it says and whether it can be pressed now. */
export function openAction(state: MachineAttachmentState, pending: boolean): { label: string; disabled: boolean } {
	if (pending || state === "connecting") return { label: "Connecting…", disabled: true };
	if (state === "ready") return { label: "Open", disabled: false };
	if (state === "failed" || state === "version-mismatch") return { label: "Try again", disabled: false };
	return { label: "Open", disabled: false };
}
