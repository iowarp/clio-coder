/**
 * Post-run enforcement of declared write boundaries.
 *
 * This is detect-and-rollback, not sandboxing. Nothing here prevents a write:
 * no container, no seccomp filter, no read-only mount, no interception of the
 * worker's file tools. A step runs with whatever reach its tool permissions
 * give it, and afterwards the orchestrator compares the checkout against the
 * snapshot it took before the step, rolls back what the step was not allowed to
 * change, and fails the step with a typed reason. An operator who needs a step
 * to be *unable* to write outside its allowlist needs OS-level isolation, which
 * this module deliberately does not claim to provide.
 *
 * Enforcement is orchestrator-side because a worker cannot be its own witness:
 * a self-check runs inside the process whose behaviour is in question, so the
 * only authority is the same one that seals result-contract validation.
 *
 * The comparison is git plumbing rather than a tree hash, because this runs
 * after every bounded step and must stay proportionate: one `status` call plus
 * one object-hash call over the dirty set, not a walk of the repository.
 *
 * Everything is pinned to the baseline commit recorded at snapshot time, so a
 * commit step that moves HEAD without touching the working tree reads as "no
 * change" instead of as a wholesale rewrite.
 *
 * A window's diff answers "what changed", never "who changed it". An operator
 * editing the checkout while a fleet runs produces changes inside the window
 * that no step made, and rolling those back to the baseline destroys work
 * nobody asked Clio to touch. So a change is blamed on the window only when it
 * intersects what the window's own runs recorded writing; everything else is
 * reported as an unattributed concurrent change and left exactly as it is.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readlinkSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { asDirectoryPathBoundary, pathBoundaryEntryCovers } from "../../core/path-boundary.js";
import { clioStateDir } from "../../core/xdg.js";
import { atomicWrite } from "../../engine/session.js";
import { isGitRepository } from "../../tools/compete-worktrees.js";
import {
	describeWriteBoundary,
	normalizeWriteBoundary,
	normalizeWriteBoundaryEntry,
	type WriteBoundary,
	writeBoundaryCovers,
} from "../agents/write-boundary.js";

/** Typed step failure an operator can act on: widen the declaration, or don't write there. */
export const WRITE_BOUNDARY_VIOLATION_REASON = "writes_boundary_violation";

/** Content token for a path that does not exist. */
const ABSENT = "absent";

const GIT_TIMEOUT_MS = 30_000;

function git(root: string, args: ReadonlyArray<string>, input?: string): string {
	return execFileSync("git", ["-C", root, ...args], {
		encoding: "utf8",
		stdio: ["pipe", "pipe", "pipe"],
		timeout: GIT_TIMEOUT_MS,
		maxBuffer: 64 * 1024 * 1024,
		...(input === undefined ? {} : { input }),
	});
}

function gitBytes(root: string, args: ReadonlyArray<string>): Buffer {
	return execFileSync("git", ["-C", root, ...args], {
		stdio: ["ignore", "pipe", "pipe"],
		timeout: GIT_TIMEOUT_MS,
		maxBuffer: 256 * 1024 * 1024,
	});
}

/**
 * Every path git currently reports as dirty, tracked or not. `-uall` lists
 * untracked files individually: a collapsed directory entry cannot be compared
 * against a path allowlist. `--no-renames` keeps one path per entry, so a
 * rename reads as the delete and the create it is on disk.
 *
 * Enforcement sees exactly what git sees, so an ignored path is outside it: a
 * repository decides what counts as its own content, and this is not the place
 * to overrule that. The consequence is that a boundary declared over an ignored
 * path could never be verified, which is why `assertWriteBoundaryVisibleToGit`
 * refuses that declaration before anything runs rather than letting this
 * function certify an unobserved window as clean.
 *
 * The one thing subtracted is Clio's own state directory when an operator has
 * placed it inside the workspace. Receipts, code-step logs, and boundary
 * verdicts are the orchestrator writing its journal while the step runs, and
 * blaming the step for them would make every window a violation.
 */
