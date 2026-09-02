/**
 * Composition-root coordinator for extension generations.
 *
 * The extensions bundle owns the snapshot store and the middleware bundle
 * owns the registration table; neither knows the other exists. This module
 * is the only writer of both for the "user-hooks" owner and the only caller
 * of the extensions reload, and it sequences them so no observer can see
 * resources from one generation paired with hooks from another:
 *
 *   1. capture and canonicalize the workspace once;
 *   2. prepare the extension candidate (build, validate, reserve generation)
 *      and require its snapshot to be for that exact workspace;
 *   3. build the user-hook registrations from the candidate's captured
 *      declarations plus the project files under that workspace;
 *   4. prepare the middleware replacement (validate, build the next state);
 *   5. confirm both prepared states are still current, then publish both
 *      with two assignment-only calls in adjacent statements;
 *   6. only then emit conflicts, the reload event, and issue lines.
 *
 * Neither publish primitive validates, refuses, throws, or calls out, so a
 * partial publication is impossible by construction: every failure or stale
 * state is detected before step 5 and discards both prepared states. Boot
 * uses the same path, so the first extension generation and the first hook
 * set become live together; before that, readers take the ephemeral
 * generation-0 path. Everything here is synchronous; the reentrancy guard
 * exists for a caller that re-enters from a callback.
 */

import { realpathSync } from "node:fs";
import path from "node:path";
import type { ExtensionsReloadedPayload } from "../core/bus-events.js";
import type {
	ExtensionReloadCommitted,
	ExtensionReloadRejection,
	ExtensionSnapshotDiagnostics,
	ExtensionsContract,
} from "../domains/extensions/index.js";
import { EXTENSION_SNAPSHOT_DIAGNOSTIC_MESSAGE_CAP } from "../domains/extensions/index.js";
import {
	type BuildUserHookRegistrationsResult,
	buildUserHookRegistrations,
	type CapturedHookSourceSet,
	type HookReceiptSink,
	type MiddlewareContract,
	type MiddlewareRegistrationConflict,
	type UserHookCommandRunner,
} from "../domains/middleware/index.js";
import { capturedHookSourcesFor } from "./extension-hook-sources.js";

export interface ExtensionReloadHookSummary {
	/** Registrations published for the owner in this generation. */
	registered: number;
	dropped: number;
	fileIssues: number;
	issues: number;
	overridden: number;
}

export type ExtensionReloadOutcome =
	| (ExtensionReloadCommitted & { hooks: ExtensionReloadHookSummary; lines: ReadonlyArray<string> })
	| (ExtensionReloadRejection & { lines: ReadonlyArray<string> });

export interface ExtensionReloadCoordinatorDeps {
	/** Absent on a degraded boot where the extensions domain failed to start. */
	extensions: Pick<ExtensionsContract, "prepareReload" | "snapshot"> | undefined;
	middleware: Pick<MiddlewareContract, "prepareRegistrationReplacement" | "replaceRegistrations" | "ownedGeneration">;
	/** Read once per run and canonicalized; the candidate must be for exactly this workspace. */
	cwd: () => string;
	recordReceipt: HookReceiptSink;
	runCommand?: UserHookCommandRunner;
	now?: () => number;
	/** One operator line per issue; stderr in headless runs, dropped or noticed by the host in interactive runs. */
	report: (line: string) => void;
	/** Called once per published generation, after both references are live. */
	onCommitted?: (event: ExtensionsReloadedPayload) => void;
}

export interface ExtensionReloadCoordinator {
	/**
	 * Boot: publish generation 1 and its user hooks together. On a rejected
	 * build, or without an extensions domain, the project's own hooks are
	 * published under generation 1 and no extension generation exists.
	 */
	applyBoot(): ExtensionReloadOutcome;
	/** Operator or programmatic reload. Synchronous and never throws. */
	reload(): ExtensionReloadOutcome;
}

