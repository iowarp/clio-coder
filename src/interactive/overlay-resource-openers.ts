import { promptRefs } from "../domains/extensions/operator-commands.js";
import type { ExtensionPanel } from "../domains/extensions/public-api.js";
import type { LibraryEntryKind, ResourcesContract } from "../domains/resources/index.js";
import type { TUI } from "../engine/tui.js";
import type { LibraryBrowseRequest, SlashCommandContext } from "../session-control/slash-commands.js";
import type { ClioEditor } from "./clio-editor.js";
import type { ClioKeybindingManager } from "./keybinding-manager.js";
import type { OverlayTransitions } from "./overlay-transitions.js";
import { openExtensionPanel } from "./overlays/extension-panel.js";
import { openExtensionViewPanel } from "./overlays/extension-view-panel.js";
import { openExtensionsOverlay } from "./overlays/extensions.js";
import { openHelpOverlay } from "./overlays/help-reference.js";
import { openInteropOverlay } from "./overlays/interop.js";
import { openLibraryOverlay } from "./overlays/library.js";
import { createLibraryLifecycle, type LibrarySessionReload, libraryRefreshHost } from "./overlays/library-lifecycle.js";

export type { LibraryBrowseRequest as LibraryOpenRequest } from "../session-control/slash-commands.js";

export interface OverlayResourceOpenersDeps {
	tui: TUI;
	transitions: Pick<OverlayTransitions, "state" | "handle">;
	keybindings: ClioKeybindingManager;
	editor: Pick<ClioEditor, "setText">;
	getSlashContext: () => SlashCommandContext;
	resources?: Pick<ResourcesContract, "skills">;
	closeOverlay: () => void;
	openHelpOverlay?: typeof openHelpOverlay;
	openSkillsHub?: typeof openLibraryOverlay;
	openExtensionsOverlay?: typeof openExtensionsOverlay;
	openInteropOverlay?: typeof openInteropOverlay;
}

export interface OverlayResourceOpeners {
	openExtensionPanelState(owner: string, panel: ExtensionPanel, valid: () => boolean): boolean;
	openExtensionViewPanelState(
		owner: string,
		deps: Omit<Parameters<typeof openExtensionViewPanel>[2], "close"> & { onClosed(): void },
	): boolean;
	openHelpOverlayState(query?: string): void;
	openSkillsHubState(request?: LibraryBrowseRequest | LibraryEntryKind): void;
	openExtensionsOverlayState(): void;
	openInteropOverlayState(): void;
}

/**
 * The session's own reloads, or nothing for a seam this host has not wired.
 * An extension change reaches the running session only through the operator
 * reload, which restarts runtimes and republishes hooks and waits for an idle
 * session; the Library overlay is open, so it normally queues until it closes.
 */
function sessionReload(ctx: SlashCommandContext): LibrarySessionReload {
	const reload = ctx.reloadPlugins;
	const operator = ctx.operatorExtensions;
	return {
		...(reload ? { resources: () => reload() } : {}),
		...(operator
			? {
					extensions: () => {
						const queued = !operator.canReloadNow;
						// The settled result is reported by the operator host's own reload notice.
						operator.reload().catch((error: unknown) => {
							ctx.notice("warn", `extensions: reload failed: ${error instanceof Error ? error.message : String(error)}`);
						});
						return queued ? "queued" : "reloading";
					},
				}
			: {}),
	};
}

export function createOverlayResourceOpeners(deps: OverlayResourceOpenersDeps): OverlayResourceOpeners {
	const openHelp = deps.openHelpOverlay ?? openHelpOverlay;
	const openLibrary = deps.openSkillsHub ?? openLibraryOverlay;
	const openExtensions = deps.openExtensionsOverlay ?? openExtensionsOverlay;
	const openInterop = deps.openInteropOverlay ?? openInteropOverlay;

	const openHelpOverlayState = (query?: string): void => {
		if (deps.transitions.state !== "closed") return;
		deps.transitions.state = "help";
		const ctx = deps.getSlashContext();
		deps.transitions.handle = openHelp(
			deps.tui,
			deps.keybindings,
			deps.closeOverlay,
			query,
			ctx.operatorExtensions?.commands(promptRefs((ctx.listPromptsForDisplay ?? ctx.listPrompts)?.().items ?? [])),
		);
		deps.tui.requestRender();
	};

	const openInteropOverlayState = (): void => {
		if (deps.transitions.state !== "closed") return;
		deps.transitions.state = "interop";
		deps.transitions.handle = openInterop(deps.tui, deps.getSlashContext(), deps.closeOverlay);
		deps.tui.requestRender();
	};

	const openSkillsHubState = (request?: LibraryBrowseRequest | LibraryEntryKind): void => {
		if (deps.transitions.state !== "closed") return;
		const open: LibraryBrowseRequest = typeof request === "string" ? { tab: request } : (request ?? {});
		deps.transitions.state = "skills-hub";
		const ctx = deps.getSlashContext();
		deps.transitions.handle = openLibrary(deps.tui, {
			...(open.tab ? { initialTab: open.tab } : {}),
			...(open.focus ? { focus: open.focus } : {}),
			...(open.intent ? { intent: open.intent } : {}),
			...(open.importSource ? { importSource: open.importSource } : {}),
			...(open.scope ? { initialScope: open.scope } : {}),
			// The session's own reload is the refresh a committed change asks for:
			// plugin resources always, extensions when one changed. It is reported
			// separately from the write and can be retried on its own, so a refresh
			// failure never restates a successful install.
			lifecycle: createLibraryLifecycle(libraryRefreshHost(sessionReload(ctx))),
			// A fleet's `use` is its approval preview, which is a surface of its own.
			// The Library closes first so the preview owns the overlay slot, exactly
			// as `/fleet run <playbook>` typed into the composer would.
			openFleetRun: (name) => {
				deps.closeOverlay();
				deps.getSlashContext().startFleetRun?.(name, {});
			},
			// Discovery is explicit. Opening the Library never sweeps another
			// agent's home; this is the only route that does, and only on `o`.
			openImport: () => {
				deps.closeOverlay();
				openInteropOverlayState();
			},
			setEditorText: (text) => {
				deps.editor.setText(text);
				deps.tui.requestRender();
			},
			notice: (level, text) => deps.getSlashContext().notice(level, text),
			onClose: deps.closeOverlay,
		});
		deps.tui.requestRender();
	};

	const openExtensionsOverlayState = (): void => {
		if (deps.transitions.state !== "closed") return;
		deps.transitions.state = "extensions";
		deps.transitions.handle = openExtensions(deps.tui, deps.getSlashContext(), deps.closeOverlay);
		deps.tui.requestRender();
	};

	return {
		openExtensionPanelState(owner, panel, valid) {
			if (deps.transitions.state !== "closed") return false;
			deps.transitions.state = "extensions";
			deps.transitions.handle = openExtensionPanel(deps.tui, owner, panel, valid, deps.closeOverlay);
			deps.tui.requestRender();
			return true;
		},
		openExtensionViewPanelState(owner, panelDeps) {
			if (deps.transitions.state !== "closed") return false;
			deps.transitions.state = "extensions";
			const handle = openExtensionViewPanel(deps.tui, owner, { ...panelDeps, close: deps.closeOverlay });
			let closed = false;
			deps.transitions.handle = {
				...handle,
				hide() {
					if (closed) return;
					closed = true;
					handle.hide();
					panelDeps.onClosed();
				},
			};
			deps.tui.requestRender();
			return true;
		},
		openHelpOverlayState,
		openSkillsHubState,
		openExtensionsOverlayState,
		openInteropOverlayState,
	};
}
