import type { ExtensionPanel } from "../domains/extensions/public-api.js";
import type { LibraryEntryKind, ResourcesContract } from "../domains/resources/index.js";
import type { TUI } from "../engine/tui.js";
import type { ClioEditor } from "./clio-editor.js";
import type { ClioKeybindingManager } from "./keybinding-manager.js";
import type { OverlayTransitions } from "./overlay-transitions.js";
import { openExtensionPanel } from "./overlays/extension-panel.js";
import { openExtensionsOverlay } from "./overlays/extensions.js";
import { openHelpOverlay } from "./overlays/help-reference.js";
import { openInteropOverlay } from "./overlays/interop.js";
import { openLibraryOverlay } from "./overlays/library.js";
import { createLibraryLifecycle, libraryRefreshHost } from "./overlays/library-lifecycle.js";
import type { LibraryBrowseRequest, SlashCommandContext } from "./slash-commands.js";

export type { LibraryBrowseRequest as LibraryOpenRequest } from "./slash-commands.js";

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
	openHelpOverlayState(query?: string): void;
	openSkillsHubState(request?: LibraryBrowseRequest | LibraryEntryKind): void;
	openExtensionsOverlayState(): void;
	openInteropOverlayState(): void;
}

/** The session's own resource reload, or nothing when this host has none wired. */
function reloadResources(ctx: SlashCommandContext): (() => { generation: number }) | undefined {
	const reload = ctx.reloadPlugins;
	return reload ? () => reload() : undefined;
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
			ctx.operatorExtensions?.commands(ctx.listPrompts().items.map((prompt) => prompt.name)),
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
			// The session's own resource reload is the refresh a committed change
			// asks for. It is reported separately from the write and can be retried
			// on its own, so a refresh failure never restates a successful install.
			lifecycle: createLibraryLifecycle(libraryRefreshHost(reloadResources(ctx))),
			// A fleet's `use` is its approval preview, which is a surface of its own.
			// The Library closes first so the preview owns the overlay slot, exactly
			// as `/fleet run <name>` typed into the composer would.
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
			deps.transitions.handle = openExtensionPanel(deps.tui, owner, panel, valid);
			deps.tui.requestRender();
			return true;
		},
		openHelpOverlayState,
		openSkillsHubState,
		openExtensionsOverlayState,
		openInteropOverlayState,
	};
}
