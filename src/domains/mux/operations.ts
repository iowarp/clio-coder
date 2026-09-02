/**
 * The operator- and model-facing pane vocabulary: presets, results, and the
 * one operations interface both `/panes` and the `panes` tool drive.
 *
 * It is a leaf with no imports, and it lives in the domain rather than beside
 * either caller because both callers are forbidden from reaching the other's
 * tree. `src/interactive/slash-commands.ts` is a CLI seam whose value closure
 * must stay off the render graph, and `src/tools/**` may not import
 * `src/interactive/**` at all (boundaries rule4). A shared leaf here is the
 * only place both can name the same preset ids and the same result shapes.
 *
 * Presets are the only utility panes the model may open. Arbitrary argv stays
 * operator-only through the slash command, which is what keeps the tool out of
 * shell-escape territory (spec 4.8, and the risk register's "tool misuse" row).
 */

/**
 * Utility pane presets, in the order `/panes open` lists them.
 *
 * The files preset is a Clio Coder surface named for what it does; yazi is
 * the engine behind it and shows up only in the install command, because
 * that is the registry id an operator types.
 */
export const PANES_PRESETS = [
	{
		id: "files",
		/** Probed through the toolchain resolution ladder before the pane is split. */
		binary: "yazi",
		summary: "file view rooted at the workspace; picks land in the composer",
		/** Printed verbatim when the probe finds nothing. */
		installHint: "clio-coder tools install yazi",
	},
	{
		id: "logs",
		binary: "tail",
		summary: "follow the newest dispatched run's event journal",
		installHint: "install coreutils so `tail` is on PATH",
	},
	{
		id: "shell",
		binary: "bash",
		summary: "a plain shell in the workspace",
		installHint: "install bash, or open a shell with `/panes open <argv>`",
	},
] as const;

export type PanesPresetId = (typeof PANES_PRESETS)[number]["id"];

export const PANES_PRESET_IDS: ReadonlyArray<PanesPresetId> = PANES_PRESETS.map((preset) => preset.id);

function isPanesPresetId(value: string): value is PanesPresetId {
	return PANES_PRESETS.some((preset) => preset.id === value);
}

/**
 * Retired preset spellings that still parse. The files preset shipped as
 * `yazi` in 0.4.0 and 0.4.1, so an operator's muscle memory and any script
 * that says `/panes open yazi` keeps working and lands on the same pane.
 */
export const PANES_PRESET_ALIASES: Readonly<Record<string, PanesPresetId>> = { yazi: "files" };

/** The canonical preset id for an operator-typed name, or null when it is not a preset. */
export function resolvePanesPresetId(value: string): PanesPresetId | null {
	if (isPanesPresetId(value)) return value;
	return PANES_PRESET_ALIASES[value] ?? null;
}

/** One pane Clio owns, flattened for display. */
export interface PanesInventoryEntry {
	paneId: string;
	tabId: string;
	purpose: "watch" | "utility";
	label: string;
	adopted: boolean;
	/** An open operation admitted locally but not yet reconciled into the mux registry. */
	pending?: boolean;
}

/** Effective pane settings, as `/panes` prints them. */
export interface PanesEffectiveSettings {
	enabled: string;
	notifications: string;
	/** Boot composition: off, workers, or cockpit. */
	layout: string;
	journal: boolean;
	yazi: {
		enabled: boolean;
		mode: "companion" | "chooser";
		profile: "managed" | "user";
		followCwd: boolean;
	};
}

/** One managed dock's live geometry, flattened for `/panes` status. */
export interface PanesDockStatus {
	slot: "workers" | "files";
	paneId: string;
	/** Share of the axis the dock currently targets, 0..0.5. */
	targetShare: number;
}

/** File-pane return-path state flattened for `/panes` and the model tool. */
export interface PanesYaziStatus {
	mode: "companion" | "chooser" | "closed";
	paneId: string | null;
	paneCwd: string | null;
	lastLineAt: number | null;
	droppedLines: number;
}

/** What `/panes` with no subcommand answers. */
export interface PanesStatus {
	mode: "embedded" | "guest" | "none";
	available: boolean;
	/** Why the mux resolved the way it did, straight from detection. */
	reason: string;
	socketPath: string | null;
	server: { version: string; protocol: number } | null;
	settings: PanesEffectiveSettings;
	yazi: PanesYaziStatus;
	/** Managed docks with live geometry; empty below the layout tier. */
	docks: ReadonlyArray<PanesDockStatus>;
	panes: ReadonlyArray<PanesInventoryEntry>;
}