function dirtyPaths(root: string): string[] {
	const raw = git(root, ["status", "--porcelain=v1", "-z", "-uall", "--no-renames"]);
	const journal = repoRelative(root, clioStateDir());
	return raw
		.split("\0")
		.filter((entry) => entry.length > 3)
		.map((entry) => entry.slice(3))
		.filter((path) => journal === null || !(path === journal || path.startsWith(`${journal}/`)));
}

/**
 * Content identity of one working-tree path.
 *
 * A blob hash rather than a status letter, because status is a statement about
 * the index and this has to answer "are the bytes the same". A symlink is
 * recorded as its target, so replacing a file with a link out of the repository
 * is a change rather than an unreadable file.
 */
function contentTokens(root: string, paths: ReadonlyArray<string>): Map<string, string> {
	const tokens = new Map<string, string>();
	const hashable: string[] = [];
	for (const path of paths) {
		const full = join(root, path);
		let stat: ReturnType<typeof lstatSync>;
		try {
			stat = lstatSync(full);
		} catch {
			tokens.set(path, ABSENT);
			continue;
		}
		if (stat.isSymbolicLink()) {
			tokens.set(path, `link:${readlinkSync(full)}`);
			continue;
		}
		if (stat.isDirectory()) {
			tokens.set(path, "dir");
			continue;
		}
		if (!stat.isFile()) {
			tokens.set(path, `special:${stat.mode}`);
			continue;
		}
		// A newline in a path would corrupt the batch protocol, so those paths
		// are hashed one at a time rather than guessed at.
		if (path.includes("\n")) {
			tokens.set(path, `blob:${git(root, ["hash-object", "--", full]).trim()}`);
			continue;
		}
		hashable.push(path);
	}
	if (hashable.length > 0) {
		const hashes = git(root, ["hash-object", "--stdin-paths"], `${hashable.map((path) => join(root, path)).join("\n")}\n`)
			.split("\n")
			.filter((line) => line.length > 0);
		hashable.forEach((path, index) => {
			tokens.set(path, `blob:${hashes[index] ?? "unknown"}`);
		});
	}
	return tokens;
}

/** Content identity of the same paths in the pinned baseline commit. */
function baselineTokens(root: string, head: string, paths: ReadonlyArray<string>): Map<string, string> {
	const tokens = new Map<string, string>();
	if (paths.length === 0) return tokens;
	const query = paths.map((path) => `${head}:${path}`).join("\n");
	const answered = git(root, ["cat-file", "--batch-check=%(objectname) %(objecttype)"], `${query}\n`)
		.split("\n")
		.filter((line) => line.length > 0);
	paths.forEach((path, index) => {
		const line = answered[index] ?? "";
		const [objectName, objectType] = line.split(" ");
		if (objectType === "blob" && objectName !== undefined) tokens.set(path, `blob:${objectName}`);
		else if (objectType === "tree") tokens.set(path, "dir");
		else tokens.set(path, ABSENT);
	});
	return tokens;
}

/**
 * The workspace as it stood before a step ran: the commit every comparison is
 * pinned to, plus the content identity of everything already dirty. The dirty
 * half matters for rollback rather than for detection: a path this snapshot
 * already found modified has no stored content anywhere, so a later
 * unauthorized change to it cannot be undone without guessing.
 */
export interface WorkspaceSnapshot {
	root: string;
	head: string;
	/** Dirty path -> content token at capture time. */
	entries: ReadonlyMap<string, string>;
	capturedAt: string;
}

export function captureWorkspaceSnapshot(root: string): WorkspaceSnapshot {
	const absolute = resolve(root);
	if (!isGitRepository(absolute)) {
		throw new Error(
			`write boundary: ${absolute} is not a git repository, so a declared boundary cannot be verified (enforcement fails closed)`,
		);
	}
	const head = git(absolute, ["rev-parse", "HEAD"]).trim();
	const paths = dirtyPaths(absolute);
	return { root: absolute, head, entries: contentTokens(absolute, paths), capturedAt: new Date().toISOString() };
}

