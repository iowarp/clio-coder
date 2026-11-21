import { existsSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { delimiter, dirname, join } from "node:path";
import { withStateFileLock } from "../../core/state-file-lock.js";
import { clioDataDir } from "../../core/xdg.js";
import { claudeSdkNpmCommand } from "./claude-sdk-install.js";
import { componentInstallDir, componentSearchDirs, usesOperatorComponents } from "./components.js";
import { inspectInstallation } from "./install-method.js";

/**
 * The browser tool's managed component: `playwright-core`, pinned exactly, and the Chromium headless shell its
 * installer fetches for that pin (about 110 MiB on Linux x64). Both land in one versioned prefix under Clio's data
 * directory, installed on first use after one confirmation or by `clio-coder tools install browser`, never at
 * install time and never into the operator's own Playwright cache. On Windows the installed Edge is used and no
 * shell is downloaded.
 */
export const PLAYWRIGHT_CORE_PACKAGE = "playwright-core";
export const PLAYWRIGHT_CORE_VERSION = "1.65.1";
export const BROWSER_INSTALL_COMMAND = "clio-coder tools install browser";

const COMPONENT_ID = "browser";

/** The resolved component the session driver loads: the playwright-core entry and the browsers directory. */
export interface BrowserComponent {
	prefix: string;
	playwrightEntry: string;
	browsersPath: string;
	/** Launch through the installed Edge channel instead of a headless shell (Windows). */
	channel?: "msedge";
}

function edgeChannel(): "msedge" | undefined {
	if (process.platform !== "win32") return undefined;
	const roots = [process.env["ProgramFiles(x86)"], process.env.ProgramFiles].filter(
		(root): root is string => typeof root === "string" && root !== "",
	);
	return roots.some((root) => existsSync(join(root, "Microsoft", "Edge", "Application", "msedge.exe")))
		? "msedge"
		: undefined;
}

function hasHeadlessShell(browsersPath: string): boolean {
	try {
		return readdirSync(browsersPath).some((entry) => entry.startsWith("chromium_headless_shell-"));
	} catch {
		return false;
	}
}

function resolveInPrefix(prefix: string): BrowserComponent | null {
	if (!existsSync(join(prefix, "node_modules", PLAYWRIGHT_CORE_PACKAGE))) return null;
	const playwrightEntry = createRequire(join(prefix, "package.json")).resolve(PLAYWRIGHT_CORE_PACKAGE);
	const browsersPath = join(prefix, "browsers");
	const channel = edgeChannel();
	if (channel === undefined && !hasHeadlessShell(browsersPath)) return null;
	return { prefix, playwrightEntry, browsersPath, ...(channel !== undefined ? { channel } : {}) };
}

/** This process's component, then the operator's; null when neither is provisioned. */
export function resolveBrowserComponent(): BrowserComponent | null {
	for (const prefix of componentSearchDirs(COMPONENT_ID, PLAYWRIGHT_CORE_VERSION)) {
		const component = resolveInPrefix(prefix);
		if (component) return component;
	}
	return null;
}

/** False where this process may only read the operator's components (a campaign entry). */
export function browserComponentInstallable(): boolean {
	return !usesOperatorComponents();
}

export class BrowserComponentUnavailableError extends Error {
	readonly code = "BROWSER_COMPONENT_UNAVAILABLE";
	constructor(detail?: string) {
		super(
			`The browser tool needs ${PLAYWRIGHT_CORE_PACKAGE}@${PLAYWRIGHT_CORE_VERSION} and a headless Chromium shell${detail ? ` (${detail})` : ""}. Run: ${BROWSER_INSTALL_COMMAND}. It installs a separate component under Clio's data directory and does not change Clio's installation.`,
		);
		this.name = "BrowserComponentUnavailableError";
	}
}

export interface BrowserInstallOptions {
	signal?: AbortSignal;
	onProgress?: (message: string) => void;
}

/** Explicit provisioning. A versioned prefix keeps an upgrade separate from running sessions. */
export async function installBrowserComponent(options: BrowserInstallOptions = {}): Promise<BrowserComponent> {
	options.signal?.throwIfAborted();
	if (!browserComponentInstallable())
		throw new BrowserComponentUnavailableError("this process reads the operator's components");
	const target = componentInstallDir(COMPONENT_ID, PLAYWRIGHT_CORE_VERSION);
	clioDataDir();
	mkdirSync(dirname(target), { recursive: true });
	return withStateFileLock(
		target,
		async () => {
			const existing = resolveInPrefix(target);
			if (existing) return existing;
			const installation = inspectInstallation();
			const node = installation.installer?.node ?? process.execPath;
			const npm = claudeSdkNpmCommand(node, installation.installer !== undefined, "");
			const staging = mkdtempSync(join(dirname(target), `.${PLAYWRIGHT_CORE_VERSION}-`));
			const env = {
				...process.env,
				PATH: `${dirname(node)}${delimiter}${process.env.PATH ?? ""}`,
				npm_config_update_notifier: "false",
				npm_config_fund: "false",
				npm_config_audit: "false",
				PLAYWRIGHT_BROWSERS_PATH: join(staging, "browsers"),
				PLAYWRIGHT_SKIP_BROWSER_GC: "1",
			};
			try {
				const { runCommandVector } = await import("../../core/safe-exec.js");
				options.onProgress?.(`installing ${PLAYWRIGHT_CORE_PACKAGE}@${PLAYWRIGHT_CORE_VERSION}`);
				const npmResult = await runCommandVector(
					npm.file,
					[
						...npm.args,
						"install",
						"--prefix",
						staging,
						"--save-exact",
						"--omit=dev",
						`${PLAYWRIGHT_CORE_PACKAGE}@${PLAYWRIGHT_CORE_VERSION}`,
					],
					{
						cwd: staging,
						workspaceRoot: staging,
						env,
						timeoutMs: 10 * 60_000,
						...(options.signal ? { signal: options.signal } : {}),
					},
				);
				options.signal?.throwIfAborted();
				if (npmResult.exitCode !== 0)
					throw new Error(
						`browser provisioning failed installing ${PLAYWRIGHT_CORE_PACKAGE}: ${npmResult.stderr || npmResult.stdout}. Retry: ${BROWSER_INSTALL_COMMAND}`,
					);
				if (edgeChannel() === undefined) {
					options.onProgress?.("downloading the Chromium headless shell");
					const cli = join(staging, "node_modules", PLAYWRIGHT_CORE_PACKAGE, "cli.js");
					const shell = await runCommandVector(node, [cli, "install", "--only-shell", "chromium"], {
						cwd: staging,
						workspaceRoot: staging,
						env,
						timeoutMs: 15 * 60_000,
						maxOutputBytes: 200_000,
						...(options.signal ? { signal: options.signal } : {}),
					});
					options.signal?.throwIfAborted();
					if (shell.exitCode !== 0)
						throw new Error(
							`browser provisioning failed downloading the headless shell: ${(shell.stderr || shell.stdout).slice(-2000)}. Retry: ${BROWSER_INSTALL_COMMAND}`,
						);
				}
				if (!resolveInPrefix(staging)) throw new Error("browser provisioning completed without a usable browser.");
				renameSync(staging, target);
				const installed = resolveInPrefix(target);
				if (!installed) throw new Error("browser provisioning could not resolve the installed component.");
				return installed;
			} finally {
				rmSync(staging, { recursive: true, force: true });
			}
		},
		{ timeoutMs: 20 * 60_000, ...(options.signal ? { signal: options.signal } : {}) },
	);
}
