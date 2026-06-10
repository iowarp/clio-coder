/**
 * Re-export the Clio terminal-engine primitives the interactive layer consumes. Adding a
 * new terminal-engine symbol to Clio happens here first, then the consuming file in
 * src/interactive/ imports it from this module.
 */

export type {
	AutocompleteItem,
	AutocompleteProvider,
	AutocompleteSuggestions,
	Component,
	DefaultTextStyle,
	EditorOptions,
	EditorTheme,
	ImageOptions,
	ImageTheme,
	Keybinding,
	KeybindingConflict,
	KeybindingDefinition,
	KeybindingDefinitions,
	Keybindings,
	KeybindingsConfig,
	KeyId,
	MarkdownTheme,
	OverlayHandle,
	OverlayOptions,
	SelectItem,
	SelectListLayoutOptions,
	SelectListTheme,
	SettingItem,
	SettingsListTheme,
	SlashCommand,
	Terminal,
} from "@earendil-works/pi-tui";

/**
 * Structural projection of the terminal engine covering just the progress
 * sink. The engine-boundary rules keep terminal-engine value imports inside this
 * module; consumers accept this narrower shape so the helper is unit-testable
 * without a real ProcessTerminal.
 */
export interface AgentProgressSink {
	setProgress(active: boolean): void;
}

/**
 * Toggle OSC 9;4 indeterminate progress around an agent run. The Clio terminal
 * engine emits the sequence terminals like WezTerm, Ghostty,
 * Konsole, and Windows Terminal render as a taskbar/tab progress badge.
 *
 * Start/stop are idempotent: repeated calls coalesce so multiple agent_start
 * events in a row (or a stop with no active run) never emit stray sequences.
 */
export function createAgentProgress(terminal: AgentProgressSink): {
	start(): void;
	stop(): void;
	isActive(): boolean;
} {
	let active = false;
	return {
		start(): void {
			if (active) return;
			active = true;
			terminal.setProgress(true);
		},
		stop(): void {
			if (!active) return;
			active = false;
			terminal.setProgress(false);
		},
		isActive(): boolean {
			return active;
		},
	};
}
export {
	Box,
	CancellableLoader,
	CombinedAutocompleteProvider,
	Container,
	Editor,
	fuzzyFilter,
	fuzzyMatch,
	getCapabilities,
	getKeybindings,
	Image,
	Input,
	isKeyRelease,
	KeybindingsManager,
	Loader,
	Markdown,
	matchesKey,
	ProcessTerminal,
	SelectList,
	SettingsList,
	Spacer,
	setKeybindings,
	Text,
	TruncatedText,
	TUI,
	TUI_KEYBINDINGS,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
