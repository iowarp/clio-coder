import type { FleetNodeSettings } from "../../core/defaults.js";
import { readClioVersion } from "../../core/package-root.js";
import { runCommandVector } from "../../core/safe-exec.js";
import { fleetNode } from "./fleet-nodes.js";
import { fleetConnectionHash } from "./fleet-preflight.js";
import { buildSshArgs } from "./transport.js";

export interface FleetToolInstallPlan {
	node: FleetNodeSettings;
	connectionHash: string;
	tool: "asciinema";
	command: string;
}

/** Explicit operator provisioning; ordinary dispatch never calls this path. */
export function prepareFleetToolInstall(id: string, tool: "asciinema"): FleetToolInstallPlan {
	if (tool !== "asciinema") throw new Error("only asciinema provisioning is supported");
	const node = fleetNode(id);
	const entry = node.clioCoderEntry ?? "clio-coder worker";
	if (!/\sworker\s*$/.test(entry))
		throw new Error("remote tool installation requires a configured Clio worker entry ending in worker");
	const cli = entry.replace(/\sworker\s*$/, "");
	return {
		node: structuredClone(node),
		connectionHash: fleetConnectionHash(node),
		tool,
		command: `set -e; umask 077; export TMPDIR="$HOME/.cache/clio-coder/tool-install-tmp"; mkdir -p "$TMPDIR"; ${cli} tools install asciinema --json`,
	};
}

export function describeFleetToolInstall(plan: FleetToolInstallPlan): string {
	return [
		`Install the remote Clio client's pinned asciinema on ${plan.node.id} (${plan.node.host}).`,
		"Remote Clio must match this client's release; its registry verifies the upstream asset and document checksums.",
		"Uses the node user's Clio data/tools directory and private cache temporary directory; no sudo or services.",
		"asciinema is a separate GPL-3.0-or-later program; upstream LICENSE, README and exact release source accompany the install.",
		"Native worker recording uses an orchestrator side-channel and does not require this program on the node.",
		plan.command,
	].join("\n");
}

export async function executeFleetToolInstall(plan: FleetToolInstallPlan): Promise<string> {
	const current = prepareFleetToolInstall(plan.node.id, plan.tool);
	if (current.connectionHash !== plan.connectionHash || current.command !== plan.command)
		throw new Error("node configuration changed since the tool install preview; preview again");
	const versionCommand =
		current.node.clioCoderVersionCommand ??
		`${(current.node.clioCoderEntry ?? "clio-coder worker").replace(/\sworker\s*$/, "")} --version`;
	const version = await runCommandVector("ssh", buildSshArgs(current.node, versionCommand), { timeoutMs: 20_000 });
	if (
		version.exitCode !== 0 ||
		!version.stdout
			.split("\n")
			.some((line) => line.match(/\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?/u)?.[0] === readClioVersion())
	)
		throw new Error("remote Clio version must match this client before tool provisioning");
	const result = await runCommandVector("ssh", buildSshArgs(current.node, current.command), {
		timeoutMs: 300_000,
		maxOutputBytes: 128_000,
	});
	if (result.exitCode !== 0) throw new Error(`remote asciinema installation failed: ${result.stderr.trim()}`);
	return result.stdout;
}