/** Cap on issue lines carried in one outcome so an operator surface stays bounded. */
export const EXTENSION_RELOAD_REPORT_LINE_CAP = 40;

function failure(message: string): ExtensionSnapshotDiagnostics {
	return {
		entries: [{ type: "error", message: message.slice(0, EXTENSION_SNAPSHOT_DIAGNOSTIC_MESSAGE_CAP) }],
		truncated: 0,
	};
}

function issueLines(
	built: BuildUserHookRegistrationsResult,
	dropped: ReadonlyArray<MiddlewareRegistrationConflict>,
): string[] {
	const lines: string[] = [];
	for (const issue of built.fileIssues) lines.push(`[clio-coder:hooks] ${issue.message}`);
	for (const issue of built.issues) {
		lines.push(`[clio-coder:hooks] ${issue.source.sourcePath}#${issue.index}: ${issue.issues.join("; ")}`);
	}
	for (const { loser, winner } of built.overridden) {
		lines.push(`[clio-coder:hooks] ${loser.source.sourcePath} hook '${loser.id}' overridden by ${winner.sourcePath}`);
	}
	for (const conflict of dropped) {
		lines.push(
			`[clio-coder:hooks] hook '${conflict.id}' dropped: id is held by a ${conflict.conflictsWith} registration`,
		);
	}
	return lines;
}

