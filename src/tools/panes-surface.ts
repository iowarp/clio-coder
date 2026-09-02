import { Type } from "typebox";
import { ToolNames } from "../core/tool-names.js";
import { PANES_PRESET_IDS } from "../domains/mux/operations.js";
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
		"Manage the terminal panes Clio owns beside this session: show focuses a dispatched run's viewer pane, open starts a fixed utility preset (files, logs, or shell; never an arbitrary command) or focuses it when it is already open, close removes a Clio-created pane, list reports the inventory and the pane layer's health.",
	parameters: Type.Object({
		action: StringEnum(["show", "open", "close", "list"], { description: "Pane action." }),
		target: Type.Optional(
			Type.String({
				description:
					'show: an agent id or run id prefix, most recent match wins. close: a pane id, label, agent id, or "all".',
			}),
		),
		preset: Type.Optional(StringEnum([...PANES_PRESET_IDS], { description: "open: which utility pane to start." })),
	}),
	baseActionClass: "read",
	executionMode: "sequential",
} satisfies ToolSurface;
