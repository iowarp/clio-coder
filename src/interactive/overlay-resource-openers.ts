import type { ExtensionPanel } from "../domains/extensions/public-api.js";
import type { LibraryEntryKind, ResourcesContract } from "../domains/resources/index.js";
import type { TUI } from "../engine/tui.js";
import type { ClioEditor } from "./clio-editor.js";
import type { ClioKeybindingManager } from "./keybinding-manager.js";
import type { OverlayTransitions } from "./overlay-transitions.js";
import { openAgentsOverlay } from "./overlays/agents.js";
import { openExtensionPanel } from "./overlays/extension-panel.js";
import { openExtensionsOverlay } from "./overlays/extensions.js";
import { openHelpOverlay } from "./overlays/help-reference.js";
import { openInteropOverlay } from "./overlays/interop.js";
import { openLibraryOverlay } from "./overlays/library.js";
import { openPromptsOverlay } from "./overlays/prompts.js";
import type { SlashCommandContext } from "./slash-commands.js";

export interface OverlayResourceOpenersDeps {
	tui: TUI;
	transitions: Pick<OverlayTransitions, "state" | "handle">;
	keybindings: ClioKeybindingManager;
	editor: Pick<ClioEditor, "setText">;
	getSlashContext: () => SlashCommandContext;
	resources?: Pick<ResourcesContract, "skills">;
	closeOverlay: () => void;
	openHelpOverlay?: typeof openHelpOverlay;
	openAgentsOverlay?: typeof openAgentsOverlay;
	openSkillsHub?: typeof openLibraryOverlay;
	openPromptsOverlay?: typeof openPromptsOverlay;
	openExtensionsOverlay?: typeof openExtensionsOverlay;
	openInteropOverlay?: typeof openInteropOverlay;
}

export interface OverlayResourceOpeners {
	openExtensionPanelState(owner: string, panel: ExtensionPanel, valid: () => boolean): boolean;
	openHelpOverlayState(query?: string): void;
	openAgentsOverlayState(): void;
	openSkillsHubState(tab?: LibraryEntryKind): void;
	openPromptsOverlayState(): void;
	openExtensionsOverlayState(): void;
	openInteropOverlayState(): void;
}

export function createOverlayResourceOpeners(deps: OverlayResourceOpenersDeps): OverlayResourceOpeners {
	const openHelp = deps.openHelpOverlay ?? openHelpOverlay;
	const openAgents = deps.openAgentsOverlay ?? openAgentsOverlay;
	const openSkills = deps.openSkillsHub ?? openLibraryOverlay;
	const openPrompts = deps.openPromptsOverlay ?? openPromptsOverlay;
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

	const openAgentsOverlayState = (): void => {
		if (deps.transitions.state !== "closed") return;
		deps.transitions.state = "agents";
		deps.transitions.handle = openAgents(deps.tui, deps.getSlashContext(), deps.closeOverlay);
		deps.tui.requestRender();
	};

	const openSkillsHubState = (tab?: LibraryEntryKind): void => {
		if (deps.transitions.state !== "closed") return;
		deps.transitions.state = "skills-hub";
		deps.transitions.handle = openSkills(deps.tui, {
			...(tab ? { initialTab: tab } : {}),
			// A fleet's `use` is its approval preview, which is a surface of its own.
			// The hub closes first so the preview owns the overlay slot, exactly as
			// `/fleet run <name>` typed into the composer would.
			openFleetRun: (name) => {
				deps.closeOverlay();
				deps.getSlashContext().startFleetRun?.(name, {});
			},
			listSkills: () => deps.resources?.skills(process.cwd()) ?? { items: [], diagnostics: [] },
			setEditorText: (text) => {
				deps.editor.setText(text);
				deps.tui.requestRender();
			},
			notice: (level, text) => deps.getSlashContext().notice(level, text),

			onClose: deps.closeOverlay,
		});
		deps.tui.requestRender();
	};

	const openPromptsOverlayState = (): void => {
		if (deps.transitions.state !== "closed") return;
		deps.transitions.state = "prompts";
		deps.transitions.handle = openPrompts(deps.tui, deps.getSlashContext(), deps.closeOverlay);
		deps.tui.requestRender();
	};

	const openExtensionsOverlayState = (): void => {
		if (deps.transitions.state !== "closed") return;
		deps.transitions.state = "extensions";
		deps.transitions.handle = openExtensions(deps.tui, deps.getSlashContext(), deps.closeOverlay);
		deps.tui.requestRender();
	};

	const openInteropOverlayState = (): void => {
		if (deps.transitions.state !== "closed") return;
		deps.transitions.state = "interop";
		deps.transitions.handle = openInterop(deps.tui, deps.getSlashContext(), deps.closeOverlay);
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
		openAgentsOverlayState,
		openSkillsHubState,
		openPromptsOverlayState,
		openExtensionsOverlayState,
		openInteropOverlayState,
	};
}
