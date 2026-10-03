import { Type } from "typebox";
import { ToolNames } from "../core/tool-names.js";
import { MUSIC_TOOL_ACTIONS } from "../domains/mux/music-operations.js";
import { StringEnum } from "../engine/ai.js";
import type { ToolSurface } from "./lazy-tool.js";

/**
 * The model's door to the music pane. The description is the only text the
 * model sees about music: when to play it is the operator's call, written in
 * their project instructions, so no prompt fragment carries it.
 */
export const musicToolSurface = {
	name: ToolNames.Music,
	description:
		"Control the focus-radio music pane beside this session: on opens it and plays, off stops and closes it, next skips to the next station, status reports what is playing.",
	parameters: Type.Object({
		action: StringEnum([...MUSIC_TOOL_ACTIONS], { description: "Music action." }),
	}),
	baseActionClass: "read",
	executionMode: "sequential",
} satisfies ToolSurface;
