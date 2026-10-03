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
	EditorTheme,
	Keybinding,
	KeybindingConflict,
	KeybindingDefinitions,
	KeybindingsConfig,
	KeyId,
	MarkdownTheme,
	OverlayHandle,
	OverlayOptions,
	OverlayUnfocusOptions,
	ScrollViewScrollbar,
	SelectItem,
	SelectListLayoutOptions,
	SelectListTheme,
	SettingItem,
	SettingsListTheme,
	SlashCommand,
	Terminal,
	Tokens,
	TUI,
	TuiMode,
	TuiMouseEvent,
	TuiMouseEventResult,
} from "@earendil-works/pi-tui";

/**
 * Structural projection of the terminal engine covering just the progress
 * sink. The engine-boundary rules keep terminal-engine value imports inside this
 * module; consumers accept this narrower shape so the helper is unit-testable
 * without a real ProcessTerminal.
 */
interface AgentProgressSink {
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
	CombinedAutocompleteProvider,
	Container,
	Editor,
	fuzzyFilter,
	getKeybindings,
	Input,
	isKeyRelease,
	isKeyRepeat,
	KeybindingsManager,
	Markdown,
	Marked,
	matchesKey,
	ProcessTerminal,
	parseKey,
	ScrollView,
	SelectList,
	setKeybindings,
	stripTerminalSequences,
	Text,
	TUI_KEYBINDINGS,
	TuiAltScreen,
	TuiMainScreen,
	truncateToWidth,
	VStack,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
export { decodePrintableKey } from "@earendil-works/pi-tui/dist/keys.js";
export { extractAnsiCode } from "@earendil-works/pi-tui/dist/utils.js";
export type { ApplicationInputHost, ApplicationInputPolicy, ApplicationInputTui } from "./application-input-tui.js";
export { ApplicationInputTuiAltScreen, ApplicationInputTuiMainScreen } from "./application-input-tui.js";
export {
	InstrumentedTuiAltScreen,
	InstrumentedTuiMainScreen,
	type TuiRenderObserver,
	type TuiRenderPhase,
} from "./instrumented-tui.js";
