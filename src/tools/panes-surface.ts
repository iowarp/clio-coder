import { Type } from "typebox";
import { ToolNames } from "../core/tool-names.js";
import { PANE_PEER_IDS, PANES_PRESET_IDS } from "../domains/mux/operations.js";
import { StringEnum } from "../engine/ai.js";
import type { ToolSurface } from "./lazy-tool.js";

/**
 * The model's door to the pane layer.
 *
 * There is no argv field, and there never will be. Arbitrary argv is
 * operator-only through `/panes open`, which is what keeps this tool out of
 * shell-escape territory (spec 4.8, risk register "tool misuse"). `preset` is a
 * closed enum, so an argv string cannot arrive spelled as a preset name either.
 */
export const panesToolSurface = {
	name: ToolNames.Panes,
	description:
		"Manage Clio-owned panes: show a run, open a utility preset, handoff to a fixed coding CLI, close, or list. A handoff is interactive and has no managed receipt.",
	parameters: Type.Object({
		action: StringEnum(["show", "open", "handoff", "close", "list"], { description: "Pane action." }),
		target: Type.Optional(
			Type.String({
				description:
					'show: an agent id or run id prefix, most recent match wins. close: a pane id, label, agent id, or "all".',
			}),
		),
		preset: Type.Optional(StringEnum([...PANES_PRESET_IDS], { description: "open: which utility pane to start." })),
		peer: Type.Optional(StringEnum([...PANE_PEER_IDS], { description: "handoff: coding peer." })),
		brief: Type.Optional(Type.String({ description: "handoff: task brief, max 8192 bytes." })),
		cwd: Type.Optional(Type.String({ description: "handoff: selected workspace path." })),
	}),
	baseActionClass: "read",
	executionMode: "sequential",
} satisfies ToolSurface;
