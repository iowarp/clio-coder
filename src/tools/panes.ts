import { UNTRUSTED_CONTENT_BANNER } from "../core/untrusted-content.js";
import type { PanesOperations } from "../domains/mux/operations.js";
import {
	PANE_INTERRUPT_KEYS,
	PANE_PEER_IDS,
	PANES_PRESET_IDS,
	type PaneInterruptKey,
	type PanePeerId,
} from "../domains/mux/operations.js";
import { flowHandoffRefusal } from "../domains/safety/information-flow.js";
import { panesToolSurface } from "./panes-surface.js";
import type { RegistryDeps, ToolResult, ToolSpec } from "./registry.js";

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
	flow?: RegistryDeps["flow"];
}

async function describeInventory(deps: PanesToolDeps): Promise<ToolResult> {
	const status = deps.panes.status();
	const docks = status.available ? await deps.panes.docks() : [];
	const header = `panes mode=${status.mode} ${status.available ? "available" : "unavailable"}; notifications=${status.settings.notifications}`;
	// The docks line is the live state settings files cannot give: hidden docks
	// are still running, and the music pane says what it is playing.
	const dockLine = docks.map((dock) => `${dock.slot} ${dock.state}${dock.detail ? ` (${dock.detail})` : ""}`).join("; ");
	const rows = status.panes.map((pane) => `- ${pane.paneId} ${pane.purpose} ${pane.label}`);
	return {
		kind: "ok",
		output: [
			header,
			...(dockLine.length > 0 ? [`docks: ${dockLine}`] : []),
			...(rows.length > 0 ? rows : ["- no Clio-owned panes"]),
		].join("\n"),
		details: { action: "list", mode: status.mode, available: status.available, docks, panes: status.panes },
	};
}

/** The shared failure wording for the three actions that address a handoff pane. */
function handoffMiss(
	result: { status: "not-found"; target: string } | { status: "refused" | "unavailable"; reason: string },
): string {
	return result.status === "not-found"
		? `no handoff pane matches '${result.target}'; open one with action=handoff`
		: result.reason;
}