export type PanesShowResult =
	| { status: "watching"; runId: string; agentId: string; opened: boolean }
	| { status: "not-found"; target: string; candidates: ReadonlyArray<string> }
	| { status: "refused"; reason: string }
	| { status: "unavailable"; reason: string };

/** What one watch call settles to; the controller lives in src/interactive/watch-pane.ts. */
export type PanesWatchResult =
	| { status: "watching"; runId: string; paneId: string; opened: boolean }
	| { status: "unavailable"; reason: string };

/**
 * Interactive-only watch-pane controller, attached after the TUI exists. A
 * structural interface here for the same reason {@link PanesYaziController}
 * is: neither the domain nor the tool may import the interactive tree.
 */
export interface PanesWatchController {
	/**
	 * Open (or adopt) the watch pane without retargeting it, for boot
	 * composition under `interface.panes.layout`. False when the host refused.
	 */
	ensureOpen(): Promise<boolean>;
	/** Point the watch pane at a run, opening or adopting the pane first if needed. */
	watch(runId: string): Promise<PanesWatchResult>;
	/** Retarget only; false when no watch pane is open or the write failed. */
	follow(runId: string): boolean;
	isOpen(): boolean;
	dispose(): void;
}

export type PanesOpenResult =
	/** `existing` is true when the preset already had a live pane and it was focused instead of split again. */
	| { status: "opened"; label: string; paneId: string | null; existing?: boolean }
	| { status: "missing-binary"; preset: string; binary: string; installHint: string; detail: string }
	| { status: "refused"; reason: string }
	| { status: "unavailable"; reason: string };

export type PanesZoomResult =
	| { status: "zoomed"; paneId: string; label: string }
	| { status: "not-found"; target: string }
	| { status: "unavailable"; reason: string };

export type PanesCloseResult =
	| { status: "closed"; closed: number; labels: ReadonlyArray<string> }
	| { status: "not-found"; target: string }
	| { status: "unavailable"; reason: string };

/**
 * Interactive-only controller attached after the composer and TUI exist.
 *
 * This structural interface stays in the shared leaf so the panes domain does
 * not import the interactive implementation and the tool does not gain a path
 * into `src/interactive/**`.
 */
export interface PanesYaziController {
	open(options?: {
		once?: boolean;
	}): Promise<
		| { status: "opened"; mode: "companion" | "chooser"; paneId: string | null; existing: boolean }
		| { status: "missing-binary"; binary: "yazi" | "ya"; detail: string }
		| { status: "profile-error"; reason: string }
		| { status: "unavailable"; reason: string }
	>;
	/** Close the files pane if it is open; false when nothing was open. */
	close(): Promise<boolean>;
	/** True while a files pane the host still reports is open. */
	isOpen(): boolean;
	status(): Readonly<PanesYaziStatus>;
}

/** What `/files` and the files keybinding settle to. */
export type PanesFilesResult =
	| { status: "opened"; paneId: string | null; existing: boolean }
	| { status: "closed" }
	| { status: "missing-binary"; binary: string; installHint: string; detail: string }
	| { status: "refused"; reason: string }
	| { status: "unavailable"; reason: string };

/**
 * The operations both callers drive. The tool sees a narrower door: its schema
 * has no argv field at all, and `open` refuses one even if a caller fabricates
 * it.
 */
export interface PanesOperations {
	status(): PanesStatus;
	show(target: string): Promise<PanesShowResult>;
	open(request: { preset?: string; argv?: ReadonlyArray<string>; once?: boolean }): Promise<PanesOpenResult>;
	/**
	 * Toggle zoom on one Clio-owned pane, matched like `close` (pane id, label
	 * substring, then purpose; newest first). Zooming steals focus, so this is
	 * operator-only and never reachable from the model tool.
	 */
	zoom(target: string): Promise<PanesZoomResult>;
	close(target: string): Promise<PanesCloseResult>;
	/**
	 * The files pane as one operator verb. `toggle` opens it when closed and
	 * closes it when open, which is what a keybinding needs; `open` and
	 * `close` are the explicit halves; `pick` borrows the pane for one
	 * selection and closes it afterwards.
	 */
	files(action: "toggle" | "open" | "close" | "pick"): Promise<PanesFilesResult>;
	/** Bind the composer-facing Yazi bridge without rebuilding this shared object. */
	attachYazi(controller: PanesYaziController): () => void;
	/** Bind the workers-view watch controller; `show` routes runs through it. */
	attachWatch(controller: PanesWatchController): () => void;
}
