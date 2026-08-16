import type { ResourcesContract } from "../domains/resources/index.js";
import { installSkill as installMarketplaceSkill } from "../domains/resources/skills/marketplace.js";
import type { TUI } from "../engine/tui.js";
import type { ClioEditor } from "./clio-editor.js";
import type { ClioKeybindingManager } from "./keybinding-manager.js";
import type { OverlayTransitions } from "./overlay-transitions.js";
import { openAgentsOverlay } from "./overlays/agents.js";
import { openExtensionsOverlay } from "./overlays/extensions.js";
import { openHelpOverlay } from "./overlays/help-reference.js";
import { openInteropOverlay } from "./overlays/interop.js";
import { openPromptsOverlay } from "./overlays/prompts.js";
import { openSkillsHub } from "./overlays/skills-hub.js";
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
	openSkillsHub?: typeof openSkillsHub;
	openPromptsOverlay?: typeof openPromptsOverlay;
	openExtensionsOverlay?: typeof openExtensionsOverlay;
	openInteropOverlay?: typeof openInteropOverlay;
	installSkill?: typeof installMarketplaceSkill;
}

export interface OverlayResourceOpeners {
	openHelpOverlayState(query?: string): void;
	openAgentsOverlayState(): void;
	openSkillsHubState(): void;
	openPromptsOverlayState(): void;
	openExtensionsOverlayState(): void;
	openInteropOverlayState(): void;
}

export function createOverlayResourceOpeners(deps: OverlayResourceOpenersDeps): OverlayResourceOpeners {
	const openHelp = deps.openHelpOverlay ?? openHelpOverlay;
	const openAgents = deps.openAgentsOverlay ?? openAgentsOverlay;
	const openSkills = deps.openSkillsHub ?? openSkillsHub;
	const openPrompts = deps.openPromptsOverlay ?? openPromptsOverlay;
	const openExtensions = deps.openExtensionsOverlay ?? openExtensionsOverlay;
	const openInterop = deps.openInteropOverlay ?? openInteropOverlay;
	const installSkill = deps.installSkill ?? installMarketplaceSkill;

	const openHelpOverlayState = (query?: string): void => {
		if (deps.transitions.state !== "closed") return;
		deps.transitions.state = "help";
		deps.transitions.handle = openHelp(deps.tui, deps.keybindings, deps.closeOverlay, query);
		deps.tui.requestRender();
	};

	const openAgentsOverlayState = (): void => {
		if (deps.transitions.state !== "closed") return;
		deps.transitions.state = "agents";
		deps.transitions.handle = openAgents(deps.tui, deps.getSlashContext(), deps.closeOverlay);
		deps.tui.requestRender();
	};

	const openSkillsHubState = (): void => {
		if (deps.transitions.state !== "closed") return;
		deps.transitions.state = "skills-hub";
		deps.transitions.handle = openSkills(deps.tui, {
			listSkills: () => deps.resources?.skills(process.cwd()) ?? { items: [], diagnostics: [] },
			setEditorText: (text) => {
				deps.editor.setText(text);
				deps.tui.requestRender();
			},
			notice: (level, text) => deps.getSlashContext().notice(level, text),
			installSkill: async (name) => {
				const result = installSkill({ source: name, scope: "project" });
				return { name: result.name, path: result.path, warnings: result.warnings };
			},
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
		openHelpOverlayState,
		openAgentsOverlayState,
		openSkillsHubState,
		openPromptsOverlayState,
		openExtensionsOverlayState,
		openInteropOverlayState,
	};
}
