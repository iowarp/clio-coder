import type { OperatorExtensions } from "../../domains/extensions/operator-extensions.js";
import type { ExtensionOutputV2, ExtensionPanelV2 } from "../../domains/extensions/public-api-v2.js";
import type { ExtensionSurfaceEvent } from "../../domains/extensions/surface-model.js";
import type { View } from "../../domains/extensions/view.js";
import type { TUI } from "../../engine/tui.js";
import { truncateToWidth } from "../../engine/tui.js";
import type { AskUserHandler } from "../../tools/ask-user.js";
import type { NotificationInput } from "../footer/notifications.js";
import type { OverlayLifecycleController } from "../overlay-lifecycle.js";
import { clioTheme, frame } from "../theme/index.js";
import type { ExtensionDockHost } from "./extension-dock.js";
import { runExtensionInterview } from "./interview.js";
import { renderView } from "./view-renderer.js";

const DRAWING_KEYS = [
	"status",
	"band",
	"card",
	"toast",
	"panel",
	"dock",
	"regions",
	"islands",
	"workspace",
	"interview",
	"prompt",
] as const;

/** A text-only result needs its transcript fallback; drawn results already reached their host surfaces. */
export function hasExtensionDrawing(output: ExtensionOutputV2): boolean {
	return DRAWING_KEYS.some((key) => output[key] !== undefined);
}

interface AmbientDeps {
	operator: Pick<OperatorExtensions, "surface" | "action" | "interview" | "closePanel">;
	tui: Pick<TUI, "requestRender">;
	dock: ExtensionDockHost;
	overlay(): Pick<OverlayLifecycleController, "getState" | "openExtensionViewPanelState" | "openAskUserOverlayState">;
	notice(input: NotificationInput): void;
	appendCard(render: (width: number) => string[]): void;
	showText(owner: string, text: string): void;
	fill(text: string): void;
	submit(text: string): void;
}

export interface AmbientSurfaces {
	/** Retry a request parked behind a host modal; overlay close calls this after permissions get first refusal. */
	refresh(): void;
	dispose(): Promise<void>;
}

