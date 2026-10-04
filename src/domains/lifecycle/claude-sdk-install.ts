import { existsSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { delimiter, dirname, isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
import { withStateFileLock } from "../../core/state-file-lock.js";
import { clioDataDir, resolveClioDirs } from "../../core/xdg.js";
import { findExecutableOnPath } from "../toolchain/resolve.js";
import { inspectInstallation } from "./install-method.js";

export const CLAUDE_AGENT_SDK_PACKAGE = "@anthropic-ai/claude-agent-sdk";
export const CLAUDE_AGENT_SDK_VERSION = "0.3.186";
export const CLAUDE_AGENT_SDK_INSTALL_COMMAND = "clio-coder tools install claude-sdk";

export interface ClaudeSdkInstallOptions {
	confirm?: (question: string) => Promise<boolean>;
	signal?: AbortSignal;
}

/** A prepared prefix contains node_modules/@anthropic-ai/claude-agent-sdk. It is never modified. */
function preparedPrefix(): string | undefined {
	const prefix = process.env.CLIO_CODER_CLAUDE_SDK_DIR;
	if (!prefix) return undefined;
	if (!isAbsolute(prefix)) throw new Error("CLIO_CODER_CLAUDE_SDK_DIR must be an absolute component prefix.");
	return prefix;
}

export function claudeSdkComponentDir(): string {
	return join(resolveClioDirs().data, "components", "claude-agent-sdk", CLAUDE_AGENT_SDK_VERSION);
}

function resolveInPrefix(prefix: string): string | null {
	if (!existsSync(join(prefix, "node_modules", CLAUDE_AGENT_SDK_PACKAGE))) return null;
	// Once the package exists, bad exports, missing entry files and malformed metadata are broken installs.
	return createRequire(join(prefix, "package.json")).resolve(CLAUDE_AGENT_SDK_PACKAGE);
}

/** Explicit prepared prefix, current per-user component, then a legacy package-local/development install. */
export function resolveClaudeAgentSdkEntry(): string | null {
	const prepared = preparedPrefix();
	if (prepared) return resolveInPrefix(prepared);
	const component = resolveInPrefix(claudeSdkComponentDir());
	if (component) return component;
	const require = createRequire(join(inspectInstallation().root, "package.json"));
	try {
		return require.resolve(CLAUDE_AGENT_SDK_PACKAGE);
	} catch (error) {
		const installed = require.resolve
			.paths(CLAUDE_AGENT_SDK_PACKAGE)
			?.some((dir) => existsSync(join(dir, CLAUDE_AGENT_SDK_PACKAGE)));
		if (!installed && (error as NodeJS.ErrnoException).code === "MODULE_NOT_FOUND") return null;
		throw error;
	}
}

export class ClaudeAgentSdkUnavailableError extends Error {
	readonly code = "CLAUDE_AGENT_SDK_UNAVAILABLE";
	readonly packageName = CLAUDE_AGENT_SDK_PACKAGE;
	readonly installCommand = CLAUDE_AGENT_SDK_INSTALL_COMMAND;

	constructor() {
		const prepared = preparedPrefix();
		super(
			prepared
				? `No ${CLAUDE_AGENT_SDK_PACKAGE} in prepared prefix ${prepared}. Ask its administrator to provision node_modules/${CLAUDE_AGENT_SDK_PACKAGE}, or unset CLIO_CODER_CLAUDE_SDK_DIR and run: ${CLAUDE_AGENT_SDK_INSTALL_COMMAND}`
				: `The Claude SDK runtime needs ${CLAUDE_AGENT_SDK_PACKAGE}@${CLAUDE_AGENT_SDK_VERSION}. Run: ${CLAUDE_AGENT_SDK_INSTALL_COMMAND}. This installs a separate component at ${claudeSdkComponentDir()}; it does not change Clio's installation.`,
		);
		this.name = "ClaudeAgentSdkUnavailableError";
	}
}

/** Managed installations must use their paired npm; unmanaged Linux may supply npm elsewhere. */
export function claudeSdkNpmCommand(node: string, managed: boolean): { file: string; args: string[] } {
	const paired =
		process.platform === "win32"
			? join(dirname(node), "node_modules", "npm", "bin", "npm-cli.js")
			: join(dirname(node), "..", "lib", "node_modules", "npm", "bin", "npm-cli.js");
	if (existsSync(paired)) return { file: node, args: [paired] };
	if (!managed && process.platform !== "win32") {
		const executable = findExecutableOnPath("npm");
		if (executable) {
			const entry = realpathSync(executable);
			// Distribution npm launchers commonly symlink directly to npm-cli.js.
			return entry.endsWith(".js") ? { file: node, args: [entry] } : { file: executable, args: [] };
		}
	}
	throw new Error(
		`No npm available for Node at ${node}${managed ? " in its managed runtime" : " beside Node or on PATH"}. Install npm through your system's supported method${managed ? " or repair the managed runtime" : " and put it on PATH"}, or prepare a component prefix and set CLIO_CODER_CLAUDE_SDK_DIR. Clio will not download Node or npm.`,
	);
}

/** Explicit provisioning only. Versioned prefixes keep an SDK upgrade separate from active sessions. */
export async function installClaudeAgentSdk(options: Pick<ClaudeSdkInstallOptions, "signal"> = {}): Promise<string> {
	options.signal?.throwIfAborted();
	const prepared = preparedPrefix();
	if (prepared) {
		const entry = resolveClaudeAgentSdkEntry();
		if (!entry) throw new ClaudeAgentSdkUnavailableError();
		return prepared;
	}
	const target = claudeSdkComponentDir();
	clioDataDir();
	mkdirSync(dirname(target), { recursive: true });
	return withStateFileLock(
		target,
		async () => {
			if (resolveInPrefix(target)) return target;
			const installation = inspectInstallation();
			const node = installation.installer?.node ?? process.execPath;
			const npm = claudeSdkNpmCommand(node, installation.installer !== undefined);
			const staging = mkdtempSync(join(dirname(target), `.${CLAUDE_AGENT_SDK_VERSION}-`));
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
						"--include=optional",
						`${CLAUDE_AGENT_SDK_PACKAGE}@${CLAUDE_AGENT_SDK_VERSION}`,
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
						`Claude SDK provisioning failed: ${result.stderr || result.stdout}. Retry: ${CLAUDE_AGENT_SDK_INSTALL_COMMAND}`,
					);
				const entry = resolveInPrefix(staging);
				if (!entry) throw new Error("Claude SDK provisioning completed without the SDK package.");
				const sdk = await import(pathToFileURL(entry).href);
				if (typeof sdk.query !== "function") throw new Error("Provisioned Claude SDK does not export query.");
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

// Parallel dispatches share one decision, including a declined or failed attempt.
const attempts = new Map<string, Promise<void>>();

export async function ensureClaudeAgentSdk(options: ClaudeSdkInstallOptions = {}): Promise<void> {
	options.signal?.throwIfAborted();
	if (resolveClaudeAgentSdkEntry()) return;
	const confirm = options.confirm;
	if (!confirm || preparedPrefix()) throw new ClaudeAgentSdkUnavailableError();
	const target = claudeSdkComponentDir();
	let attempt = attempts.get(target);
	if (!attempt) {
		attempt = (async () => {
			if (!(await confirm("The Claude SDK runtime needs a separate component. Install it now?")))
				throw new ClaudeAgentSdkUnavailableError();
			await installClaudeAgentSdk(options);
		})();
		attempts.set(target, attempt);
	}
	await attempt;
	options.signal?.throwIfAborted();
}
