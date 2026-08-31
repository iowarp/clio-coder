import type { PanesOperations } from "../domains/mux/operations.js";
import { PANES_PRESET_IDS } from "../domains/mux/operations.js";
import { panesToolSurface } from "./panes-surface.js";
import type { ToolResult, ToolSpec } from "./registry.js";

/**
 * The `panes` tool: the model's read-class door to the pane layer.
 *
 * It is registered only when the mux answered detection, so its presence in the
 * prompt is itself the statement that panes exist in this session. Every action
 * routes through the same `PanesOperations` the `/panes` slash command drives,
 * so the two surfaces cannot describe the same pane differently.
 *
 * The one asymmetry with the operator's surface is deliberate: `open` accepts a
 * preset and nothing else. A caller that fabricates an `argv` field gets a
 * refusal rather than a shell.
 */

export interface PanesToolDeps {
	panes: PanesOperations;
}

function describeInventory(deps: PanesToolDeps): ToolResult {
	const status = deps.panes.status();
	const header = `panes mode=${status.mode} ${status.available ? "available" : "unavailable"}; notifications=${status.settings.notifications}`;
	const rows = status.panes.map((pane) => `- ${pane.paneId} ${pane.purpose} ${pane.label}`);
	return {
		kind: "ok",
		output: [header, ...(rows.length > 0 ? rows : ["- no Clio-owned panes"])].join("\n"),
		details: { action: "list", mode: status.mode, available: status.available, panes: status.panes },
	};
}

export function createPanesTool(deps: PanesToolDeps): ToolSpec {
	return {
		...panesToolSurface,
		async run(args): Promise<ToolResult> {
			const action = typeof args.action === "string" ? args.action : "";
			// An argv field never reaches the operations layer. Refusing loudly is
			// better than ignoring it, because a model that believed it opened a
			// command pane would report work it did not do.
			if ("argv" in args) {
				return {
					kind: "error",
					message:
						"panes: argv panes are operator-only; use action=open with a preset, or ask the operator to run /panes open <command>",
				};
			}
			const target = typeof args.target === "string" ? args.target.trim() : "";
			if (action === "list") return describeInventory(deps);
			if (action === "show") {
				if (target.length === 0) return { kind: "error", message: "panes: action=show requires target" };
				const result = await deps.panes.show(target);
				if (result.status === "watching") {
					return {
						kind: "ok",
						output: `the watch pane is now rendering ${result.agentId} (run ${result.runId}).`,
						details: { action: "show", runId: result.runId, agentId: result.agentId },
					};
				}
				if (result.status === "not-found") {
					const known = result.candidates.length > 0 ? ` Live runs: ${result.candidates.join(", ")}.` : "";
					return { kind: "error", message: `panes: no live run matches '${result.target}'.${known}` };
				}
				return { kind: "error", message: `panes: ${result.reason}` };
			}
			if (action === "open") {
				const preset = typeof args.preset === "string" ? args.preset : "";
				if (!(PANES_PRESET_IDS as ReadonlyArray<string>).includes(preset)) {
					return {
						kind: "error",
						message: `panes: action=open requires preset, one of ${PANES_PRESET_IDS.join(", ")}`,
					};
				}
				const result = await deps.panes.open({ preset });
				if (result.status === "opened") {
					return {
						kind: "ok",
						output:
							result.paneId === null
								? `completed the ${result.label} chooser.`
								: `opened the ${result.label} pane (${result.paneId}).`,
						details: { action: "open", preset, paneId: result.paneId },
					};
				}
				if (result.status === "missing-binary") {
					return {
						kind: "error",
						message: `panes: ${result.detail}`,
					};
				}
				return { kind: "error", message: `panes: ${result.reason}` };
			}
			if (action === "close") {
				if (target.length === 0) return { kind: "error", message: "panes: action=close requires target" };
				const result = await deps.panes.close(target);
				if (result.status === "closed") {
					return {
						kind: "ok",
						output: `closed ${result.closed} pane(s)${result.labels.length > 0 ? `: ${result.labels.join(", ")}` : ""}.`,
						details: { action: "close", closed: result.closed },
					};
				}
				if (result.status === "not-found") {
					return { kind: "error", message: `panes: no Clio-owned pane matches '${result.target}'` };
				}
				return { kind: "error", message: `panes: ${result.reason}` };
			}
			return { kind: "error", message: `panes: action must be show, open, close, or list; got '${action}'` };
		},
	};
}
