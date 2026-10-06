import { Type } from "typebox";
import { ToolNames } from "../core/tool-names.js";
import type { ToolSurface } from "./lazy-tool.js";

export const writeToolSurface = {
	name: ToolNames.Write,
	description:
		"Write a UTF-8 text file, creating parent directories and overwriting an existing file. Use edit for a partial change. Publishes atomically through symlinks, preserving mode bits. External writers are not locked and the last rename wins.",
	parameters: Type.Object({
		path: Type.String({ description: "File path (relative or absolute)." }),
		content: Type.String({ description: "Full UTF-8 file contents." }),
	}),
	baseActionClass: "write",
	executionMode: "sequential",
} satisfies ToolSurface;
