/**
 * `_clio-coder/fleet/preview` and `_clio-coder/fleet/run`: the terminal's
 * `/fleet run <name>` approval, split so a client can show the plan and send
 * back the hash it approved.
 *
 * Preview compiles the contract through the shared dispatch-domain compiler
 * and dispatches nothing. Run compiles it again and starts it only when the
 * fresh plan hashes to exactly what the client approved; a contract, agent or
 * route that changed in between is refused before any step is dispatched.
 *
 * The projection carries what the terminal overlay shows a person: waves,
 * steps, routes, declared write boundaries, gates and the budget. The
 * compiled plan itself and the rendered task stay host-side.
 */

import type { FleetRunPreview, FleetRunPreviewResult } from "../../domains/dispatch/index.js";

export const ACP_FLEET_META_KEY = "clio-coder/fleet";
export const ACP_FLEET_PREVIEW_METHOD = "_clio-coder/fleet/preview";
export const ACP_FLEET_RUN_METHOD = "_clio-coder/fleet/run";
export const ACP_FLEET_MAX_STEPS = 64;
const MAX_TEXT_BYTES = 512;
const MAX_DIAGNOSTICS = 32;
const MAX_DIAGNOSTIC_BYTES = 1024;
const MAX_LIST = 16;

/** What the composition root binds; the server never compiles or dispatches a plan itself. */
export interface AcpFleetControl {
	preview(name: string, vars: Readonly<Record<string, string>>): FleetRunPreviewResult;
	/** Start an approved, freshly compiled plan. Returns once the run is admitted, not when it ends. */
	run(preview: FleetRunPreview): { fleetRootId: string };
}

type AcpFleetStep = {
	stepId: string;
	kind: "agent" | "code";
	scope: "readonly" | "workspace";
	agentId?: string;
	commandId?: string;
	argv?: string[];
	/** Declared write boundary; null is no claim, an empty list is the claim "changes nothing". */
	writes: string[] | null;
	route?: { targetId: string; model: string; nodeId: string; endpoint?: { label: string; limit: number } };
	loop?: { loopId: string; role: "check" | "repair"; attempt: number };
	gate?: { path: string };
	target?: string;
	profile?: string;
};

export type AcpFleetPreview =
	| {
			status: "ready";
			name: string;
			planHash: string;
			stepCount: number;
			waves: Array<{ index: number; steps: AcpFleetStep[] }>;
			budget: { ceilingUsd: number; currentUsd: number; contractUsd: number | null };
			/** True when steps were cut at {@link ACP_FLEET_MAX_STEPS}. */
			truncated: boolean;
	  }
	| { status: "refused"; name: string; diagnostics: string[] };

function bounded(text: string, maxBytes = MAX_TEXT_BYTES): string {
	let safe = "";
	for (const character of text) {
		const code = character.codePointAt(0) ?? 0;
		safe += code <= 0x1f || code === 0x7f ? " " : character;
	}
	if (Buffer.byteLength(safe, "utf8") <= maxBytes) return safe;
	let cut = safe.slice(0, maxBytes);
	while (Buffer.byteLength(cut, "utf8") > maxBytes - 3) cut = cut.slice(0, -1);
	return `${cut}…`;
}

export function projectFleetPreview(result: FleetRunPreviewResult): AcpFleetPreview {
	if (!result.ok) {
		return {
			status: "refused",
			name: bounded(result.name),
			diagnostics: result.diagnostics.slice(0, MAX_DIAGNOSTICS).map((line) => bounded(line, MAX_DIAGNOSTIC_BYTES)),
		};
	}
	const { preview } = result;
	let budget = ACP_FLEET_MAX_STEPS;
	let truncated = false;
	const waves = preview.waves.map((wave) => {
		const kept = wave.steps.slice(0, Math.max(0, budget));
		if (kept.length < wave.steps.length) truncated = true;
		budget -= kept.length;
		return {
			index: wave.index,
			steps: kept.map(
				(step): AcpFleetStep => ({
					stepId: bounded(step.stepId),
					kind: step.kind === "code" ? "code" : "agent",
					scope: step.scope,
					...(step.agentId !== undefined ? { agentId: bounded(step.agentId) } : {}),
					...(step.commandId !== undefined ? { commandId: bounded(step.commandId) } : {}),
					...(step.argv !== undefined ? { argv: step.argv.slice(0, MAX_LIST).map((arg) => bounded(arg)) } : {}),
					writes: step.writes === undefined ? null : step.writes.slice(0, MAX_LIST).map((path) => bounded(path)),
					...(step.route !== undefined
						? {
								route: {
									targetId: bounded(step.route.targetId),
									model: bounded(step.route.wireModelId),
									nodeId: bounded(step.route.nodeId),
									...(step.route.endpoint !== undefined
										? { endpoint: { label: bounded(step.route.endpoint.label), limit: step.route.endpoint.limit } }
										: {}),
								},
							}
						: {}),
					...(step.loop !== undefined ? { loop: { ...step.loop, loopId: bounded(step.loop.loopId) } } : {}),
					...(step.gate !== undefined ? { gate: { path: bounded(step.gate.path) } } : {}),
					...(step.target !== undefined ? { target: bounded(step.target) } : {}),
					...(step.profile !== undefined ? { profile: bounded(step.profile) } : {}),
				}),
			),
		};
	});
	return {
		status: "ready",
		name: bounded(preview.name),
		planHash: preview.planHash,
		stepCount: preview.plan.steps.length,
		waves: waves.filter((wave) => wave.steps.length > 0),
		budget: { ...preview.budget },
		truncated,
	};
}
