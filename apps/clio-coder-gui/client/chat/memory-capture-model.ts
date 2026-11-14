// The operator memory capture chip's decisions, with no React, CSS or API client.

import type { MemoryCapture } from "../../contracts/session-telemetry.js";

type Scope = NonNullable<MemoryCapture["scope"]>;

const SCOPE_LABELS: Record<Scope, string> = {
	session: "this session",
	project: "this project",
	global: "all projects",
};

export interface MemoryChipAction {
	label: string;
	/** The `remember` command's argv, run through the session command route. */
	argv: string[];
}

export interface MemoryChipView {
	title: string;
	detail: string;
	/** Empty for a refusal or an undone capture: nothing is left to move or take back. */
	actions: MemoryChipAction[];
}

function clip(text: string, max = 80): string {
	const flat = text.replace(/\s+/gu, " ").trim();
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

export function memoryChipView(capture: MemoryCapture): MemoryChipView {
	const undo = { label: "Undo", argv: ["undo", capture.captureId] };
	if (capture.action === "remembered" && capture.scope !== undefined) {
		const current = capture.scope;
		const moves = (Object.keys(SCOPE_LABELS) as Scope[])
			.filter((scope) => scope !== current)
			.map((scope) => ({ label: `Keep for ${SCOPE_LABELS[scope]}`, argv: ["scope", scope, capture.captureId] }));
		return {
			title: `Remembered for ${SCOPE_LABELS[current]}`,
			detail: `${capture.kind ?? "fact"}: ${clip(capture.text)}`,
			actions: [...moves, undo],
		};
	}
	if (capture.action === "forgot") return { title: "Forgot", detail: clip(capture.text), actions: [undo] };
	if (capture.action === "undone") return { title: "Undone", detail: clip(capture.text), actions: [] };
	return { title: "Not remembered", detail: clip(capture.text), actions: [] };
}

/**
 * The capture a command result leaves standing: an undo turns the chip into a plain "Undone" line, a scope
 * move names the new scope. A failed command leaves the chip as it was.
 */
export function memoryCaptureAfter(capture: MemoryCapture, argv: readonly string[], ok: boolean): MemoryCapture {
	if (!ok) return capture;
	if (argv[0] === "undo") return { ...capture, action: "undone" };
	const scope =
		argv[0] === "scope" ? (Object.keys(SCOPE_LABELS) as Scope[]).find((value) => value === argv[1]) : undefined;
	return scope === undefined ? capture : { ...capture, action: "remembered", scope };
}
