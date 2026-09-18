import { tmpdir } from "node:os";
import path from "node:path";
import { runCommandVector } from "../core/safe-exec.js";
import { resolveOnPath } from "../domains/interop/detect.js";
import type { DoctorFinding } from "../domains/lifecycle/doctor.js";
import { loadValidationContract, type ValidationContract } from "../domains/safety/validation-contract.js";

/** Each `--version` spawn gets this long before it is killed and reported as silent. */
export const HPC_VERSION_TIMEOUT_MS = 2_000;
const HPC_VERSION_MAX_OUTPUT_BYTES = 4096;

export interface HpcToolSpec {
	/** Row name and the name a validation contract uses for the tool. */
	name: string;
	/** Binaries tried in order on PATH; the first found answers for the row. */
	binaries: ReadonlyArray<string>;
}

/** The compilers, MPI launchers, build systems, and schedulers doctor looks for. */
export const HPC_TOOLS: ReadonlyArray<HpcToolSpec> = [
	{ name: "cc", binaries: ["cc", "gcc"] },
	{ name: "c++", binaries: ["c++", "g++"] },
	{ name: "clang", binaries: ["clang"] },
	{ name: "gfortran", binaries: ["gfortran"] },
	{ name: "mpicc", binaries: ["mpicc"] },
	{ name: "mpicxx", binaries: ["mpicxx"] },
	{ name: "mpirun", binaries: ["mpirun"] },
	{ name: "nvcc", binaries: ["nvcc"] },
	{ name: "cmake", binaries: ["cmake"] },
	{ name: "make", binaries: ["make"] },
	{ name: "ninja", binaries: ["ninja"] },
	{ name: "meson", binaries: ["meson"] },
	{ name: "python3", binaries: ["python3"] },
	{ name: "sbatch", binaries: ["sbatch"] },
];

export interface HpcToolchainOptions {
	workspaceRoot?: string;
	timeoutMs?: number;
}

/**
 * Why the workspace needs a tool, or null when nothing asks for it. The
 * contract names a tool when one of its validator commands has a word whose
 * basename is one of the tool's binaries; `runtime.kind: slurm` needs sbatch.
 */
function requiredBy(contract: ValidationContract | null, tool: HpcToolSpec): string | null {
	if (contract === null) return null;
	if (tool.name === "sbatch" && contract.runtime?.kind === "slurm") return "runtime.kind slurm needs it";
	for (const command of contract.validators ?? []) {
		const words = command.split(/[\s;&|()<>`"']+/).filter((word) => word.length > 0);
		if (words.some((word) => tool.binaries.includes(path.basename(word)))) {
			return "the validation contract names it";
		}
	}
	return null;
}

function lines(text: string): string[] {
	return text
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => line.length > 0);
}

interface VersionProbe {
	/** The first output line carrying a dotted version number, else the first line. */
	line: string;
	/** Set when `--version` failed, which marks an installed tool that does not work. */
	fault?: string;
}

async function versionLine(binary: string, timeoutMs: number): Promise<VersionProbe> {
	// A scratch cwd, as interop's version probe uses: a tool that reads config
	// from its working directory must not pick up the workspace's.
	const cwd = tmpdir();
	const result = await runCommandVector(binary, ["--version"], {
		cwd,
		workspaceRoot: cwd,
		timeoutMs,
		maxOutputBytes: HPC_VERSION_MAX_OUTPUT_BYTES,
	});
	if (result.timedOut) return { line: `no version line (--version did not answer within ${timeoutMs}ms)` };
	const output = lines(`${result.stdout}\n${result.stderr}`);
	const line = output.find((entry) => /\d+\.\d+/.test(entry)) ?? output[0] ?? "no version line";
	if (result.exitCode !== 0) return { line, fault: `--version exited ${result.exitCode ?? "on a signal"}` };
	return { line };
}

async function probeTool(
	tool: HpcToolSpec,
	contract: ValidationContract | null,
	timeoutMs: number,
): Promise<DoctorFinding> {
	const name = `toolchain ${tool.name}`;
	const resolved = resolveOnPath(tool.binaries);
	if (resolved.presence === "present" && resolved.binary !== undefined) {
		const version = await versionLine(resolved.binary, timeoutMs);
		if (version.fault !== undefined) {
			return { ok: true, name, level: "warn", detail: `${resolved.binary}: ${version.fault}: ${version.line}` };
		}
		return { ok: true, name, level: "ok", detail: `${resolved.binary}: ${version.line}` };
	}
	const where = resolved.presence === "unknown" ? "PATH could not be read" : "not on PATH";
	const reason = requiredBy(contract, tool);
	if (reason !== null) return { ok: true, name, level: "warn", detail: `${where}; ${reason}` };
	return { ok: true, name, level: "info", detail: where };
}

/**
 * One row per HPC tool: where it resolves on PATH and the first line its
 * `--version` prints. Every spawn is bounded and all of them run at once. An
 * absent tool is information, not a fault, because most workspaces need none
 * of these; it becomes a warning only when the workspace's validation
 * contract asks for it. No row ever fails doctor.
 */
export async function hpcToolchainFindings(options: HpcToolchainOptions = {}): Promise<DoctorFinding[]> {
	const loaded = loadValidationContract(options.workspaceRoot ?? process.cwd());
	const contract = loaded.ok ? loaded.contract : null;
	const timeoutMs = options.timeoutMs ?? HPC_VERSION_TIMEOUT_MS;
	return Promise.all(HPC_TOOLS.map((tool) => probeTool(tool, contract, timeoutMs)));
}