export interface WorkspaceChange {
	path: string;
	before: string;
	after: string;
}

/**
 * What changed since the snapshot. Candidates are the paths that were dirty
 * then plus the paths that are dirty now; anything else is identical to the
 * baseline in both readings and cannot have been touched and restored in a way
 * that matters to the repository.
 */
export function diffWorkspace(snapshot: WorkspaceSnapshot): WorkspaceChange[] {
	const candidates = [...new Set([...snapshot.entries.keys(), ...dirtyPaths(snapshot.root)])].sort();
	if (candidates.length === 0) return [];
	const unknownBefore = candidates.filter((path) => !snapshot.entries.has(path));
	const baseline = baselineTokens(snapshot.root, snapshot.head, unknownBefore);
	const now = contentTokens(snapshot.root, candidates);
	const changes: WorkspaceChange[] = [];
	for (const path of candidates) {
		const before = snapshot.entries.get(path) ?? baseline.get(path) ?? ABSENT;
		const after = now.get(path) ?? ABSENT;
		if (before !== after) changes.push({ path, before, after });
	}
	return changes;
}

export interface WriteBoundaryRollback {
	path: string;
	action: "restored" | "removed";
	/** Where the restored content came from, named so the record is checkable. */
	restoredFrom: string;
}

export interface WriteBoundaryUnrecoverable {
	path: string;
	reason: string;
}

/**
 * `clean` means no change outside the allowlist is attributable to this
 * window's steps. `rolled-back` means one was and the repository now looks as
 * it did before. Anything else is `rollback-incomplete`: the working tree is
 * left exactly as the step made it and handed to the operator with the list,
 * because a rollback that guesses at content it never recorded destroys work.
 *
 * A `clean` verdict can still carry `unattributed` paths. Those changed inside
 * the window and no run in it recorded writing them, so they are the
 * operator's, another process's, or a build artifact's, and nothing here may
 * touch them.
 */
export type WriteBoundaryStatus = "clean" | "rolled-back" | "rollback-incomplete";

/**
 * What the window's own runs recorded aiming a successful mutation at.
 *
 * This is the write-side witness the diff cannot be: the checkout says a path
 * changed, and only the run's own tool-call record says whether the run is what
 * changed it. The record comes from the same fold that grounds a sealed
 * mutation report, so the boundary and the result contract judge one set of
 * facts.
 *
 * A run can write through a channel no tool event enumerates, and then its path
 * set is a lower bound rather than the whole list. That is not silently
 * tolerated: the recorder knows which tools can do it (bash, verify, dispatch,
 * steer, and any tool this process has no schema for) and reports the record
 * open, which arrives here as `complete: false`. So the set is only ever read
 * as a closed list for a run that could not have written outside it, and
 * enforcement over a run that could stays exactly as strong as it was before
 * attribution existed.
 */
export interface WriteBoundaryAttribution {
	/**
	 * Paths the window's runs aimed a successful mutation at. Absolute, or
	 * relative to the workspace root; anything resolving outside the workspace is
	 * dropped, because git could not have reported it as a change either.
	 */
	recorded: ReadonlyArray<string>;
	/**
	 * False when at least one step in the window has no closed write record: a
	 * code step running a registered command, a runtime that publishes no tool
	 * telemetry, a run whose telemetry came back with holes, or a run that
	 * called a tool able to write a path its arguments do not name. An open
	 * record cannot clear anybody, so the window falls back to blaming every
	 * change outside the allowlist, and the verdict says it did.
	 */
	complete: boolean;
	/** Durable causes for an incomplete record. Empty only when complete is true. */
	downgrades?: ReadonlyArray<WriteBoundaryAttributionDowngrade>;
}

export type WriteBoundaryAttributionDowngradeReason =
	| "opaque_tool_succeeded"
	| "incomplete_tool_telemetry"
	| "code_step_untracked"
	| "write_record_unavailable";

