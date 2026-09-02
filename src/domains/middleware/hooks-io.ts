/**
 * Loading for user-defined middleware hooks and the production command
 * runner. Hooks live in dedicated, secrets-free files so they stay out of the
 * strict settings schema:
 *
 *   - `.clio-coder/hooks.yaml`        committed project hooks (origin "project"),
 *   - `.clio-coder/hooks.local.yaml`  gitignored local hooks (origin "project.local"),
 *   - `<extensionRoot>/hooks.yaml`  hooks shipped by an installed extension.
 *
 * Project files are read from disk here. Extension declarations are never
 * read here: they arrive already parsed as a captured source set that the
 * composition root adapts from the extension snapshot, which captured the
 * bytes during install-digest verification, so a hooks.yaml rewritten after
 * verification cannot be admitted until the next generation re-verifies the
 * tree. Middleware never sees extension-domain types.
 *
 * Reads are best-effort: a missing file is skipped silently, and a malformed
 * file is reported as an issue without aborting anything.
 */

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import {
	reportCommitAttributionDiagnostic,
	withManagedGitCommitAttributionEnvironment,
} from "../../core/git-commit-attribution.js";
import {
	type HookReceiptSink,
	loadUserHooks,
	type UserHookCommandResult,
	type UserHookCommandRunner,
	type UserHookDeclarationBatch,
	type UserHookLoadResult,
	type UserHookPackageProvenance,
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

/** One package's hook declarations, captured by the supplier from verified bytes. */
export interface CapturedHookDeclarations {
	provenance: UserHookPackageProvenance;
	/** SHA-256 of the captured hooks.yaml bytes. */
	declarationsDigest: string;
	/** Parsed declarations, or an empty list when parsing failed. */
	declarations: unknown;
	parseError?: string;
}

/** The captured declarations of one supplier generation. */
export interface CapturedHookSourceSet {
	/** 0 for an ephemeral (uncommitted) build. */
	generation: number;
	sources: ReadonlyArray<CapturedHookDeclarations>;
}

export interface ReadHookSourcesOptions {
	cwd: string;
	/** Captured extension declarations; absent means no extension hooks. */
	capturedSources?: CapturedHookSourceSet;
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

	const captured = options.capturedSources;
	for (const entry of captured?.sources ?? []) {
		const source: UserHookSource = {
			origin: "extension",
			sourcePath: `${entry.provenance.id}:hooks.yaml`,
			sourceId: entry.provenance.id,
			extension: {
				provenance: entry.provenance,
				generation: captured?.generation ?? 0,
				declarationsDigest: entry.declarationsDigest,
			},
		};
		if (entry.parseError !== undefined) {
			fileIssues.push({ source, message: `failed to parse ${source.sourcePath}: ${entry.parseError}` });
			continue;
		}
		batches.push({ source, declarations: entry.declarations });
	}

	const projectBatch = readBatch(
		{ origin: "project", sourcePath: ".clio-coder/hooks.yaml" },
		join(options.cwd, ".clio-coder", "hooks.yaml"),
		fileIssues,
	);
	if (projectBatch) batches.push(projectBatch);

	const localBatch = readBatch(
		{ origin: "project.local", sourcePath: ".clio-coder/hooks.local.yaml" },
		join(options.cwd, ".clio-coder", "hooks.local.yaml"),
		fileIssues,
	);
	if (localBatch) batches.push(localBatch);

	return { batches, fileIssues };
}

export interface BuildUserHookRegistrationsOptions {
	cwd: string;
	/** Absolute workspace root a command `cwd` must resolve under; defaults to `cwd`. */
	workspaceRoot?: string;
	capturedSources?: CapturedHookSourceSet;
	recordReceipt: HookReceiptSink;
	/** Injected for tests; defaults to the spawnSync runner. */
	runCommand?: UserHookCommandRunner;
	now?: () => number;
}

export interface BuildUserHookRegistrationsResult extends UserHookLoadResult {
	fileIssues: HookFileIssue[];
	/** One registration per admitted hook, in merged precedence order. Nothing is registered here. */
	registrations: MiddlewareHookRegistration[];
}

/**
 * Read project files, merge them with the captured extension declarations,
 * normalize, and build one registration per admitted hook. Pure with respect
 * to the middleware contract: the caller decides when the set is published,
 * which is what lets extension and hook state publish on one stack. The
 * returned hooks and issues feed `clio-coder config inspect`. Best-effort
 * throughout: a malformed file or hook is reported, never thrown.
 */
export function buildUserHookRegistrations(
	options: BuildUserHookRegistrationsOptions,
): BuildUserHookRegistrationsResult {
	const workspaceRoot = options.workspaceRoot ?? options.cwd;
	const readOptions: ReadHookSourcesOptions = { cwd: options.cwd };
	if (options.capturedSources !== undefined) readOptions.capturedSources = options.capturedSources;
	const { batches, fileIssues } = readHookSources(readOptions);
	const loaded = loadUserHooks(batches, { workspaceRoot });
	const runCommand = options.runCommand ?? spawnSyncCommandRunner();
	const registrations = loaded.hooks.map((hook) =>
		userHookToRegistration(hook, {
			recordReceipt: options.recordReceipt,
			runCommand,
			...(options.now !== undefined ? { now: options.now } : {}),
		}),
	);
	return { ...loaded, fileIssues, registrations };
}

/**
 * Production command runner. Runs the argv with no shell (so there is no string
 * to inject into), a wall-clock timeout, and a bounded output buffer.
 */
export function spawnSyncCommandRunner(): UserHookCommandRunner {
	return (argv, options): UserHookCommandResult => {
		const [command, ...args] = argv;
		// A user hook is operator automation, not Clio work: the environment is
		// normalized so a nested seam sees consistent state, but no role is claimed.
		const attribution = withManagedGitCommitAttributionEnvironment(process.env, {
			cwd: options.cwd ?? process.cwd(),
			evidence: {},
		});
		reportCommitAttributionDiagnostic(attribution.diagnostic);
		const result = spawnSync(command ?? "", args, {
			...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
			timeout: options.timeoutMs,
			maxBuffer: COMMAND_OUTPUT_MAX_BYTES,
			encoding: "utf8",
			shell: false,
			env: attribution.env,
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
