import {
	type ProjectTrustCardModel,
	projectTrustCardReviewFiles,
	projectTrustCardReviewLines,
} from "../../cli/project-trust-card.js";
import type { TUI } from "../../engine/tui.js";
import { type ListOverlayHandle, type ListOverlayItem, openListOverlay } from "./list-overlay.js";

const TRUST = "action:trust";
const SKIP = "action:skip";

/**
 * The launch card's in-session form, for `/trust` and for a `/reload` that found
 * new or changed project configuration. Enter on a surface is Review: its pane
 * holds the summary and every file in full. Trust all writes the records and
 * restarts into the session; Not now and Esc trust nothing.
 */
export function openProjectTrustOverlay(
	tui: TUI,
	model: ProjectTrustCardModel,
	deps: { onTrust: () => void; onClose: () => void },
): ListOverlayHandle {
	const surfaces: ListOverlayItem[] = model.surfaces.map((item) => ({
		id: `surface:${item.surface}`,
		label: item.surface,
		...(item.changed ? { meta: "changed since you trusted it" } : {}),
		group: "Review",
		searchGroup: false,
		detail: () => [
			...item.summary,
			...projectTrustCardReviewFiles({ workspaceRoot: model.workspaceRoot, surfaces: [item] }).flatMap((file) => [
				"",
				...projectTrustCardReviewLines(file),
			]),
		],
		detailFormat: "rows",
	}));
	const handle = openListOverlay(tui, {
		markerId: "project-trust",
		title: "Project configuration",
		unit: "rows",
		status: () => `This repository has its own Clio configuration. It applies only after you trust it.`,
		items: [
			...surfaces,
			{ id: TRUST, label: "Trust all and restart", group: "Decide", searchGroup: false },
			{ id: SKIP, label: "Not now", group: "Decide", searchGroup: false },
		],
		hints: (selected) =>
			selected?.id === TRUST
				? [{ key: "Enter", verb: "trust all and restart", short: "trust", critical: true }]
				: selected?.id === SKIP
					? [{ key: "Enter", verb: "close without trusting", short: "close" }]
					: [{ key: "Enter", verb: "review", critical: true }],
		leadWithHints: true,
		onSelect: (item) => {
			if (item.id === TRUST) deps.onTrust();
			else if (item.id === SKIP) deps.onClose();
			else handle.openDetail();
		},
		onClose: deps.onClose,
	});
	return handle;
}