/** Why one step could not offer a closed write record. */
export interface WriteBoundaryAttributionDowngrade {
	reason: WriteBoundaryAttributionDowngradeReason;
	/** Tool whose successful call opened the record, or null for a non-tool cause. */
	tool: string | null;
	/** Exact worker call when telemetry supplied one, or null for a non-tool cause. */
	toolCallId: string | null;
	/** Run that observed the cause, when one reached dispatch. */
	runId: string | null;
	/** Fleet step whose record was downgraded. */
	stepId: string | null;
}

/** One operator-facing explanation shared by live and durable surfaces. */
export function describeWriteBoundaryAttributionDowngrade(downgrade: WriteBoundaryAttributionDowngrade): string {
	if (downgrade.reason === "opaque_tool_succeeded") {
		const tool = downgrade.tool ?? "unknown";
		const call = downgrade.toolCallId === null ? "" : ` (call ${downgrade.toolCallId})`;
		return `a successful '${tool}' call${call} can write paths its arguments do not name`;
	}
	if (downgrade.reason === "incomplete_tool_telemetry") {
		return downgrade.runId === null
			? "tool telemetry was incomplete"
			: `run '${downgrade.runId}' reported incomplete tool telemetry`;
	}
	if (downgrade.reason === "code_step_untracked") {
		return downgrade.stepId === null
			? "a code step ran through the untracked command runner"
			: `code step '${downgrade.stepId}' ran through the untracked command runner`;
	}
	return downgrade.stepId === null
		? "no usable write record was available"
		: `step '${downgrade.stepId}' supplied no usable write record`;
}

export interface WriteBoundaryVerdict {
	version: 1;
	/** Which scheduling window this covers, e.g. `wave-2` or `revalidate-suite.check.1`. */
	window: string;
	/** Every step that ran inside the window. One id means exact attribution. */
	stepIds: ReadonlyArray<string>;
	/** The union the window was permitted to change. */
	allow: ReadonlyArray<string>;
	baselineHead: string;
	capturedAt: string;
	checkedAt: string;
	changedPaths: ReadonlyArray<string>;
	violations: ReadonlyArray<string>;
	/**
	 * Paths outside the allowlist that changed inside the window and that no run
	 * in it recorded writing. Recorded so the operator can see them, never rolled
	 * back: the window did not make them, so the baseline commit is not their
	 * prior content.
	 */
	unattributed: ReadonlyArray<string>;
	/** Whether every step in the window offered an enumerable write record. */
	attributionComplete: boolean;
	/** Why attribution was incomplete, including the causal tool call when known. */
	attributionDowngrades: ReadonlyArray<WriteBoundaryAttributionDowngrade>;
	rolledBack: ReadonlyArray<WriteBoundaryRollback>;
	unrecoverable: ReadonlyArray<WriteBoundaryUnrecoverable>;
	status: WriteBoundaryStatus;
	/** Typed failure reason, or null when the window stayed inside its boundary. */
	reason: typeof WRITE_BOUNDARY_VIOLATION_REASON | null;
	/**
	 * Operator-facing message naming the offending paths and the declaration, or
	 * naming the concurrent changes the window saw but did not cause. Null only
	 * when neither happened.
	 */
	detail: string | null;
	digest: string;
}

export interface EnforceWriteBoundaryInput {
	snapshot: WorkspaceSnapshot;
	window: string;
	stepIds: ReadonlyArray<string>;
	allow: WriteBoundary;
	/**
	 * What the window's runs recorded writing. Absent means no caller offered a
	 * record, which reads the same as an incomplete one: every change outside the
	 * allowlist is blamed on the window.
	 */
	attribution?: WriteBoundaryAttribution;
}

function canonicalVerdict(verdict: Omit<WriteBoundaryVerdict, "digest">): string {
	return JSON.stringify(verdict);
}

/**
 * Restore one unauthorized path.
 *
 * The only content this can restore is content git already has: the pinned
 * baseline commit. A path that was already dirty when the snapshot was taken
 * has its pre-step bytes nowhere but in the tree the step then overwrote, so it
 * is reported rather than reconstructed.
 */
