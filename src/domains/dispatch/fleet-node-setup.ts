import { resolve } from "node:path";
import type { FleetNodeSettings } from "../../core/defaults.js";
import { describeFleetNodeInstall, executeFleetNodeInstall, prepareFleetNodeInstall } from "./fleet-node-install.js";
import { fleetNode, removeFleetNode, sameMachineConflict, sameMachineHolder, testFleetNode } from "./fleet-nodes.js";
import type { FleetPreflightRecord } from "./fleet-preflight.js";

export type FleetNodeSetupOutcome = "ready" | "install-previewed" | "needs-attention" | "unreachable";

export interface FleetNodeSetupOptions {
	projectRoot?: string;
	/** Execute an install the probe calls for; without it setup previews the install and stops. */
	yes: boolean;
	/** This setup run registered the node, so a refusal that the entry itself causes removes it again. */
	added?: boolean;
	/** Test seam for the SSH client binary. */
	sshBinary?: string;
	write: (line: string) => void;
}

export interface FleetNodeSetupResult {
	outcome: FleetNodeSetupOutcome;
	/** The recorded check, or the observation that stopped setup before recording. */
	record: FleetPreflightRecord;
	/** False when setup stopped before recording; it has already written why. */
	recorded: boolean;
}

/** Entries setup may replace: the remote PATH default and installs that setup itself made. */
function setupManagesEntry(node: FleetNodeSettings): boolean {
	const entry = node.clioCoderEntry?.trim();
	if (entry === undefined || entry === "" || entry === "clio-coder worker") return true;
	return /^"\$HOME\/\.local\/share\/clio-coder\/workers\/[0-9a-f]{64}\/node_modules\/\.bin\/clio-coder" worker$/u.test(
		entry,
	);
}

function destination(node: FleetNodeSettings): string {
	return `${node.user !== undefined ? `${node.user}@` : ""}${node.host}${node.port !== undefined ? ` -p ${node.port}` : ""}`;
}

/**
 * Probe, install when the node lacks this exact build, then record the
 * preflight that admits it. Rerunning after every rebuild is the intended use,
 * so a node that already runs this build is only re-recorded.
 */
export async function setupFleetNode(id: string, options: FleetNodeSetupOptions): Promise<FleetNodeSetupResult> {
	const projectRoot = resolve(options.projectRoot ?? process.cwd());
	const node = fleetNode(id);
	const write = options.write;
	write(`${id}: checking ${destination(node)} over SSH`);
	const ssh = options.sshBinary !== undefined ? { sshBinary: options.sshBinary } : {};
	const probe = await testFleetNode(id, projectRoot, { record: false, verifyProject: false, ...ssh });
	if (!probe.checks.reachable) {
		write(`  ${probe.detail ?? "unreachable"}`);
		write(
			`  Setup needs key-based SSH and a known host key. Run 'ssh ${destination(node)} true' once to accept the host key, then rerun setup.`,
		);
		return { outcome: "unreachable", record: probe, recorded: false };
	}
	// Installing on a machine another node holds would only end in a failed check.
	const twin = sameMachineHolder(id, probe.machine);
	if (twin !== null) {
		probe.ok = false;
		probe.detail = sameMachineConflict(id, probe.machine);
		if (options.added === true) {
			removeFleetNode(id);
			write(`  node '${id}' is the same machine as node '${twin}', so setup did not keep the '${id}' entry it added.`);
			write(
				`  Use node '${twin}' for this machine. To reach it under this name or address instead, run 'clio-coder fleet nodes remove ${twin}', then rerun this setup.`,
			);
		} else {
			write(`  ${probe.detail}`);
			write(
				`  Remove one entry with 'clio-coder fleet nodes remove ${id}' or 'clio-coder fleet nodes remove ${twin}', then rerun setup for the one you keep.`,
			);
		}
		return { outcome: "needs-attention", record: probe, recorded: false };
	}
	if (!probe.checks.clioPresent || !probe.checks.versionMatch) {
		if (!setupManagesEntry(fleetNode(id))) {
			write(`  ${probe.detail ?? "the worker entry does not run this build"}`);
			write(
				"  This node uses a custom fleet.nodes[].clioCoderEntry, which setup does not replace. Point it at this build, or remove the entry so setup can manage the install.",
			);
			return { outcome: "needs-attention", record: probe, recorded: false };
		}
		write(`  ${probe.detail ?? "the node does not run this build"}`);
		const plan = await prepareFleetNodeInstall(id);
		try {
			write(
				describeFleetNodeInstall(plan)
					.split("\n")
					.map((line) => `  ${line}`)
					.join("\n"),
			);
			if (!options.yes) {
				write(`  Run 'clio-coder fleet nodes setup ${id} --yes' to install and record.`);
				return { outcome: "install-previewed", record: probe, recorded: false };
			}
			await executeFleetNodeInstall(plan);
			write("  Installed and version-verified.");
		} finally {
			plan.cleanup();
		}
	}
	const record = await testFleetNode(id, projectRoot, { record: true, ...ssh });
	return { outcome: record.ok ? "ready" : "needs-attention", record, recorded: true };
}
