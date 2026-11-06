import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { delimiter, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { withStateFileLock } from "../../core/state-file-lock.js";
import { clioDataDir, resolveClioDirs } from "../../core/xdg.js";
import { claudeSdkNpmCommand } from "./claude-sdk-install.js";
import { inspectInstallation } from "./install-method.js";

/**
 * The official GitHub Copilot SDK. Its per-platform optional dependency carries the Copilot runtime
 * (about 160 MB), so like the Claude SDK it is a separate per-user component installed on first use,
 * never a runtime dependency of Clio's own package.
 */
export const COPILOT_SDK_PACKAGE = "@github/copilot-sdk";
export const COPILOT_SDK_VERSION = "1.0.26";
export const COPILOT_SDK_INSTALL_COMMAND = "clio-coder tools install copilot-sdk";

export interface CopilotSdkInstallOptions {
	confirm?: (question: string) => Promise<boolean>;
	signal?: AbortSignal;
}

function copilotSdkComponentDir(): string {
	return join(resolveClioDirs().data, "components", "copilot-sdk", COPILOT_SDK_VERSION);
}

function resolveInPrefix(prefix: string): string | null {
	if (!existsSync(join(prefix, "node_modules", COPILOT_SDK_PACKAGE))) return null;
	return createRequire(join(prefix, "package.json")).resolve(COPILOT_SDK_PACKAGE);
}

/** The per-user component, then a package-local or development install. */
export function resolveCopilotSdkEntry(): string | null {
	const component = resolveInPrefix(copilotSdkComponentDir());
	if (component) return component;
	const require = createRequire(join(inspectInstallation().root, "package.json"));
	try {
		return require.resolve(COPILOT_SDK_PACKAGE);
	} catch (error) {
		const installed = require.resolve
			.paths(COPILOT_SDK_PACKAGE)
			?.some((dir) => existsSync(join(dir, COPILOT_SDK_PACKAGE)));
		if (!installed && (error as NodeJS.ErrnoException).code === "MODULE_NOT_FOUND") return null;
		throw error;
	}
}

export class CopilotSdkUnavailableError extends Error {
	readonly code = "COPILOT_SDK_UNAVAILABLE";
	readonly installCommand = COPILOT_SDK_INSTALL_COMMAND;

	constructor() {
		super(
			`The copilot-sdk runtime needs ${COPILOT_SDK_PACKAGE}@${COPILOT_SDK_VERSION}. Run: ${COPILOT_SDK_INSTALL_COMMAND}. This installs a separate component at ${copilotSdkComponentDir()}; it does not change Clio's installation.`,
		);
		this.name = "CopilotSdkUnavailableError";
	}
}

/** Explicit provisioning into a versioned prefix, so an SDK upgrade never swaps files under a live session. */
export async function installCopilotSdk(options: Pick<CopilotSdkInstallOptions, "signal"> = {}): Promise<string> {
	options.signal?.throwIfAborted();
	const target = copilotSdkComponentDir();
	clioDataDir();
	mkdirSync(dirname(target), { recursive: true });
	return withStateFileLock(
		target,
		async () => {
			if (resolveInPrefix(target)) return target;
			const installation = inspectInstallation();
			const node = installation.installer?.node ?? process.execPath;
			const npm = claudeSdkNpmCommand(node, installation.installer !== undefined, "");
			const staging = mkdtempSync(join(dirname(target), `.${COPILOT_SDK_VERSION}-`));
			try {
				const { runCommandVector } = await import("../../core/safe-exec.js");
				const result = await runCommandVector(
					npm.file,
					[
						...npm.args,
						"install",
						"--prefix",
						staging,
						"--save-exact",
						"--omit=dev",
						// The platform runtime is an optional dependency; npm installs only the host's.
						"--include=optional",
						// Only koffi has an install script, and only the in-process FFI transport loads it. Clio
						// uses the stdio transport, so no native build runs on the user's machine.
						"--ignore-scripts",
						`${COPILOT_SDK_PACKAGE}@${COPILOT_SDK_VERSION}`,
					],
					{
						cwd: staging,
						workspaceRoot: staging,
						env: {
							...process.env,
							PATH: `${dirname(node)}${delimiter}${process.env.PATH ?? ""}`,
							npm_config_update_notifier: "false",
							npm_config_fund: "false",
							npm_config_audit: "false",
						},
						timeoutMs: 10 * 60_000,
						...(options.signal ? { signal: options.signal } : {}),
					},
				);
				options.signal?.throwIfAborted();
				if (result.exitCode !== 0)
					throw new Error(
						`Copilot SDK provisioning failed: ${result.stderr || result.stdout}. Retry: ${COPILOT_SDK_INSTALL_COMMAND}`,
					);
				const entry = resolveInPrefix(staging);
				if (!entry) throw new Error("Copilot SDK provisioning completed without the SDK package.");
				const sdk = await import(pathToFileURL(entry).href);
				if (typeof sdk.CopilotClient !== "function")
					throw new Error("Provisioned Copilot SDK does not export CopilotClient.");
				options.signal?.throwIfAborted();
				renameSync(staging, target);
				return target;
			} finally {
				rmSync(staging, { recursive: true, force: true });
			}
		},
		{ timeoutMs: 10 * 60_000, ...(options.signal ? { signal: options.signal } : {}) },
	);
}

// Parallel callers share one decision, a declined or failed attempt included, so the offer is asked once.
const attempts = new Map<string, Promise<void>>();

export async function ensureCopilotSdk(options: CopilotSdkInstallOptions = {}): Promise<void> {
	options.signal?.throwIfAborted();
	if (resolveCopilotSdkEntry()) return;
	const confirm = options.confirm;
	if (!confirm) throw new CopilotSdkUnavailableError();
	const target = copilotSdkComponentDir();
	let attempt = attempts.get(target);
	if (!attempt) {
		attempt = (async () => {
			if (
				!(await confirm(
					`The copilot-sdk runtime needs the official GitHub Copilot SDK (${COPILOT_SDK_PACKAGE}@${COPILOT_SDK_VERSION}, about 170 MB with its runtime) as a separate component. Install it now?`,
				))
			)
				throw new CopilotSdkUnavailableError();
			await installCopilotSdk(options);
		})();
		attempts.set(target, attempt);
	}
	await attempt;
	options.signal?.throwIfAborted();
}
