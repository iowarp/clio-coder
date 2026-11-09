import type { FleetNodeSettings } from "../../core/defaults.js";
import { readClioVersion } from "../../core/package-root.js";
import { runCommandVector } from "../../core/safe-exec.js";
import { fleetNode } from "./fleet-nodes.js";
import { fleetConnectionHash } from "./fleet-preflight.js";
import { buildSshArgs } from "./transport.js";

/** Tools the remote Clio client installs with its own `tools install`, including the optional runtime SDKs. */
export const FLEET_TOOLS = ["asciinema", "copilot-sdk", "claude-sdk"] as const;
export type FleetTool = (typeof FLEET_TOOLS)[number];

export function isFleetTool(value: string): value is FleetTool {
	return (FLEET_TOOLS as ReadonlyArray<string>).includes(value);
}

export interface FleetToolInstallPlan {
	node: FleetNodeSettings;
	connectionHash: string;
	tool: FleetTool;
	command: string;
}

/** Explicit operator provisioning; ordinary dispatch never calls this path. */
export function prepareFleetToolInstall(id: string, tool: FleetTool): FleetToolInstallPlan {
	if (!isFleetTool(tool)) throw new Error(`remote tool installation supports ${FLEET_TOOLS.join(", ")}`);
	const node = fleetNode(id);
	const entry = node.clioCoderEntry ?? "clio-coder worker";
	if (!/\sworker\s*$/.test(entry))
		throw new Error("remote tool installation requires a configured Clio worker entry ending in worker");
	const cli = entry.replace(/\sworker\s*$/, "");
	return {
		node: structuredClone(node),
		connectionHash: fleetConnectionHash(node),
		tool,
		command: `set -e; umask 077; export TMPDIR="$HOME/.cache/clio-coder/tool-install-tmp"; mkdir -p "$TMPDIR"; ${cli} tools install ${tool} --json`,
	};
}

export function describeFleetToolInstall(plan: FleetToolInstallPlan): string {
	if (plan.tool !== "asciinema")
		return [
			`Install the remote Clio client's pinned ${plan.tool === "copilot-sdk" ? "GitHub Copilot SDK" : "Claude SDK"} component on ${plan.node.id} (${plan.node.host}).`,
			"Remote Clio must match this client's release; it installs the exact SDK version it pins with the node's npm.",
			"Uses the node user's Clio data/components directory and private cache temporary directory; no sudo or services.",
			"Workers on this node that use the matching runtime need it; setup omits it.",
			plan.command,
		].join("\n");
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
		// An SDK component is an npm install of up to about 180 MB, which the remote client bounds at 10 minutes.
		timeoutMs: plan.tool === "asciinema" ? 300_000 : 11 * 60_000,
		maxOutputBytes: 128_000,
	});
	if (result.exitCode !== 0) {
		// `tools install --json` reports its own failure as JSON on stdout and leaves stderr empty.
		let reason = result.stderr.trim() || result.stdout.trim();
		try {
			const message = (JSON.parse(result.stdout) as { message?: unknown } | null)?.message;
			if (typeof message === "string") reason = message;
		} catch {
			// Not the install report: ssh or the shell failed first, and its own output is the reason.
		}
		throw new Error(`remote ${current.tool} installation failed: ${reason}`);
	}
	return result.stdout;
}