function rollbackPath(
	snapshot: WorkspaceSnapshot,
	change: WorkspaceChange,
): { rolledBack?: WriteBoundaryRollback; unrecoverable?: WriteBoundaryUnrecoverable } {
	const full = join(snapshot.root, change.path);
	if (snapshot.entries.has(change.path)) {
		return {
			unrecoverable: {
				path: change.path,
				reason: `path was already modified or untracked before the step, so its prior content is not recorded anywhere`,
			},
		};
	}
	if (change.before === ABSENT) {
		try {
			rmSync(full, { force: true, recursive: false });
		} catch (error) {
			return {
				unrecoverable: { path: change.path, reason: `could not remove: ${(error as Error).message}` },
			};
		}
		return { rolledBack: { path: change.path, action: "removed", restoredFrom: "did not exist at baseline" } };
	}
	if (!change.before.startsWith("blob:")) {
		return {
			unrecoverable: {
				path: change.path,
				reason: `baseline state '${change.before}' is not a regular file and is not restorable in place`,
			},
		};
	}
	try {
		const content = gitBytes(snapshot.root, ["cat-file", "blob", `${snapshot.head}:${change.path}`]);
		mkdirSync(dirname(full), { recursive: true });
		// Written directly rather than through `git checkout`, which would also
		// stage the path and quietly rewrite an operator's index.
		writeFileSync(full, content);
	} catch (error) {
		return {
			unrecoverable: { path: change.path, reason: `could not restore from baseline: ${(error as Error).message}` },
		};
	}
	return { rolledBack: { path: change.path, action: "restored", restoredFrom: `${snapshot.head}:${change.path}` } };
}

/**
 * Whether one changed path falls inside what a run recorded writing.
 *
 * A recorded target is usually the exact file a write or edit named, but a
 * command's delete target can be a directory, so a change under a recorded
 * prefix counts as the same write. Matching is on segment boundaries: `work`
 * does not cover `workspace/a.txt`.
 */
function withinRecordedWrite(recorded: ReadonlySet<string>, path: string): boolean {
	if (recorded.has(path)) return true;
	for (const target of recorded) {
		if (path.startsWith(`${target}/`)) return true;
	}
	return false;
}

/**
 * Compare, roll back, and return the verdict. Never throws for a violation: a
 * violation is evidence the caller records and acts on, not an exception that
 * would lose the list of what was restored.
 */
