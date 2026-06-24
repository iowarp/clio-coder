/**
 * Filesystem loading for user-defined middleware hooks and the production
 * command runner. Hooks live in dedicated, secrets-free files so they stay out
 * of the strict settings schema:
 *
 *   - `.clio/hooks.yaml`        committed project hooks (origin "project"),
 *   - `.clio/hooks.local.yaml`  gitignored local hooks (origin "project.local"),
 *   - `<extensionRoot>/hooks.yaml`  hooks shipped by an installed extension.
 *
 * Reads are best-effort: a missing file is skipped silently, and a malformed
 * file is reported as an issue without aborting anything.
 */

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import {
	type HookReceiptSink,
	loadUserHooks,
	type UserHookCommandResult,
	type UserHookCommandRunner,
	type UserHookDeclarationBatch,
	type UserHookLoadResult,
	type UserHookSource,
	userHookToRegistration,
} from "./hooks.js";
import type { MiddlewareHookRegistration } from "./runtime.js";

const COMMAND_OUTPUT_MAX_BYTES = 1024 * 1024;

export interface HookFileIssue {
	source: UserHookSource;
	message: string;
}

export interface ReadHookSourcesResult {
	batches: UserHookDeclarationBatch[];
	fileIssues: HookFileIssue[];
}

export interface ExtensionHookRoot {
	id: string;
	rootPath: string;
}

export interface ReadHookSourcesOptions {
	cwd: string;
	/** Installed extension roots, in dependency order. */
	extensions?: ReadonlyArray<ExtensionHookRoot>;
}

function readBatch(
	source: UserHookSource,
	filePath: string,
	fileIssues: HookFileIssue[],
): UserHookDeclarationBatch | null {
	let text: string;
	try {
		text = readFileSync(filePath, "utf8");
	} catch {
		// Missing file: not an error, the source is simply absent.
		return null;
	}
	try {
		const parsed = parseYaml(text) as unknown;
		return { source, declarations: parsed ?? [] };
	} catch (err) {
		fileIssues.push({
			source,
			message: `failed to parse ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
		});
		return null;
	}
}

/**
 * Gather hook declaration batches from extensions and the project, in
 * precedence order. The returned batches feed {@link loadUserHooks}.
 */
export function readHookSources(options: ReadHookSourcesOptions): ReadHookSourcesResult {
	const fileIssues: HookFileIssue[] = [];
	const batches: UserHookDeclarationBatch[] = [];

	for (const extension of options.extensions ?? []) {
		const source: UserHookSource = {
			origin: "extension",
			sourcePath: `${extension.id}:hooks.yaml`,
			sourceId: extension.id,
		};
		const batch = readBatch(source, join(extension.rootPath, "hooks.yaml"), fileIssues);
		if (batch) batches.push(batch);
	}

	const projectBatch = readBatch(
		{ origin: "project", sourcePath: ".clio/hooks.yaml" },
		join(options.cwd, ".clio", "hooks.yaml"),
		fileIssues,
	);
	if (projectBatch) batches.push(projectBatch);

	const localBatch = readBatch(
		{ origin: "project.local", sourcePath: ".clio/hooks.local.yaml" },
		join(options.cwd, ".clio", "hooks.local.yaml"),
		fileIssues,
	);
	if (localBatch) batches.push(localBatch);

	return { batches, fileIssues };
}

export interface InstallUserHooksOptions {
	cwd: string;
	/** Absolute workspace root a command `cwd` must resolve under; defaults to `cwd`. */
	workspaceRoot?: string;
	extensions?: ReadonlyArray<ExtensionHookRoot>;
	registerHook: (registration: MiddlewareHookRegistration) => void;
	recordReceipt: HookReceiptSink;
	/** Injected for tests; defaults to the spawnSync runner. */
	runCommand?: UserHookCommandRunner;
	now?: () => number;
}

export interface InstallUserHooksResult extends UserHookLoadResult {
	fileIssues: HookFileIssue[];
}

/**
 * Read, normalize, and register every user hook on the middleware contract. The
 * returned hooks and issues feed `clio config inspect`. Best-effort throughout:
 * a malformed file or hook is reported, never thrown.
 */
export function installUserHooks(options: InstallUserHooksOptions): InstallUserHooksResult {
	const workspaceRoot = options.workspaceRoot ?? options.cwd;
	const readOptions: ReadHookSourcesOptions = { cwd: options.cwd };
	if (options.extensions !== undefined) readOptions.extensions = options.extensions;
	const { batches, fileIssues } = readHookSources(readOptions);
	const loaded = loadUserHooks(batches, { workspaceRoot });
	const runCommand = options.runCommand ?? spawnSyncCommandRunner();
	for (const hook of loaded.hooks) {
		options.registerHook(
			userHookToRegistration(hook, {
				recordReceipt: options.recordReceipt,
				runCommand,
				...(options.now !== undefined ? { now: options.now } : {}),
			}),
		);
	}
	return { ...loaded, fileIssues };
}

/**
 * Production command runner. Runs the argv with no shell (so there is no string
 * to inject into), a wall-clock timeout, and a bounded output buffer.
 */
export function spawnSyncCommandRunner(): UserHookCommandRunner {
	return (argv, options): UserHookCommandResult => {
		const [command, ...args] = argv;
		const result = spawnSync(command ?? "", args, {
			...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
			timeout: options.timeoutMs,
			maxBuffer: COMMAND_OUTPUT_MAX_BYTES,
			encoding: "utf8",
			shell: false,
		});
		const timedOut = result.error !== undefined && (result.error as NodeJS.ErrnoException).code === "ETIMEDOUT";
		return {
			code: result.status,
			timedOut,
			stdout: typeof result.stdout === "string" ? result.stdout : "",
			stderr: typeof result.stderr === "string" ? result.stderr : "",
		};
	};
}