export function createPanesTool(deps: PanesToolDeps): ToolSpec {
	return {
		...panesToolSurface,
		async run(args, options): Promise<ToolResult> {
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
			if (action === "list") return await describeInventory(deps);
			if (action === "show") {
				if (target.length === 0) return { kind: "error", message: "panes: action=show requires target" };
				const result = await deps.panes.show(target);
				if (result.status === "watching") {
					return {
						kind: "ok",
						output: `the workers dock is now following ${result.agentId} (run ${result.runId}).`,
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
								? `completed the ${result.label} pick.`
								: result.revealed
									? `the ${result.label} pane was hidden and is now shown and focused (${result.paneId}).`
									: result.existing
										? `the ${result.label} pane was already open and is now focused (${result.paneId}).`
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
			if (action === "handoff") {
				const peer = typeof args.peer === "string" ? args.peer : "";
				if (!(PANE_PEER_IDS as ReadonlyArray<string>).includes(peer)) {
					return { kind: "error", message: `panes: handoff requires peer, one of ${PANE_PEER_IDS.join(", ")}` };
				}
				if (args.brief !== undefined && typeof args.brief !== "string")
					return { kind: "error", message: "panes: brief must be text" };
				if (args.cwd !== undefined && typeof args.cwd !== "string")
					return { kind: "error", message: "panes: cwd must be text" };
				if (typeof args.brief === "string") {
					const refusal = deps.flow?.refusal() ?? flowHandoffRefusal("panes-handoff", deps.flow?.carried() ?? null);
					if (refusal !== null) return { kind: "error", message: refusal };
				}
				const result = await deps.panes.handoff({
					peer: peer as PanePeerId,
					...(typeof args.brief === "string" ? { brief: args.brief } : {}),
					...(typeof args.cwd === "string" ? { cwd: args.cwd } : {}),
				});
				if (result.status === "opened") {
					return {
						kind: "ok",
						output: `opened ${peer} in Clio-owned pane ${result.paneId}; interactive handoff in ${result.cwd}; no managed run or receipt is produced.`,
						details: { action: "handoff", peer, paneId: result.paneId, workspace: result.cwd, managed: false },
					};
				}
				return { kind: "error", message: `panes: ${result.status === "missing-binary" ? result.detail : result.reason}` };
			}
			if (action === "send") {
				if (target.length === 0) return { kind: "error", message: "panes: action=send requires target" };
				if (args.text !== undefined && typeof args.text !== "string")
					return { kind: "error", message: "panes: text must be text" };
				if ("keys" in args) {
					return {
						kind: "error",
						message: `panes: send takes no keys; use interrupt, one of ${PANE_INTERRUPT_KEYS.join(", ")}`,
					};
				}
				const interrupt = typeof args.interrupt === "string" ? args.interrupt : undefined;
				if (interrupt !== undefined && !(PANE_INTERRUPT_KEYS as ReadonlyArray<string>).includes(interrupt)) {
					return { kind: "error", message: `panes: interrupt must be one of ${PANE_INTERRUPT_KEYS.join(", ")}` };
				}
				// Typed input leaves the session the same way a handoff brief does.
				if (typeof args.text === "string" && args.text.length > 0) {
					const refusal = deps.flow?.refusal() ?? flowHandoffRefusal("panes-handoff", deps.flow?.carried() ?? null);
					if (refusal !== null) return { kind: "error", message: refusal };
				}
				const result = await deps.panes.send({
					target,
					...(typeof args.text === "string" ? { text: args.text } : {}),
					...(interrupt !== undefined ? { interrupt: interrupt as PaneInterruptKey } : {}),
					...(options?.signal ? { signal: options.signal } : {}),
				});
				if (result.status === "unconfirmed") {
					return {
						kind: "ok",
						output: `not confirmed for ${result.label} (${result.paneId}): ${result.reason}.`,
						details: { action: "send", paneId: result.paneId, confirmed: false },
					};
				}
				if (result.status === "sent") {
					return {
						kind: "ok",
						output: result.queued
							? `${result.label} (${result.paneId}) is mid-run and holds the prompt until its current turn finishes. Use action=wait, then action=read.`
							: `sent to ${result.label} (${result.paneId}). Use action=wait, then action=read.`,
						details: { action: "send", paneId: result.paneId },
					};
				}
				return { kind: "error", message: `panes: ${handoffMiss(result)}` };
			}
			if (action === "wait") {
				if (target.length === 0) return { kind: "error", message: "panes: action=wait requires target" };
				const result = await deps.panes.wait(target, {
					...(typeof args.timeout_ms === "number" ? { timeoutMs: args.timeout_ms } : {}),
					...(options?.signal ? { signal: options.signal } : {}),
				});
				if (result.status === "settled") {
					return {
						kind: "ok",
						output:
							result.state === "blocked"
								? `${result.label} is blocked: it is asking its operator for an approval or an answer. Read it and report; do not answer for the operator.`
								: `${result.label} settled (${result.state}). Read it with action=read.`,
						details: { action: "wait", paneId: result.paneId, state: result.state },
					};
				}
				if (result.status === "cancelled")
					return { kind: "error", message: `panes: the wait on ${result.label} was cancelled` };
				if (result.status === "timed-out") {
					return {
						kind: "ok",
						output: `${result.label} has not settled: its state is ${result.state} after the wait budget, so nothing is known to have finished. Read it, or wait again.`,
						details: { action: "wait", paneId: result.paneId, state: result.state, timedOut: true },
					};
				}
				if (result.status === "gone") return { kind: "error", message: `panes: ${result.target} has closed` };
				return { kind: "error", message: `panes: ${handoffMiss(result)}` };
			}
			if (action === "read") {
				if (target.length === 0) return { kind: "error", message: "panes: action=read requires target" };
				const result = await deps.panes.read(target, typeof args.lines === "number" ? args.lines : undefined);
				if (result.status === "read") {
					return {
						kind: "ok",
						output: `${UNTRUSTED_CONTENT_BANNER}\n--- ${result.label} (${result.paneId})${result.truncated ? ", truncated" : ""} ---\n${result.text}`,
						details: { action: "read", paneId: result.paneId, truncated: result.truncated },
					};
				}
				return { kind: "error", message: `panes: ${handoffMiss(result)}` };
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
			return {
				kind: "error",
				message: `panes: action must be show, open, handoff, send, wait, read, close, or list; got '${action}'`,
			};
		},
	};
}
