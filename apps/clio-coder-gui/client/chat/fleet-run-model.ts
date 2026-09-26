// What a fleet contract preview says, before any of it is drawn: the variables a person typed, and
// the compiled plan as waves of steps. Pure, so parsing and wording are testable without a DOM.

import type { FleetPreview, FleetStep } from "../../contracts/fleet-run.js";

const VAR_NAME = /^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/;

/** `name=value` per line, as `/fleet run <name> key=value` takes them. Blank lines are ignored. */
export function parseFleetVars(text: string): { vars: Record<string, string> } | { error: string } {
	const vars: Record<string, string> = {};
	for (const raw of text.split("\n")) {
		const line = raw.trim();
		if (line === "") continue;
		const equals = line.indexOf("=");
		if (equals <= 0) return { error: `“${line.slice(0, 40)}” is not name=value.` };
		const name = line.slice(0, equals).trim();
		if (!VAR_NAME.test(name)) return { error: `“${name.slice(0, 40)}” is not a variable name.` };
		if (Object.hasOwn(vars, name)) return { error: `${name} is set twice.` };
		vars[name] = line.slice(equals + 1).trim();
	}
	return Object.keys(vars).length > 32 ? { error: "A fleet run takes at most 32 variables." } : { vars };
}

export interface FleetStepRow {
	key: string;
	step: string;
	who: string;
	/** Target and model, or the command's arguments. */
	where: string | null;
	/** Scope, declared writes, loop and gate, in words. */
	notes: string[];
}

function describeStep(step: FleetStep): FleetStepRow {
	const notes: string[] = [step.scope === "readonly" ? "Reads only" : "May change the workspace"];
	if (step.writes !== null)
		notes.push(step.writes.length === 0 ? "Declares no writes" : `Writes ${step.writes.join(", ")}`);
	if (step.loop) notes.push(`${step.loop.role === "check" ? "Check" : "Repair"} attempt ${step.loop.attempt}`);
	if (step.gate) notes.push(`Gate ${step.gate.path}`);
	const where =
		step.kind === "code"
			? step.argv && step.argv.length > 0
				? step.argv.join(" ")
				: null
			: step.route
				? [step.route.targetId, step.route.model, step.route.nodeId === "local" ? null : `on ${step.route.nodeId}`]
						.filter(Boolean)
						.join(" · ")
				: (step.target ?? null);
	return {
		key: step.stepId,
		step: step.stepId,
		who: step.kind === "code" ? `command ${step.commandId ?? "?"}` : (step.agentId ?? "unnamed agent"),
		where,
		notes,
	};
}

export function fleetPlanView(preview: Extract<FleetPreview, { status: "ready" }>) {
	const { ceilingUsd, currentUsd, contractUsd } = preview.budget;
	return {
		heading: `${preview.stepCount} ${preview.stepCount === 1 ? "step" : "steps"} in ${preview.waves.length} ${preview.waves.length === 1 ? "wave" : "waves"}`,
		waves: preview.waves.map((wave) => ({ label: `Wave ${wave.index + 1}`, rows: wave.steps.map(describeStep) })),
		budget:
			ceilingUsd > 0
				? `$${currentUsd.toFixed(2)} of this session's $${ceilingUsd.toFixed(2)} ceiling is spent${contractUsd === null ? "" : `; the contract asks for up to $${contractUsd.toFixed(2)}`}.`
				: contractUsd === null
					? "No budget ceiling is set for this session or the contract."
					: `The contract asks for up to $${contractUsd.toFixed(2)}; this session has no ceiling.`,
		hash: { short: preview.planHash.slice(0, 12), full: preview.planHash },
		truncated: preview.truncated,
	};
}