export function enforceWriteBoundary(input: EnforceWriteBoundaryInput): WriteBoundaryVerdict {
	const allow = normalizeWriteBoundary(input.allow);
	const changes = diffWorkspace(input.snapshot);
	const outside = changes.filter((change) => !writeBoundaryCovers(allow, change.path));
	const attributionComplete = input.attribution?.complete === true;
	const attributionDowngrades: ReadonlyArray<WriteBoundaryAttributionDowngrade> = attributionComplete
		? []
		: input.attribution?.downgrades !== undefined && input.attribution.downgrades.length > 0
			? input.attribution.downgrades.map((entry) => ({ ...entry }))
			: [
					{
						reason: "write_record_unavailable",
						tool: null,
						toolCallId: null,
						runId: null,
						stepId: input.stepIds.length === 1 ? (input.stepIds[0] ?? null) : null,
					},
				];
	const recorded = new Set<string>();
	for (const target of input.attribution?.recorded ?? []) {
		const relativeTarget = repoRelative(input.snapshot.root, target);
		if (relativeTarget !== null) recorded.add(relativeTarget);
	}
	// Without a complete record nothing can be cleared, so the window keeps the
	// whole diff. With one, only what the runs actually wrote is theirs.
	const violations = attributionComplete
		? outside.filter((change) => withinRecordedWrite(recorded, change.path))
		: outside;
	const unattributed = attributionComplete
		? outside.filter((change) => !withinRecordedWrite(recorded, change.path))
		: [];
	const rolledBack: WriteBoundaryRollback[] = [];
	const unrecoverable: WriteBoundaryUnrecoverable[] = [];
	for (const change of violations) {
		const outcome = rollbackPath(input.snapshot, change);
		if (outcome.rolledBack !== undefined) rolledBack.push(outcome.rolledBack);
		if (outcome.unrecoverable !== undefined) unrecoverable.push(outcome.unrecoverable);
	}
	const status: WriteBoundaryStatus =
		violations.length === 0 ? "clean" : unrecoverable.length === 0 ? "rolled-back" : "rollback-incomplete";
	const who =
		input.stepIds.length === 1
			? `step '${input.stepIds[0]}'`
			: `steps ${input.stepIds.map((id) => `'${id}'`).join(", ")} ran concurrently in one checkout, so the write cannot be attributed to one of them`;
	const violationDetail =
		violations.length === 0
			? []
			: [
					`${who} wrote outside its declared boundary.`,
					`Unauthorized paths: ${violations.map((change) => change.path).join(", ")}.`,
					`Declared writes: ${describeWriteBoundary(allow)}.`,
					status === "rolled-back"
						? "Those paths were rolled back to the baseline commit."
						: `Rollback is incomplete; the working tree is left as the step made it. Unrestorable: ${unrecoverable
								.map((entry) => `${entry.path} (${entry.reason})`)
								.join("; ")}.`,
					attributionComplete
						? "Each was blamed on this window because a run in it recorded writing that path."
						: `Attribution was incomplete because ${attributionDowngrades
								.map(describeWriteBoundaryAttributionDowngrade)
								.join("; ")}, so every change outside the declaration was blamed on this window.`,
					"If the change was legitimate, widen the step's `writes:` declaration to cover it.",
				];
	const concurrentDetail =
		unattributed.length === 0
			? []
			: [
					`Concurrent changes were seen in this window that no run in it recorded writing: ${unattributed
						.map((change) => change.path)
						.join(", ")}.`,
					"They were left untouched, because a path this window did not write is not this window's to restore.",
				];
	const detail = [...violationDetail, ...concurrentDetail];
	const body: Omit<WriteBoundaryVerdict, "digest"> = {
		version: 1,
		window: input.window,
		stepIds: [...input.stepIds],
		allow,
		baselineHead: input.snapshot.head,
		capturedAt: input.snapshot.capturedAt,
		checkedAt: new Date().toISOString(),
		changedPaths: changes.map((change) => change.path),
		violations: violations.map((change) => change.path),
		unattributed: unattributed.map((change) => change.path),
		attributionComplete,
		attributionDowngrades,
		rolledBack,
		unrecoverable,
		status,
		reason: violations.length === 0 ? null : WRITE_BOUNDARY_VIOLATION_REASON,
		detail: detail.length === 0 ? null : detail.join(" "),
	};
	return { ...body, digest: createHash("sha256").update(canonicalVerdict(body), "utf8").digest("hex") };
}

/**
 * Refuse a declaration that leaves the repository through a symlink. An entry
 * is matched against git's own repo-relative paths, so a link that points
 * outside can never be *reported* as changed; declaring it would create a
 * boundary that silently permits nothing and hides real writes elsewhere.
 */
export function assertWriteBoundaryInsideRoot(root: string, allow: WriteBoundary): void {
	const realRoot = realpathSync(resolve(root));
	for (const entry of allow) {
		const relativeEntry = entry.endsWith("/") ? entry.slice(0, -1) : entry;
		let probe = join(realRoot, relativeEntry);
		// Resolve the longest existing prefix: a boundary may legitimately name a
		// path a step is about to create.
		while (probe !== realRoot && !existsSync(probe)) probe = dirname(probe);
		const resolved = realpathSync(probe);
		// The root is inside itself. The prefix walk above stops at the root when
		// a declared directory does not exist yet, and `pathBoundaryEntryCovers`
		// answers a different question: it asks whether a changed path falls under
		// a declaration, where the directory entry itself is not a change git ever
		// reports. Asking it about the root would refuse every boundary naming a
		// path the step is about to create.
		if (resolved !== realRoot && !pathBoundaryEntryCovers(asDirectoryPathBoundary(realRoot), resolved)) {
			throw new Error(`write boundary: entry '${entry}' resolves to ${resolved}, outside the workspace at ${realRoot}`);
		}
	}
}

