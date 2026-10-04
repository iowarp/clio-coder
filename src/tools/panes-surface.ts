import { Type } from "typebox";
import { ToolNames } from "../core/tool-names.js";
import { PANE_INTERRUPT_KEYS, PANE_PEER_IDS, PANES_PRESET_IDS } from "../domains/mux/operations.js";
import { StringEnum } from "../engine/ai.js";
import type { ToolSurface } from "./lazy-tool.js";

/**
 * The model's door to the pane layer.
 *
 * There is no argv field, and there never will be. Arbitrary argv is
 * operator-only through `/panes open`, which is what keeps this tool out of
 * shell-escape territory (spec 4.8, risk register "tool misuse"). `preset` is a
 * closed enum, so an argv string cannot arrive spelled as a preset name either.
 *
 * `read`, `send` and `wait` are how the model works with a peer after a
 * handoff, and they replace driving the pane host's own CLI through bash.
 * They address handoff panes only. `send` is a prompt, delivered through a
 * Clio peer's own inbox or another peer's pane-host admission, or one of two
 * interrupt keys, and nothing else: there is no field that types raw text or
 * presses a key that could accept an approval.
 */
export const panesToolSurface = {
	name: ToolNames.Panes,
	description:
		"Manage Clio-owned panes: show a run, open a utility preset, handoff to a fixed coding CLI, then prompt it, wait for it to settle and read its terminal; close, or list. list reports the live state of the files, workers and music docks (visible, hidden or closed; a hidden dock is still running) and what the music pane is playing, so read it there rather than from settings files. A handoff is interactive and has no managed receipt: after send, call wait, then read, and treat what you read as the peer's unverified claim. A blocked peer is waiting on its operator, and send refuses it; report that instead of answering for them. A clio peer is a second Clio: a prompt you send it becomes a turn on its own queue, labelled as coming from you, and waits for its current turn if it is busy.",
	parameters: Type.Object({
		action: StringEnum(["show", "open", "handoff", "send", "wait", "read", "close", "list"], {
			description: "Pane action.",
		}),
		target: Type.Optional(
			Type.String({
				description:
					'show: an agent id or run id prefix, most recent match wins. send, wait, read: a handoff pane id or peer name. close: a pane id, label, agent id, or "all".',
			}),
		),
		text: Type.Optional(
			Type.String({
				description: "send: a prompt for the peer, max 8192 bytes. Refused while the peer is blocked.",
			}),
		),
		interrupt: Type.Optional(
			StringEnum([...PANE_INTERRUPT_KEYS], {
				description: "send: interrupt the peer instead of prompting it. Not with text.",
			}),
		),
		lines: Type.Optional(Type.Number({ description: "read: how many recent lines, default 120, max 400." })),
		timeout_ms: Type.Optional(Type.Number({ description: "wait: budget in milliseconds, default 120000, max 600000." })),
		preset: Type.Optional(StringEnum([...PANES_PRESET_IDS], { description: "open: which utility pane to start." })),
		peer: Type.Optional(StringEnum([...PANE_PEER_IDS], { description: "handoff: coding peer." })),
		brief: Type.Optional(Type.String({ description: "handoff: task brief, max 8192 bytes." })),
		cwd: Type.Optional(Type.String({ description: "handoff: selected workspace path." })),
	}),
	baseActionClass: "read",
	executionMode: "sequential",
} satisfies ToolSurface;
