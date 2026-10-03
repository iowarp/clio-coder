import type { MusicOperations, MusicResult } from "../domains/mux/music-operations.js";
import { describeMusicResult, MUSIC_TOOL_ACTIONS, type MusicToolAction } from "../domains/mux/music-operations.js";
import { musicToolSurface } from "./music-surface.js";
import type { ToolResult, ToolSpec } from "./registry.js";

/**
 * The `music` tool over the same `MusicOperations` `/music` drives. It is
 * registered only when the operator set integrations.music.agentControl and
 * music could play at startup, so a session where it would only refuse never
 * carries it.
 */
export function createMusicTool(deps: { music: MusicOperations }): ToolSpec {
	return {
		...musicToolSurface,
		async run(args): Promise<ToolResult> {
			const action = typeof args.action === "string" ? args.action : "";
			if (!(MUSIC_TOOL_ACTIONS as ReadonlyArray<string>).includes(action)) {
				return { kind: "error", message: `music: action must be one of ${MUSIC_TOOL_ACTIONS.join(", ")}` };
			}
			const run: Record<MusicToolAction, () => Promise<MusicResult>> = {
				on: () => deps.music.on(),
				off: () => deps.music.off(),
				pause: () => deps.music.pause(),
				next: () => deps.music.next(),
				status: () => deps.music.status(),
			};
			const result = await run[action as MusicToolAction]();
			if (result.status === "unavailable" || result.status === "failed") {
				return { kind: "error", message: `music: ${result.reason}` };
			}
			return { kind: "ok", output: describeMusicResult(result), details: { action, ...result } };
		},
	};
}
