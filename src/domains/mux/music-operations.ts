/**
 * The music pane's vocabulary, shared by `/music` and the `music` tool.
 *
 * A leaf with no imports for the same reason `operations.ts` is one: the
 * slash command and the tool may not import each other's trees, so the
 * actions and result shape they both speak live here.
 */

/** What the model may ask for. Station changes and showing or hiding the pane stay with the operator. */
export const MUSIC_TOOL_ACTIONS = ["on", "off", "pause", "next", "status"] as const;
export type MusicToolAction = (typeof MUSIC_TOOL_ACTIONS)[number];

/** Where the music pane is: in the layout, parked out of sight but alive, or not running. */
export type MusicDockVisibility = "visible" | "hidden" | "closed";

export type MusicResult =
	| { status: "playing"; title: string | null; opened: boolean }
	| { status: "paused"; title: string | null }
	| { status: "stopped" }
	| { status: "shown"; playing: boolean; title: string | null }
	| { status: "hidden"; playing: boolean; title: string | null }
	| { status: "unavailable"; reason: string }
	| { status: "failed"; reason: string };

/**
 * What is true right now, for Clio to read whether or not she may control the
 * player. `playback` is null while the pane is closed. A player that was
 * stopped from inside the pane counts as paused: both are silent with the pane
 * still open.
 */
export interface MusicState {
	dock: MusicDockVisibility;
	playback: "playing" | "paused" | null;
	title: string | null;
}

export interface MusicOperations {
	/** Why music cannot run in this session, or null when it can. */
	unavailableReason(): string | null;
	/** True while the pane is running, visible or hidden. */
	isOpen(): boolean;
	visibility(): MusicDockVisibility;
	/**
	 * The key and bare `/music`: reveal a hidden pane, hide a visible one, and
	 * open one that is not running and play. Revealing never changes playback.
	 */
	toggle(): Promise<MusicResult>;
	/** Resume playing, revealing the pane (or opening it) first. */
	on(): Promise<MusicResult>;
	/** Stop and close the pane, hidden or not. */
	off(): Promise<MusicResult>;
	/** Silence the stream and keep the pane. Resume with `on`. */
	pause(): Promise<MusicResult>;
	next(): Promise<MusicResult>;
	/** A stream URL, a focus-station name, or any Radio Browser station name. */
	station(nameOrUrl: string): Promise<MusicResult>;
	status(): Promise<MusicResult>;
	/**
	 * Start the pane hidden and silent so the first key press only reveals it.
	 * Best effort and quiet: a failure here is reported by the key that needs it.
	 */
	prepare(): Promise<void>;
	/** Live dock and playback facts, never gated by `integrations.music.agentControl`. */
	state(): Promise<MusicState>;
	/**
	 * Alt+A was pressed inside the player, where Clio's key handler cannot hear
	 * it. Returns the unsubscribe.
	 */
	onDockKey(handler: () => void): () => void;
}

/** One line for a result, shared by every door so they say the same thing. */
export function describeMusicResult(result: MusicResult): string {
	if (result.status === "playing") {
		const what = result.title ? `♫ ${result.title}` : "music playing";
		return result.opened ? `${what} (music pane opened)` : what;
	}
	if (result.status === "paused") return result.title ? `music paused (${result.title})` : "music paused";
	if (result.status === "shown") {
		const what = result.playing ? (result.title ? `♫ ${result.title}` : "music playing") : "music paused";
		return `music pane shown, ${what.replace(/^music /, "")}`;
	}
	if (result.status === "hidden") {
		const still = result.playing ? (result.title ? `, still playing ♫ ${result.title}` : ", still playing") : "";
		return `music pane hidden${still}`;
	}
	if (result.status === "stopped") return "music is off";
	return result.reason;
}

/** How a result should read: a change the operator asked for succeeded, a refusal is a problem, the rest is information. */
export function musicResultTone(result: MusicResult): "success" | "info" | "problem" {
	if (result.status === "playing" || result.status === "shown") return "success";
	if (result.status === "unavailable" || result.status === "failed") return "problem";
	return "info";
}
