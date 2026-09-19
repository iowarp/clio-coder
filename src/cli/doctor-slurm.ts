import { tmpdir } from "node:os";
import { runCommandVector } from "../core/safe-exec.js";
import { resolveClioDirs } from "../core/xdg.js";
import { resolveMcpServers } from "../domains/gateway/mcp/index.js";
import { resolveOnPath } from "../domains/interop/detect.js";
import type { DoctorFinding } from "../domains/lifecycle/doctor.js";

const PROBE_TIMEOUT_MS = 5_000;
const PROBE_MAX_OUTPUT_BYTES = 16 * 1024;
const GUIDE = "docs/guide/slurm.md";

export interface SlurmMcpOptions {
	workspaceRoot?: string;
	/** Skip the declaration lookup: reading it would resolve the config root. */
	untouched?: boolean;
	timeoutMs?: number;
	/** Override for the user config directory (tests). */
	configDir?: string;
}

async function run(binary: string, args: string[], timeoutMs: number): Promise<{ ok: boolean; text: string }> {
	const cwd = tmpdir();
	const result = await runCommandVector(binary, args, {
		cwd,
		workspaceRoot: cwd,
		timeoutMs,
		maxOutputBytes: PROBE_MAX_OUTPUT_BYTES,
	});
	return { ok: !result.timedOut && result.exitCode === 0, text: `${result.stdout}\n${result.stderr}` };
}

/** `clio-kit` has shipped without `--version`; the server listing still says whether Slurm is in this build. */
async function clioKitDetail(binary: string, timeoutMs: number): Promise<string> {
	const version = await run(binary, ["--version"], timeoutMs);
	const versionLine = version.ok
		? (version.text
				.split(/\r?\n/)
				.map((line) => line.trim())
				.find((line) => /\d+\.\d+/.test(line)) ?? "version not reported")
		: "version not reported (no --version)";
	const listing = await run(binary, ["mcp-servers"], timeoutMs);
	const ships = listing.ok
		? /^\s*-?\s*slurm\s*$/mu.test(listing.text)
			? "ships the slurm server"
			: "does not list a slurm server"
		: "its server listing could not be read";
	return `${binary}: ${versionLine}; ${ships}`;
}

function isSlurmServer(server: { command: string; args: ReadonlyArray<string> }): boolean {
	const words = [server.command, ...server.args];
	const at = words.indexOf("mcp-server");
	return at !== -1 && words[at + 1] === "slurm" && /(^|\/)clio-kit$/u.test(words[at - 1] ?? server.command);
}

/**
 * Slurm through the clio-kit MCP server: whether `clio-kit` is on PATH, whether
 * an `mcp.yaml` declares its Slurm server, and whether the scheduler clients
 * exist. Most installs use none of this, so nothing here is ever a failure,
 * and an install with none of the three gets one informational row.
 */
export async function slurmMcpFindings(options: SlurmMcpOptions = {}): Promise<DoctorFinding[]> {
	const timeoutMs = options.timeoutMs ?? PROBE_TIMEOUT_MS;
	const clioKit = resolveOnPath(["clio-kit"]);
	const sbatch = resolveOnPath(["sbatch"]);
	const squeue = resolveOnPath(["squeue"]);
	const declared =
		options.untouched === true
			? []
			: resolveMcpServers({
					cwd: options.workspaceRoot ?? process.cwd(),
					configDir: options.configDir ?? resolveClioDirs().config,
				}).servers.filter(isSlurmServer);

	const kitPresent = clioKit.presence === "present" && clioKit.binary !== undefined;
	const schedulerPresent = sbatch.presence === "present" || squeue.presence === "present";
	if (!kitPresent && declared.length === 0 && !schedulerPresent) {
		return [
			{
				ok: true,
				level: "info",
				name: "slurm mcp",
				detail: `not set up: clio-kit, sbatch, and squeue are not on PATH and no mcp.yaml declares the Slurm server; see ${GUIDE}`,
			},
		];
	}

	const findings: DoctorFinding[] = [];
	findings.push(
		kitPresent
			? { ok: true, level: "ok", name: "slurm clio-kit", detail: await clioKitDetail(clioKit.binary as string, timeoutMs) }
			: { ok: true, level: "info", name: "slurm clio-kit", detail: `not on PATH; see ${GUIDE}` },
	);
	findings.push(
		declared.length > 0
			? {
					ok: true,
					level: declared.every((server) => server.trust.status === "trusted") ? "ok" : "info",
					name: "slurm mcp server",
					detail: declared
						.map((server) => {
							const trust =
								server.trust.status === "trusted"
									? `trusted, action class ${server.trust.actionClass}`
									: `${server.trust.status}; run clio-coder mcp trust ${server.id}`;
							return `${server.id} declared in ${server.path} (${server.scope}, ${trust})`;
						})
						.join("; "),
				}
			: {
					ok: true,
					level: "info",
					name: "slurm mcp server",
					detail: `no mcp.yaml entry runs clio-kit mcp-server slurm; see ${GUIDE}`,
				},
	);
	const clients = [
		["sbatch", sbatch],
		["squeue", squeue],
	] as const;
	findings.push({
		ok: true,
		level: schedulerPresent ? "ok" : "info",
		name: "slurm scheduler",
		detail: clients
			.map(([name, found]) => `${name} ${found.presence === "present" ? found.binary : "not on PATH"}`)
			.join("; "),
	});
	return findings;
}
