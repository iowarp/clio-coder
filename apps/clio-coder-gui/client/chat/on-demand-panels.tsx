// Panels that open from a slash action, a pane drill-in or a file link, never on a task's first paint. Their code
// loads apart from the session route, and `preloadPanels` fetches it once the page is idle so a first open
// rarely waits. Render each inside a `Suspense` placed outside anything that moves focus on mount.
import { lazy } from "react";

const loaders = {
	aside: () => import("./AsidePanel.js"),
	branch: () => import("./BranchPanel.js"),
	extensions: () => import("./ExtensionsPanel.js"),
	filePreview: () => import("./FilePreviewDialog.js"),
	fleetRun: () => import("./FleetRunPanel.js"),
	handoff: () => import("./HandoffPanel.js"),
	historySearch: () => import("./HistorySearch.js"),
	visualActions: () => import("./VisualActions.js"),
};

export const AsidePanel = lazy(() => loaders.aside().then((module) => ({ default: module.AsidePanel })));
export const BranchPanel = lazy(() => loaders.branch().then((module) => ({ default: module.BranchPanel })));
export const ExtensionsPanel = lazy(() => loaders.extensions().then((module) => ({ default: module.ExtensionsPanel })));
export const FilePreviewDialog = lazy(() =>
	loaders.filePreview().then((module) => ({ default: module.FilePreviewDialog })),
);
export const FleetRunPanel = lazy(() => loaders.fleetRun().then((module) => ({ default: module.FleetRunPanel })));
export const HandoffPanel = lazy(() => loaders.handoff().then((module) => ({ default: module.HandoffPanel })));
export const HistorySearch = lazy(() => loaders.historySearch().then((module) => ({ default: module.HistorySearch })));
export const VisualActions = lazy(() => loaders.visualActions().then((module) => ({ default: module.VisualActions })));

/** Fetches every panel's code once the browser is idle. Returns the cancel for an effect's cleanup. */
export function preloadPanels(): () => void {
	const load = () => {
		for (const loader of Object.values(loaders))
			loader().catch(() => {
				/* The panel's own open reports a failed load; a prefetch has no one to tell. */
			});
	};
	if (typeof requestIdleCallback === "function") {
		const handle = requestIdleCallback(load, { timeout: 3000 });
		return () => cancelIdleCallback(handle);
	}
	const handle = setTimeout(load, 1000);
	return () => clearTimeout(handle);
}
