/**
 * The music pane's vocabulary, shared by `/music` and the `music` tool.
 *
 * A leaf with no imports for the same reason `operations.ts` is one: the
 * slash command and the tool may not import each other's trees, so the
 * actions and result shape they both speak live here.
 */

/** What the model may ask for. Station changes stay with the operator. */
export const MUSIC_TOOL_ACTIONS = ["on", "off", "next", "status"] as const;
export type MusicToolAction = (typeof MUSIC_TOOL_ACTIONS)[number];

export type MusicResult =
	| { status: "playing"; title: string | null; opened: boolean }
	| { status: "stopped" }
	| { status: "unavailable"; reason: string }
	| { status: "failed"; reason: string };

export interface MusicOperations {
	/** Why music cannot run in this session, or null when it can. */
	unavailableReason(): string | null;
	isOpen(): boolean;
	/** Open the pane and play, or stop and close it. */
	toggle(): Promise<MusicResult>;
	on(): Promise<MusicResult>;
	off(): Promise<MusicResult>;
	next(): Promise<MusicResult>;
	/** A stream URL, a focus-station name, or any Radio Browser station name. */
	station(nameOrUrl: string): Promise<MusicResult>;
	status(): Promise<MusicResult>;
}

/** One line for a result, shared by every door so they say the same thing. */
export function describeMusicResult(result: MusicResult): string {
	if (result.status === "playing") {
		const what = result.title ? `♫ ${result.title}` : "music playing";
		return result.opened ? `${what} (music pane opened)` : what;
	}
	if (result.status === "stopped") return "music is off";
	return result.reason;
}
