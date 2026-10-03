import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
	type Installation,
	installationCommand,
	installerPackageRoot,
	installerUnpinCommand,
	readInstallerRecord,
} from "./install-method.js";
import { compareReleaseVersions, fetchReleaseVersion, parseReleaseVersion } from "./release-version.js";

const MAX_UPGRADE_REPORT_BYTES = 1024 * 1024;
const MAX_UPGRADE_ERROR_BYTES = 16 * 1024;

export type SelfUpgradePlan =
	| { status: "available"; current: string; available: string; installation: Installation }
	| { status: "current"; current: string; available: string; installation: Installation }
	| { status: "unavailable"; current: string; installation: Installation }
	| { status: "manual"; current: string; installation: Installation; command: string }
	| { status: "pinned"; current: string; pin: string; installation: Installation; command: string };

function selfUpgradable(installation: Installation): boolean {
	return (installation.kind === "npm" || installation.kind === "installer") && installation.prefix !== null;
}

/**
 * The channel an in-session upgrade follows: the one an installer install
 * recorded, as `clio-coder upgrade` does, else latest. Asking for latest on a
 * beta install moved it off its channel.
 */
function upgradeChannel(installation: Installation): "latest" | "beta" | "dev" {
	const channel = installation.installer?.channel;
	return channel === "beta" || channel === "dev" ? channel : "latest";
}

/** Where the package lives after the upgrade: the same root for npm, the manifest's new prefix for install.sh. */
function installedPackageRoot(installation: Installation): string {
	if (installation.kind !== "installer" || installation.installer === undefined) return installation.root;
	const record = readInstallerRecord(installation.installer.root);
	return record === null ? installation.root : installerPackageRoot(record.current);
}

export interface PlanSelfUpgradeOptions {
	installation: Installation;
	runningVersion: string;
	fetchVersion?: (channel: string, signal?: AbortSignal) => Promise<string | null>;
	signal?: AbortSignal;
}

/**
 * Resolve what an in-session upgrade may safely do. Only an identified npm
 * global install has a stable package root and prefix after replacement, and an
 * install.sh install records its new prefix in its manifest; pnpm
 * and Bun global stores can move their package entry during the manager call,
 * so those installations keep the explicit manager handoff rather than
 * guessing which new entry should run post-install checks.
 */
export async function planSelfUpgrade(options: PlanSelfUpgradeOptions): Promise<SelfUpgradePlan> {
	const { installation, runningVersion, signal } = options;
	if (!selfUpgradable(installation)) {
		return {
			status: "manual",
			current: runningVersion,
			installation,
			command: installationCommand(installation, "upgrade"),
		};
	}
	const pin = installation.installer?.versionPin;
	if (pin) {
		return {
			status: "pinned",
			current: runningVersion,
			pin,
			installation,
			command: installerUnpinCommand(installation, upgradeChannel(installation)) ?? "",
		};
	}
	signal?.throwIfAborted();
	const availableResult = await (options.fetchVersion ?? fetchReleaseVersion)(upgradeChannel(installation), signal);
	signal?.throwIfAborted();
	if (typeof availableResult !== "string" || !parseReleaseVersion(availableResult))
		return { status: "unavailable", current: runningVersion, installation };
	const available = availableResult;
	const comparison = compareReleaseVersions(available, runningVersion);
	if (comparison === null) return { status: "unavailable", current: runningVersion, installation };
	if (comparison <= 0) return { status: "current", current: runningVersion, available, installation };
	return { status: "available", current: runningVersion, available, installation };
}

interface LifecycleUpgradeReport {
	status?: unknown;
	errors?: unknown;
}

export interface ApprovedSelfUpgradeResult {
	from: string;
	to: string;
}

export interface RunApprovedSelfUpgradeOptions {
	plan: Extract<SelfUpgradePlan, { status: "available" }>;
	signal?: AbortSignal;
	cwd?: string;
	spawnProcess?: typeof spawn;
}

function lastNonemptyLine(text: string): string {
	return text.trim().split(/\r?\n/u).filter(Boolean).at(-1) ?? "";
}

