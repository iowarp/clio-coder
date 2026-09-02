/**
 * Composition-root coordinator for extension generations.
 *
 * The extensions bundle owns the snapshot store and the middleware bundle
 * owns the registration table; neither knows the other exists. This module
 * is the only writer of both for the "user-hooks" owner, and it sequences
 * them so an observer can never see resources from one generation paired
 * with hooks from another:
 *
 *   1. prepare the extension candidate (build, validate, reserve generation);
 *   2. build the user-hook registrations from that candidate's captured
 *      declarations plus the project files;
 *   3. prepare the middleware replacement (validate, build the list);
 *   4. commit both with two reference assignments on one stack, with no
 *      await, callback, event, or logging between them;
 *   5. only then emit the reload event and report issues.
 *
 * Any failure before step 4 discards whatever was prepared and leaves both
 * committed generations untouched. Everything here is synchronous; the
 * reentrancy guard exists for a caller that re-enters from a callback.
 */

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
	type ExtensionHookSnapshotView,
	type HookReceiptSink,
	type MiddlewareContract,
	type MiddlewareRegistrationConflict,
	type UserHookCommandRunner,
} from "../domains/middleware/index.js";

export interface ExtensionsReloadedEvent {
	generation: number;
	previousGeneration: number;
	changed: boolean;
	digest: string;
}

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
	extensions: Pick<ExtensionsContract, "prepareReload" | "commitReload" | "discardReload" | "snapshot"> | undefined;
	middleware: Pick<MiddlewareContract, "prepareRegistrationReplacement" | "replaceRegistrations" | "ownedGeneration">;
	cwd: () => string;
	recordReceipt: HookReceiptSink;
	runCommand?: UserHookCommandRunner;
	now?: () => number;
	/** One operator line per issue; stderr in headless runs, dropped or noticed by the host in interactive runs. */
	report: (line: string) => void;
	/** Called once per committed reload, after both references are published. */
	onCommitted?: (event: ExtensionsReloadedEvent) => void;
}

export interface ExtensionReloadCoordinator {
	/** Boot: publish user hooks for the generation the extensions bundle committed at start. */
	applyCurrent(): BuildUserHookRegistrationsResult;
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

	const build = (snapshot: ExtensionHookSnapshotView | null): BuildUserHookRegistrationsResult =>
		buildUserHookRegistrations({
			cwd: deps.cwd(),
			...(snapshot !== null ? { extensionSnapshot: snapshot } : {}),
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

	return {
		applyCurrent() {
			const snapshot = deps.extensions?.snapshot() ?? null;
			const built = build(snapshot);
			// A degraded boot without an extensions domain still publishes the
			// project's own hooks under generation 1; nothing will ever reload it.
			const report = deps.middleware.replaceRegistrations("user-hooks", snapshot?.generation ?? 1, built.registrations);
			const lines = issueLines(built, report.dropped);
			if (!report.applied) lines.push(`[clio-coder:hooks] user hooks were not applied: ${report.reason ?? "refused"}`);
			emitLines(lines);
			return built;
		},
		reload() {
			const rejected = (
				rejection: ExtensionReloadRejection,
				lines: ReadonlyArray<string> = [],
			): ExtensionReloadOutcome => {
				const all = [...lines, ...rejection.diagnostics.entries.map((entry) => `[clio-coder:extensions] ${entry.message}`)];
				emitLines(all);
				return { ...rejection, lines: all.slice(0, EXTENSION_RELOAD_REPORT_LINE_CAP) };
			};
			if (deps.extensions === undefined) {
				return rejected({
					status: "rejected",
					reason: "build-failed",
					generation: 0,
					diagnostics: failure("extensions domain is not loaded; restart to recover it"),
				});
			}
			if (inFlight) {
				return rejected({
					status: "rejected",
					reason: "reentrant",
					generation: deps.extensions.snapshot()?.generation ?? 0,
					diagnostics: { entries: [], truncated: 0 },
				});
			}
			inFlight = true;
			try {
				const prepared = deps.extensions.prepareReload();
				if (prepared.status === "rejected") return rejected(prepared);
				const candidate = prepared.candidate;
				let built: BuildUserHookRegistrationsResult;
				try {
					built = build(candidate.snapshot);
				} catch (error) {
					deps.extensions.discardReload(candidate);
					return rejected({
						status: "rejected",
						reason: "build-failed",
						generation: candidate.previousGeneration,
						diagnostics: failure(
							`user hook registrations could not be built: ${error instanceof Error ? error.message : String(error)}`,
						),
					});
				}
				const replacement = deps.middleware.prepareRegistrationReplacement(
					"user-hooks",
					candidate.generation,
					built.registrations,
				);
				if (replacement.status === "rejected") {
					deps.extensions.discardReload(candidate);
					return rejected({
						status: "rejected",
						reason: "stale",
						generation: candidate.previousGeneration,
						diagnostics: failure(
							`middleware refused generation ${candidate.generation} (${replacement.reason}; active ${replacement.activeGeneration})`,
						),
					});
				}
				// Everything is validated. From here to the end of the two commits
				// nothing may await, emit, log, or call user code.
				if (!replacement.replacement.current()) {
					replacement.replacement.discard();
					deps.extensions.discardReload(candidate);
					return rejected({
						status: "rejected",
						reason: "stale",
						generation: candidate.previousGeneration,
						diagnostics: failure(`middleware generation moved before generation ${candidate.generation} could commit`),
					});
				}
				const committed = deps.extensions.commitReload(candidate);
				if (committed.status !== "committed") {
					replacement.replacement.discard();
					return rejected(committed);
				}
				const applied = replacement.replacement.commit();
				// Both references are published. Observers may run from here on.
				const lines = issueLines(built, applied.dropped);
				if (!applied.applied) {
					// Unreachable while both commits are synchronous: current() was
					// true one statement earlier. Reported rather than swallowed.
					lines.push(
						`[clio-coder:hooks] invariant violation: middleware refused generation ${candidate.generation} after the extension commit (${applied.reason ?? "refused"})`,
					);
				}
				deps.onCommitted?.({
					generation: committed.generation,
					previousGeneration: committed.previousGeneration,
					changed: committed.changed,
					digest: committed.digest,
				});
				emitLines(lines);
				return {
					...committed,
					hooks: {
						registered: applied.applied ? built.registrations.length - applied.dropped.length : 0,
						dropped: applied.dropped.length,
						fileIssues: built.fileIssues.length,
						issues: built.issues.length,
						overridden: built.overridden.length,
					},
					lines: lines.slice(0, EXTENSION_RELOAD_REPORT_LINE_CAP),
				};
			} finally {
				inFlight = false;
			}
		},
	};
}
