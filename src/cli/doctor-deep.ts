import { accessSync, constants, statSync } from "node:fs";
import path from "node:path";
import { ToolNames } from "../core/tool-names.js";
import { resolveOnPath } from "../domains/interop/detect.js";
import type { DoctorFinding } from "../domains/lifecycle/doctor.js";
import type { ProvidersContract, TargetStatus } from "../domains/providers/contract.js";
import { type AutonomyLevel, mapAutonomy } from "../domains/safety/autonomy.js";
import { createSafetyPolicyEngine } from "../domains/safety/policy-engine.js";
import { loadValidationContract } from "../domains/safety/validation-contract.js";

export interface DeepToolProbeOptions {
	/** Tool-probe generation timeout in ms; the provider default applies when absent. */
	toolsTimeoutMs?: number;
}

function toolProbeFinding(status: TargetStatus): DoctorFinding {
	const name = `tools ${status.target.id}`;
	const probe = status.toolProbe;
	if (!probe) {
		// The tool probe runs only once the target answered its health probe.
		const reason = status.reason || status.health.lastError || "the target did not answer";
		return { ok: true, name, level: "warn", detail: `not probed: ${reason}` };
	}
	const model = probe.modelId ?? "no model";
	if (probe.status === "verified") {
		return { ok: true, name, level: "ok", detail: `${model} streamed a valid tool call in ${probe.latencyMs}ms` };
	}
	if (probe.status === "skipped") {
		return { ok: true, name, level: "info", detail: `skipped (${model}): ${probe.error ?? "no reason given"}` };
	}
	return { ok: true, name, level: "warn", detail: `failed (${model}): ${probe.error ?? "unknown error"}` };
}

/**
 * The live tool-call probe on every configured target, one row each. The
 * probe loads a cold local model when it has to and releases only the model it
 * loaded, so it is safe in a process that is also running chat turns.
 */
export async function deepToolProbeFindings(
	providers: ProvidersContract,
	options: DeepToolProbeOptions = {},
): Promise<DoctorFinding[]> {
	await providers.probeAllLive({
		tools: true,
		...(options.toolsTimeoutMs !== undefined ? { toolsTimeoutMs: options.toolsTimeoutMs } : {}),
	});
	return providers.list().map(toolProbeFinding);
}

/** The program a validator command runs: its first word after any `NAME=value` assignments. */
function commandProgram(command: string): string | null {
	for (const word of command.trim().split(/\s+/)) {
		if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) continue;
		return word.length > 0 ? word : null;
	}
	return null;
}

function resolveProgram(program: string, workspaceRoot: string): string | null {
	if (!program.includes("/")) {
		const found = resolveOnPath([program]);
		return found.presence === "present" ? (found.binary ?? null) : null;
	}
	const candidate = path.resolve(workspaceRoot, program);
	try {
		accessSync(candidate, constants.X_OK);
		return statSync(candidate).isFile() ? candidate : null;
	} catch {
		return null;
	}
}

export interface ContractDryRunOptions {
	workspaceRoot?: string;
	autonomy: AutonomyLevel;
}

/**
 * Dry run of the workspace validation contract. Each declared validator
 * command is resolved on PATH and handed to the same two stages tool
 * admission applies to a bash call: the policy engine's verdict, then the
 * autonomy mapping at the configured level. Nothing is executed. A row warns
 * when the program is missing or when the command would stop for approval or
 * be refused, because either one stalls an unattended validation.
 */
export function contractDryRunFindings(options: ContractDryRunOptions): DoctorFinding[] {
	const workspaceRoot = options.workspaceRoot ?? process.cwd();
	const loaded = loadValidationContract(workspaceRoot);
	if (!loaded.ok || loaded.contract === null) return [];
	const validators = loaded.contract.validators ?? [];
	if (validators.length === 0) return [];
	const engine = createSafetyPolicyEngine({ cwd: workspaceRoot });
	const level = options.autonomy;
	return validators.map((command, index): DoctorFinding => {
		const name = `validator ${index + 1}`;
		const program = commandProgram(command);
		const resolved = program === null ? null : resolveProgram(program, workspaceRoot);
		const where =
			program === null ? "no program" : resolved === null ? `${program} not found` : `${program} is ${resolved}`;
		const decision = engine.evaluate({ tool: ToolNames.Bash, args: { command } });
		let verdict: string;
		let runs = false;
		if (decision.kind === "block") {
			verdict = `blocked by the safety policy (${decision.reasonCode})`;
		} else if (decision.kind === "ask") {
			verdict = `asks for approval at every autonomy level (${decision.reasonCode})`;
		} else {
			const disposition = mapAutonomy(level, decision.actionClass, {
				executeRecognized: decision.execRecognition !== "unrecognized",
			});
			runs = disposition === "allow";
			verdict =
				disposition === "allow"
					? `runs without approval at ${level}`
					: disposition === "ask"
						? `asks for approval at ${level}; declare it in .clio-coder/safety.yaml to run it unattended`
						: `denied at ${level}`;
		}
		return {
			ok: true,
			name,
			level: runs && resolved !== null ? "ok" : "warn",
			detail: `\`${command}\`: ${where}; ${verdict}`,
		};
	});
}
