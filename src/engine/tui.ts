/**
 * Re-export the pi-tui 0.69.0 primitives Clio's interactive layer consumes. Adding a
 * new pi-tui symbol to Clio happens here first (and in the audit document), then the
 * consuming file in src/interactive/ imports it from this module.
 */

export type {
	AutocompleteItem,
	AutocompleteProvider,
	AutocompleteSuggestions,
	Component,
	DefaultTextStyle,
	EditorOptions,
	EditorTheme,
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
	Terminal,
} from "@mariozechner/pi-tui";

/**
 * Structural projection of pi-tui's `Terminal` covering just the progress
 * sink. The engine-boundary rules keep pi-tui value imports inside this
 * module; consumers accept this narrower shape so the helper is unit-testable
 * without a real ProcessTerminal.
 */
export interface AgentProgressSink {
	setProgress(active: boolean): void;
}

/**
 * Toggle OSC 9;4 indeterminate progress around an agent run. pi-tui 0.69.0's
 * `Terminal.setProgress` emits the sequence terminals like WezTerm, Ghostty,
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
	Container,
	Editor,
	fuzzyFilter,
	fuzzyMatch,
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
} from "@mariozechner/pi-tui";
