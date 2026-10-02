import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { basename, join } from "node:path";
import { updateSettings } from "../../core/config.js";
import type { FleetNodeSettings } from "../../core/defaults.js";
import { readClioVersion, resolvePackageRoot } from "../../core/package-root.js";
import { runCommandVector } from "../../core/safe-exec.js";
import { shellQuote } from "../../core/shell-quote.js";
import { clioCacheDir } from "../../core/xdg.js";
import { fleetNode } from "./fleet-nodes.js";
import { fleetConnectionHash } from "./fleet-preflight.js";
import { buildSshArgs } from "./transport.js";

export interface FleetNodeInstallPlan {
	node: FleetNodeSettings;
	connectionHash: string;
	version: string;
	sha256: string;
	bytes: number;
	remotePrefix: string;
	workerEntry: string;
	versionCommand: string;
	tarball: string;
	cleanup(): void;
}

/** Pack the package this client actually runs; never substitute a registry release. */
export async function prepareFleetNodeInstall(id: string): Promise<FleetNodeInstallPlan> {
	const node = fleetNode(id);
	const root = resolvePackageRoot();
	if (!existsSync(join(root, "dist/cli/index.js")))
		throw new Error("client build is missing; build this checkout before installing nodes");
	const directory = mkdtempSync(join(clioCacheDir(), "fleet-install-"));
	try {
		const packed = await runCommandVector(
			"npm",
			["pack", "--ignore-scripts", "--json", "--pack-destination", directory],
			{
				cwd: root,
				workspaceRoot: root,
				timeoutMs: 120_000,
				env: { TMPDIR: directory, npm_config_cache: join(directory, "npm-cache") },
			},
		);
		if (packed.exitCode !== 0) throw new Error(`could not pack client: ${packed.stderr.trim()}`);
		const entries = JSON.parse(packed.stdout) as Array<{ filename: string }>;
		const filename = entries[0]?.filename;
		if (!filename || basename(filename) !== filename) throw new Error("npm pack returned no safe package filename");
		const tarball = join(directory, filename);
		const payload = readFileSync(tarball);
		const sha256 = createHash("sha256").update(payload).digest("hex");
		const remotePrefix = `.local/share/clio-coder/workers/${sha256}`;
		const cli = `"$HOME/${remotePrefix}/node_modules/.bin/clio-coder"`;
		return {
			node,
			connectionHash: fleetConnectionHash(node),
			version: readClioVersion(),
			sha256,
			bytes: payload.byteLength,
			remotePrefix,
			workerEntry: `${cli} worker`,
			versionCommand: `${cli} --version`,
			tarball,
			cleanup: () => rmSync(directory, { recursive: true, force: true }),
		};
	} catch (error) {
		rmSync(directory, { recursive: true, force: true });
		throw error;
	}
}

export function describeFleetNodeInstall(plan: FleetNodeInstallPlan): string {
	return [
		`Install client Clio ${plan.version} on ${plan.node.id} (${plan.node.host}).`,
		`Transfer ${(plan.bytes / 1024 / 1024).toFixed(1)} MiB; SHA-256 ${plan.sha256}.`,
		`Create ~/${plan.remotePrefix} with the package, npm dependencies, private cache and temporary files.`,
		"Use the node's existing Node >=22.19 and npm. Optional SDK dependencies are omitted.",
		"Update this client's node worker entry after verifying the installed version.",
		"No sudo, system packages, services, shell profile edits or existing launcher replacement.",
	].join("\n");
}

export async function executeFleetNodeInstall(plan: FleetNodeInstallPlan): Promise<void> {
	if (fleetConnectionHash(fleetNode(plan.node.id)) !== plan.connectionHash)
		throw new Error("node configuration changed since the install preview; preview again");
	const payload = readFileSync(plan.tarball);
	if (createHash("sha256").update(payload).digest("hex") !== plan.sha256)
		throw new Error("client package changed since the preview");
	const prefix = `"$HOME/${plan.remotePrefix}"`;
	const check = await runCommandVector(
		"ssh",
		buildSshArgs(
			plan.node,
			`node -e ${shellQuote("const v=process.versions.node.split('.').map(Number); if(v[0]<22 || (v[0]===22 && v[1]<19)) process.exit(1)")} && command -v npm >/dev/null`,
		),
		{ timeoutMs: 20_000 },
	);
	if (check.exitCode !== 0)
		throw new Error("node needs Node >=22.19.0 and npm on its noninteractive SSH PATH; install them at user level first");
	const transfer = await runCommandVector(
		"ssh",
		buildSshArgs(plan.node, `umask 077; p=${prefix}; mkdir -p "$p" && cat > "$p/client.tgz"`),
		{ input: payload, timeoutMs: 120_000 },
	);
	if (transfer.exitCode !== 0) throw new Error(`package transfer failed: ${transfer.stderr.trim()}`);
	const verifyScript =
		"const fs=require('node:fs'),crypto=require('node:crypto');const hash=crypto.createHash('sha256').update(fs.readFileSync(process.argv[1])).digest('hex');if(hash!==process.argv[2])process.exit(1)";
	const installed = await runCommandVector(
		"ssh",
		buildSshArgs(
			plan.node,
			`set -e; umask 077; p=${prefix}; node -e ${shellQuote(verifyScript)} "$p/client.tgz" ${shellQuote(plan.sha256)}; ` +
				`mkdir -p "$p/tmp" "$p/cache"; TMPDIR="$p/tmp" npm_config_cache="$p/cache" npm install --prefix "$p" --omit=dev --omit=optional --no-audit --no-fund --no-save "$p/client.tgz"; ` +
				`${plan.versionCommand}; rm -f "$p/client.tgz"; rm -rf "$p/cache" "$p/tmp"`,
		),
		{ timeoutMs: 300_000, maxOutputBytes: 128_000 },
	);
	if (installed.exitCode !== 0)
		throw new Error(`node installation failed; inspect ~/${plan.remotePrefix}: ${installed.stderr.trim()}`);
	const verified = await runCommandVector("ssh", buildSshArgs(plan.node, plan.versionCommand), { timeoutMs: 20_000 });
	if (
		verified.exitCode !== 0 ||
		!verified.stdout
			.split("\n")
			.some((line) => line.match(/\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?/u)?.[0] === plan.version)
	) {
		throw new Error("installed worker version does not match this client; node configuration was not changed");
	}
	updateSettings((settings) => {
		const node = settings.fleet.nodes.find((item) => item.id === plan.node.id);
		if (!node || fleetConnectionHash(node) !== plan.connectionHash)
			throw new Error("node configuration changed during installation; register the installed worker entry explicitly");
		node.clioCoderEntry = plan.workerEntry;
		node.clioCoderVersionCommand = plan.versionCommand;
	});
}