/** One terminal subscriber for one-shot events and persistent dock/panel updates. */
export function createAmbientSurfaces(deps: AmbientDeps): AmbientSurfaces {
	let disposed = false;
	let scheduled = false;
	let panelOwner: string | undefined;
	let panelKind: "panel" | "dock" | undefined;
	let pendingPanel: { owner: string; kind: "panel" | "dock" } | undefined;
	let dockOwner: string | undefined;
	let dockView: View | undefined;
	let dockSequence = 0;
	let interview: AbortController | undefined;
	const interviews: Array<Extract<ExtensionSurfaceEvent, { kind: "interview" }>> = [];
	const error = (owner: string, problem: unknown): void => {
		if (!disposed)
			deps.notice({
				level: "warning",
				text: `${owner}: ${problem instanceof Error ? problem.message : String(problem)}`,
				key: `extension:${owner}:error`,
			});
	};
	const fallback = (owner: string, output: ExtensionOutputV2): void => {
		if (!disposed && output.text && !hasExtensionDrawing(output)) deps.showText(owner, output.text);
	};
	const press = async (
		owner: string,
		action: string,
		key: string | undefined,
		source: "panel" | "dock",
	): Promise<void> => {
		try {
			fallback(owner, await deps.operator.action(owner, { id: action, ...(key === undefined ? {} : { key }), source }));
		} catch (problem) {
			error(owner, problem);
		}
	};
	const openPanel = (owner: string, kind: "panel" | "dock"): void => {
		if (panelOwner === owner) {
			panelKind = kind;
			refresh();
			return;
		}
		pendingPanel = { owner, kind };
		refresh();
	};
	const flush = (): void => {
		scheduled = false;
		if (disposed || deps.overlay().getState() !== "closed") return;
		const next = pendingPanel;
		if (next) {
			pendingPanel = undefined;
			let dockPanel: ExtensionPanelV2 | undefined;
			const panel = (): ExtensionPanelV2 | undefined => {
				const entry = deps.operator.surface.entry(next.owner);
				if ((panelKind ?? next.kind) === "panel") return entry?.panel;
				const view = entry?.dock;
				if (!view) return undefined;
				if (dockPanel?.view !== view) dockPanel = { title: "Dock", view };
				return dockPanel;
			};
			if (
				panel() &&
				deps.overlay().openExtensionViewPanelState(next.owner, {
					panel,
					press: (target) => press(next.owner, target.action, target.key, "panel"),
					onClosed() {
						panelOwner = undefined;
						panelKind = undefined;
						deps.operator.closePanel(next.owner);
						refresh();
					},
				})
			) {
				panelOwner = next.owner;
				panelKind = next.kind;
			}
			return;
		}
		if (interview || !interviews.length) return;
		const event = interviews.shift();
		if (!event) return;
		const controller = new AbortController();
		interview = controller;
		void runExtensionInterview(
			{ ask: ((questions, options) => deps.overlay().openAskUserOverlayState(questions, options)) as AskUserHandler },
			event.interview,
			{ extensionId: event.extensionId, title: event.extensionId },
			(answer) => deps.operator.interview(event.extensionId, answer),
			controller.signal,
		)
			.then((result) => {
				if (result.output) fallback(event.extensionId, result.output);
			})
			.catch((problem) => error(event.extensionId, problem))
			.finally(() => {
				interview = undefined;
				refresh();
			});
	};
	function refresh(): void {
		if (disposed) return;
		if (dockOwner) {
			const view = deps.operator.surface.entry(dockOwner)?.dock;
			if (view !== dockView) {
				dockView = view;
				deps.dock.update(dockOwner, view ?? null);
			}
		}
		deps.tui.requestRender();
		if (!scheduled) {
			scheduled = true;
			queueMicrotask(flush);
		}
	}
	const unsubscribe = deps.operator.surface.subscribe((event) => {
		if (disposed) return;
		if (event)
			switch (event.kind) {
				case "toast":
					deps.notice({
						level:
							event.toast.tone === "positive"
								? "success"
								: event.toast.tone === "warning" || event.toast.tone === "error"
									? event.toast.tone
									: "info",
						text: `${event.extensionId}: ${event.toast.text}`,
						ttlMs: 12000,
						key: `extension:${event.extensionId}:toast`,
					});
					break;
				case "card":
					deps.appendCard((width) =>
						frame(
							clioTheme(),
							`Extension: ${event.extensionId}`,
							renderView(event.view, Math.max(1, width - 4), { maxRows: 22 }).lines,
							Math.max(4, width),
						).map((line) => truncateToWidth(line, Math.max(1, width))),
					);
					break;
				case "panel":
					openPanel(event.extensionId, "panel");
					break;
				case "dock": {
					const sequence = ++dockSequence;
					if (!deps.dock.available()) {
						openPanel(event.extensionId, "dock");
						break;
					}
					dockOwner = event.extensionId;
					dockView = event.view;
					void deps.dock
						.open(event.extensionId, event.extensionId, event.view)
						.then((opened) => {
							if (disposed || sequence !== dockSequence) return;
							if (!opened) {
								dockOwner = undefined;
								dockView = undefined;
								openPanel(event.extensionId, "dock");
							} else {
								dockView = undefined;
								refresh();
							}
						})
						.catch((problem) => error(event.extensionId, problem));
					break;
				}
				case "interview":
					interviews.push(event);
					break;
				case "prompt":
					if ("fill" in event.prompt) deps.fill(event.prompt.fill);
					else deps.submit(event.prompt.submit);
					break;
				case "workspace":
					break;
			}
		refresh();
	});
	const unpress = deps.dock.onPress((owner, target) => {
		void press(owner, target.action, target.key, "dock");
	});
	return {
		refresh,
		async dispose() {
			if (disposed) return;
			disposed = true;
			unsubscribe();
			unpress();
			interview?.abort();
			interviews.length = 0;
			pendingPanel = undefined;
			if (panelOwner) deps.operator.closePanel(panelOwner);
			await deps.dock.dispose();
		},
	};
}