/**
 * Refuse a declaration git will never report on.
 *
 * `git status` does not list an ignored path, so a boundary entry the
 * repository ignores names a region enforcement is blind to: every window over
 * it is certified clean without a single observation, which is a stronger claim
 * than "nothing was checked" and reads as a passing one. That is the same
 * defect `assertWriteBoundaryInsideRoot` refuses for an entry that leaves the
 * workspace through a symlink, so it is refused in the same place and at the
 * same time, before anything runs.
 *
 * A tracked path is reportable whatever the ignore rules say, and git's own
 * index-aware check is what decides that, so this never refuses a path the
 * repository is actually following.
 */
export function assertWriteBoundaryVisibleToGit(root: string, allow: WriteBoundary): void {
	// Entry by entry rather than through `normalizeWriteBoundary`, whose 32-entry
	// cap is a per-step declaration limit. A caller may legitimately ask this
	// question about every entry a whole plan declared.
	const entries = [...new Set(allow.map(normalizeWriteBoundaryEntry))].sort();
	if (entries.length === 0) return;
	const absolute = resolve(root);
	let raw: string;
	try {
		raw = git(absolute, ["check-ignore", "-v", "-z", "--stdin"], `${entries.join("\0")}\0`);
	} catch (error) {
		// `check-ignore` exits 1 when nothing matched, which is the common answer
		// and not a failure. Any other exit is a real inability to decide, and
		// enforcement fails closed rather than assuming visibility.
		const status = (error as { status?: number }).status;
		if (status === 1) return;
		throw new Error(
			`write boundary: could not determine whether ${describeWriteBoundary(entries)} is ignored by git in ${absolute}: ${(error as Error).message}`,
		);
	}
	const fields = raw.split("\0");
	const refusals: string[] = [];
	// `-v -z` emits source, line number, pattern, and pathname per match.
	for (let index = 0; index + 3 < fields.length; index += 4) {
		const [source, line, pattern, path] = fields.slice(index, index + 4);
		if (path === undefined || path.length === 0) continue;
		refusals.push(`'${path}' is ignored by ${source}:${line}:${pattern}`);
	}
	if (refusals.length === 0) return;
	throw new Error(
		`write boundary: ${refusals.join(", ")}. git status never reports an ignored path, so a boundary declared over one is verified against nothing and every window would be certified clean without an observation. Declare a path the repository tracks, or stop ignoring this one.`,
	);
}

/**
 * Workspace-relative form of a path, or null when it resolves outside. A
 * relative input is taken as already workspace-relative, which is how a
 * recorded write target and an absolute state directory both normalize here.
 */
function repoRelative(root: string, path: string): string | null {
	const base = resolve(root);
	const rel = relative(base, resolve(base, path));
	if (rel.length === 0 || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null;
	return rel.split(sep).join("/");
}

// ---------------------------------------------------------------------------
// Durable record
// ---------------------------------------------------------------------------

/**
 * Verdicts are recorded beside the run ledger, in the shape code steps already
 * use: `write-boundaries/<rootId>/<window>.json` under the Clio state
 * directory. A verdict is a fact about the checkout across a scheduling window,
 * not about one model run, so it has no receipt to be sealed inside; it carries
 * its own digest and names the baseline commit it was computed against.
 */
export function writeBoundaryDir(rootId: string): string {
	return join(clioStateDir(), "write-boundaries", rootId);
}

function writeBoundaryVerdictPath(rootId: string, window: string): string {
	return join(writeBoundaryDir(rootId), `${window.replace(/[^A-Za-z0-9._-]/gu, "_")}.json`);
}

export function writeWriteBoundaryVerdict(rootId: string, verdict: WriteBoundaryVerdict): string {
	const path = writeBoundaryVerdictPath(rootId, verdict.window);
	atomicWrite(path, `${JSON.stringify(verdict, null, 2)}\n`);
	return path;
}