function reportError(report: LifecycleUpgradeReport): string | null {
	if (!Array.isArray(report.errors)) return null;
	const messages = report.errors.filter((value): value is string => typeof value === "string" && value.length > 0);
	return messages.length > 0 ? messages.join("; ") : null;
}

/**
 * Run the ordinary lifecycle command through this installation's exact entry.
 * The command owns replacement, migrations, and doctor repair; this wrapper
 * only bounds and validates its machine-readable result before the TUI says an
 * upgrade succeeded.
 */
export async function runApprovedSelfUpgrade(
	options: RunApprovedSelfUpgradeOptions,
): Promise<ApprovedSelfUpgradeResult> {
	const { plan, signal } = options;
	if (!selfUpgradable(plan.installation)) {
		throw new Error("automatic replacement is available only for an identified npm global or install.sh installation");
	}
	signal?.throwIfAborted();
	const spawnProcess = options.spawnProcess ?? spawn;
	const output = await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
		const child = spawnProcess(
			process.execPath,
			[plan.installation.entry, "upgrade", "--json", `--channel=${upgradeChannel(plan.installation)}`],
			{
				cwd: options.cwd ?? process.cwd(),
				stdio: ["ignore", "pipe", "pipe"],
				windowsHide: true,
			},
		);
		let stdout = Buffer.alloc(0);
		let stderr = Buffer.alloc(0);
		let settled = false;
		const finish = (error?: Error): void => {
			if (settled) return;
			settled = true;
			signal?.removeEventListener("abort", abort);
			if (error) reject(error);
			else resolve({ stdout: stdout.toString("utf8"), stderr: stderr.toString("utf8") });
		};
		const abort = (): void => {
			child.kill("SIGTERM");
			finish(signal?.reason instanceof Error ? signal.reason : new Error("upgrade cancelled"));
		};
		signal?.addEventListener("abort", abort, { once: true });
		child.stdout?.on("data", (chunk: Buffer) => {
			if (settled) return;
			stdout = Buffer.concat([stdout, chunk]);
			if (stdout.byteLength > MAX_UPGRADE_REPORT_BYTES) {
				child.kill("SIGTERM");
				finish(new Error("upgrade returned an oversized report"));
			}
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			if (settled) return;
			stderr = Buffer.concat([stderr, chunk]).subarray(-MAX_UPGRADE_ERROR_BYTES);
		});
		child.once("error", (error) => finish(error));
		child.once("close", (code, childSignal) => {
			if (settled) return;
			if (code !== 0) {
				const detail = lastNonemptyLine(stderr.toString("utf8")) || `exit ${code ?? childSignal ?? "unknown"}`;
				finish(new Error(`upgrade failed: ${detail}`));
				return;
			}
			finish();
		});
	});

	let report: LifecycleUpgradeReport;
	try {
		const parsed: unknown = JSON.parse(output.stdout);
		if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
			throw new Error("report is not an object");
		report = parsed as LifecycleUpgradeReport;
	} catch {
		throw new Error(
			`upgrade returned an unreadable report${lastNonemptyLine(output.stderr) ? `: ${lastNonemptyLine(output.stderr)}` : ""}`,
		);
	}
	if (report.status !== "success") throw new Error(reportError(report) ?? "upgrade did not report success");

	let installedVersion: string;
	try {
		const pkg = JSON.parse(await readFile(join(installedPackageRoot(plan.installation), "package.json"), "utf8")) as {
			name?: unknown;
			version?: unknown;
		};
		if (pkg.name !== "@iowarp/clio-coder" || typeof pkg.version !== "string" || !parseReleaseVersion(pkg.version)) {
			throw new Error("installed package metadata has the wrong identity or version");
		}
		installedVersion = pkg.version;
	} catch (error) {
		throw new Error(
			`upgrade checks passed, but the installed package cannot be verified: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	if (compareReleaseVersions(installedVersion, plan.current) !== 1) {
		throw new Error(`upgrade checks passed, but the installed version is ${installedVersion} (was ${plan.current})`);
	}
	return { from: plan.current, to: installedVersion };
}
