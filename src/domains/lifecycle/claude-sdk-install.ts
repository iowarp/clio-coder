import { createRequire } from "node:module";
import { delimiter, dirname, join } from "node:path";
import { shellQuote } from "../../core/shell-quote.js";
import type { Installation } from "./install-method.js";
import { inspectInstallation } from "./install-method.js";

export const CLAUDE_AGENT_SDK_PACKAGE = "@anthropic-ai/claude-agent-sdk";
export const CLAUDE_AGENT_SDK_VERSION = "0.3.186";
export const CLAUDE_AGENT_SDK_INSTALL_COMMAND = `npm install ${CLAUDE_AGENT_SDK_PACKAGE}@${CLAUDE_AGENT_SDK_VERSION}`;

export interface ClaudeSdkInstallOptions {
	confirm?: (question: string) => Promise<boolean>;
	signal?: AbortSignal;
}

function quote(value: string): string {
	return process.platform === "win32" ? `'${value.replaceAll("'", "''")}'` : shellQuote(value);
}

function bundledNpm(installation: Installation): string {
	const nodeDir = dirname(installation.installer!.node);
	return process.platform === "win32"
		? join(nodeDir, "node_modules", "npm", "bin", "npm-cli.js")
		: join(dirname(nodeDir), "lib", "node_modules", "npm", "bin", "npm-cli.js");
}

function installArgs(root: string): string[] {
	return [
		"install",
		"--prefix",
		root,
		"--no-save",
		"--omit=dev",
		"--include=optional",
		`${CLAUDE_AGENT_SDK_PACKAGE}@${CLAUDE_AGENT_SDK_VERSION}`,
	];
}

function installCommand(installation: Installation): string {
	const spec = `${CLAUDE_AGENT_SDK_PACKAGE}@${CLAUDE_AGENT_SDK_VERSION}`;
	if (installation.installer) {
		const invocation = [installation.installer.node, bundledNpm(installation), ...installArgs(installation.root)];
		return `${process.platform === "win32" ? "& " : ""}${invocation.map(quote).join(" ")}`;
	}
	if (
		installation.kind === "pnpm" ||
		installation.kind === "source" ||
		installation.root.split(/[\\/]/u).includes(".pnpm")
	)
		return `pnpm --dir ${quote(installation.root)} add --save-optional --prod ${spec}`;
	if (installation.kind === "bun") return `bun add --cwd ${quote(installation.root)} --optional --production ${spec}`;
	return `npm install --prefix ${quote(installation.root)} --no-save --omit=dev --include=optional ${spec}`;
}

export class ClaudeAgentSdkUnavailableError extends Error {
	readonly code = "CLAUDE_AGENT_SDK_UNAVAILABLE";
	readonly packageName = CLAUDE_AGENT_SDK_PACKAGE;
	readonly installCommand: string;

	constructor(cause?: unknown, command = installCommand(inspectInstallation())) {
		super(
			`The Claude SDK runtime needs ${CLAUDE_AGENT_SDK_PACKAGE} (about 224 MB). Run: ${command}`,
			cause === undefined ? undefined : { cause },
		);
		this.name = "ClaudeAgentSdkUnavailableError";
		this.installCommand = command;
	}
}

function sdkIsInstalled(installation: Installation): boolean {
	try {
		createRequire(join(installation.root, "package.json")).resolve(CLAUDE_AGENT_SDK_PACKAGE);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "MODULE_NOT_FOUND") return false;
		throw error;
	}
}

// Parallel dispatches share one decision, including a declined or failed attempt.
const attempts = new Map<string, Promise<void>>();

export async function ensureClaudeAgentSdk(options: ClaudeSdkInstallOptions = {}): Promise<void> {
	options.signal?.throwIfAborted();
	const installation = inspectInstallation();
	if (sdkIsInstalled(installation)) return;
	const unavailable = () => new ClaudeAgentSdkUnavailableError(undefined, installCommand(installation));
	if (!installation.installer || !options.confirm) throw unavailable();
	let attempt = attempts.get(installation.root);
	if (!attempt) {
		attempt = (async () => {
			const approved = await options.confirm!(
				"The Claude SDK runtime needs @anthropic-ai/claude-agent-sdk (about 224 MB). Install it now?",
			);
			options.signal?.throwIfAborted();
			if (!approved) throw unavailable();
			const env: Record<string, string> = {
				PATH: `${dirname(installation.installer!.node)}${delimiter}${process.env.PATH ?? ""}`,
				npm_config_update_notifier: "false",
				npm_config_fund: "false",
				npm_config_audit: "false",
			};
			for (const [key, value] of Object.entries(process.env)) {
				if (value !== undefined && /^(?:https?_proxy|no_proxy|npm_config_registry|node_extra_ca_certs)$/iu.test(key))
					env[key] = value;
			}
			const { runCommandVector } = await import("../../core/safe-exec.js");
			// Installing inside Clio preserves its package; the prefix's lib/ has
			// no manifest, so npm there could prune Clio as an extraneous package.
			const result = await runCommandVector(
				installation.installer!.node,
				[bundledNpm(installation), ...installArgs(installation.root)],
				{
					cwd: installation.root,
					env,
					timeoutMs: 10 * 60_000,
					...(options.signal ? { signal: options.signal } : {}),
				},
			);
			options.signal?.throwIfAborted();
			if (result.exitCode !== 0 || !sdkIsInstalled(installation)) throw unavailable();
		})();
		attempts.set(installation.root, attempt);
	}
	await attempt;
	options.signal?.throwIfAborted();
}
