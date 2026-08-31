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
		"Look at, focus, and manage the terminal panes Clio owns beside this session. Use show to bring a dispatched run's live viewer pane to the front when the operator asks to see an agent (\"show me the tester\"). open starts one of the fixed utility presets; there is no way to run an arbitrary command. close removes a pane Clio created. list reports the current inventory and the pane layer's health.",
	parameters: Type.Object({
		action: StringEnum(["show", "open", "close", "list"], {
			description:
				"show focuses a run's viewer pane; open starts a preset utility pane; close removes a Clio-owned pane; list reports the inventory.",
		}),
		target: Type.Optional(
			Type.String({
				description:
					'action=show: an agent id or run id prefix, most recent match wins. action=close: a pane id, a pane label, an agent id, or "all".',
			}),
		),
		preset: Type.Optional(
			StringEnum([...PANES_PRESET_IDS], {
				description: "action=open: which fixed utility pane to start.",
			}),
		),
	}),
	baseActionClass: "read",
	executionMode: "sequential",
} satisfies ToolSurface;