export function createExtensionReloadCoordinator(deps: ExtensionReloadCoordinatorDeps): ExtensionReloadCoordinator {
	let inFlight = false;

	const build = (workspace: string, captured: CapturedHookSourceSet | null): BuildUserHookRegistrationsResult =>
		buildUserHookRegistrations({
			cwd: workspace,
			workspaceRoot: workspace,
			...(captured !== null ? { capturedSources: captured } : {}),
			recordReceipt: deps.recordReceipt,
			...(deps.runCommand !== undefined ? { runCommand: deps.runCommand } : {}),
			...(deps.now !== undefined ? { now: deps.now } : {}),
		});

	const emitLines = (lines: ReadonlyArray<string>): void => {
		for (const line of lines) {
			try {
				deps.report(line);
			} catch {
				// Reporting is observability; it must never affect the reload.
			}
		}
	};

	const rejected = (rejection: ExtensionReloadRejection): ExtensionReloadOutcome => {
		const lines = rejection.diagnostics.entries.map((entry) => `[clio-coder:extensions] ${entry.message}`);
		emitLines(lines);
		return { ...rejection, lines: lines.slice(0, EXTENSION_RELOAD_REPORT_LINE_CAP) };
	};

	const canonicalWorkspace = (): string | null => {
		try {
			return realpathSync(path.resolve(deps.cwd()));
		} catch {
			return null;
		}
	};

	/**
	 * Degraded boot: no extension generation will ever exist, so the project's
	 * own hooks are published alone under generation 1. Readers keep taking
	 * the ephemeral path, which pairs no generation with no generation.
	 */
	const publishProjectHooksOnly = (workspace: string): void => {
		if (deps.middleware.ownedGeneration("user-hooks") !== 0) return;
		const built = build(workspace, null);
		const report = deps.middleware.replaceRegistrations("user-hooks", 1, built.registrations);
		const lines = issueLines(built, report.dropped);
		if (!report.applied) lines.push(`[clio-coder:hooks] project hooks were not applied: ${report.reason ?? "refused"}`);
		emitLines(lines);
	};

	const run = (boot: boolean): ExtensionReloadOutcome => {
		const activeGeneration = deps.extensions?.snapshot()?.generation ?? 0;
		if (inFlight) {
			return rejected({
				status: "rejected",
				reason: "reentrant",
				generation: activeGeneration,
				diagnostics: { entries: [], truncated: 0 },
			});
		}
		inFlight = true;
		try {
			const workspace = canonicalWorkspace();
			if (workspace === null) {
				return rejected({
					status: "rejected",
					reason: "build-failed",
					generation: activeGeneration,
					diagnostics: failure("the working directory could not be resolved"),
				});
			}
			if (deps.extensions === undefined) {
				if (boot) publishProjectHooksOnly(workspace);
				return rejected({
					status: "rejected",
					reason: "build-failed",
					generation: 0,
					diagnostics: failure("extensions domain is not loaded; restart to recover it"),
				});
			}
			const prepared = deps.extensions.prepareReload();
			if (prepared.status === "rejected") {
				if (boot) publishProjectHooksOnly(workspace);
				return rejected(prepared);
			}
			const candidate = prepared.candidate;
			if (candidate.snapshot.cwd !== workspace) {
				candidate.discard();
				return rejected({
					status: "rejected",
					reason: "workspace-changed",
					generation: candidate.previousGeneration,
					diagnostics: failure(
						`extension snapshot was built for ${candidate.snapshot.cwd} but the session workspace is ${workspace}`,
					),
				});
			}
			let built: BuildUserHookRegistrationsResult;
			try {
				built = build(workspace, capturedHookSourcesFor(candidate.snapshot));
			} catch (error) {
				candidate.discard();
				return rejected({
					status: "rejected",
					reason: "build-failed",
					generation: candidate.previousGeneration,
					diagnostics: failure(
						`user hook registrations could not be built: ${error instanceof Error ? error.message : String(error)}`,
					),
				});
			}
			const preparedReplacement = deps.middleware.prepareRegistrationReplacement(
				"user-hooks",
				candidate.generation,
				built.registrations,
			);
			if (preparedReplacement.status === "rejected") {
				candidate.discard();
				return rejected({
					status: "rejected",
					reason: "stale",
					generation: candidate.previousGeneration,
					diagnostics: failure(
						`middleware refused generation ${candidate.generation} (${preparedReplacement.reason}; active ${preparedReplacement.activeGeneration})`,
					),
				});
			}
			const replacement = preparedReplacement.replacement;
			// Final freshness validation. After this point neither primitive can
			// refuse, so a stale side here discards both and publishes neither.
			if (!candidate.current() || !replacement.current()) {
				replacement.discard();
				candidate.discard();
				return rejected({
					status: "rejected",
					reason: "stale",
					generation: candidate.previousGeneration,
					diagnostics: failure(`generation ${candidate.generation} was superseded before it could be published`),
				});
			}
			candidate.publish();
			replacement.publish();
			// Both references are live. Observers may run from here on.
			replacement.emitConflicts();
			const lines = issueLines(built, replacement.dropped);
			try {
				deps.onCommitted?.({
					generation: candidate.generation,
					previousGeneration: candidate.previousGeneration,
					changed: candidate.changed,
					digest: candidate.snapshot.digest,
				});
			} catch (error) {
				// Publication is already complete. An observability callback cannot
				// turn a live paired generation into a thrown or rejected outcome.
				const message = error instanceof Error ? error.message : String(error);
				lines.push(
					`[clio-coder:extensions] committed generation observer failed: ${message.slice(0, EXTENSION_SNAPSHOT_DIAGNOSTIC_MESSAGE_CAP)}`,
				);
			}
			emitLines(lines);
			return {
				status: "committed",
				generation: candidate.generation,
				previousGeneration: candidate.previousGeneration,
				changed: candidate.changed,
				digest: candidate.snapshot.digest,
				added: candidate.added,
				removed: candidate.removed,
				modified: candidate.modified,
				diagnostics: candidate.snapshot.diagnostics,
				hooks: {
					registered: replacement.size,
					dropped: replacement.dropped.length,
					fileIssues: built.fileIssues.length,
					issues: built.issues.length,
					overridden: built.overridden.length,
				},
				lines: lines.slice(0, EXTENSION_RELOAD_REPORT_LINE_CAP),
			};
		} finally {
			inFlight = false;
		}
	};

	return {
		applyBoot: () => run(true),
		reload: () => run(false),
	};
}
