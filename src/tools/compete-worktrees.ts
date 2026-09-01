/**
 * Scratch git worktrees for the compete dispatch topology.
 *
 * Each candidate builds in its own worktree on its own branch
 * (`clio-coder/compete/<group>/<n>`), created from the repository HEAD under
 * `<root>/.clio-coder/worktrees/<group>/candidate-<n>`. The path sits inside the
 * project root because remote fleet nodes share the filesystem and doctor
 * preflight verifies path parity only for the project root; `.clio-coder/` is
 * ignored, so candidate churn never dirties the repository status.
 *
 * A group is claimed by a durable owner manifest before the first git
 * worktree mutation. Cleanup requires that exact claim and uses canonical,
 * segment-aware path checks. The claim also leases every admitted worker to
 * the coordinator process. On restart, a dead coordinator's exact worker
 * processes are terminated before its active group is made cleanup-ready;
 * live owners, preserved winners, and malformed claims are never inferred to
 * be abandoned.
 */

import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmdirSync,
	rmSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { hostname } from "node:os";
import { join, relative, resolve } from "node:path";
import type { RunGateWorktreeProvenance, RunKind } from "../domains/dispatch/types.js";
import {
	commitWorktreePath,
	isCanonicalWorktreePathInside,
	mergeWorktreeBranch,
	protectedPathsChangedByWorktreeBranch,
	worktreeBranchDiffStat,
} from "./task-worktree.js";

export interface CandidateWorktree {
	index: number;
	branch: string;
	path: string;
	provenance?: RunGateWorktreeProvenance;
}

/** Narrow mux surface used by compete; the native functions remain usable alone. */
export interface CompeteMuxWorktrees {
	available(): boolean;
	worktreeCreate(request: {
		cwd: string;
		branch: string;
		base: string;
		path: string;
		label: string;
		focus: boolean;
	}): Promise<{
		workspaceId: string;
		worktree: { path: string; branch: string | null };
	} | null>;
	worktreeRemove(workspaceId: string, options?: { force?: boolean }): Promise<boolean>;
}

export type CompeteGroupState = "active" | "cleanup-ready" | "winner-preserved";

/** Proof that this exact directory was claimed as one compete transaction. */
export interface CompeteGroupOwnership {
	root: string;
	group: string;
	directory: string;
	token: string;
	state: CompeteGroupState;
	winnerIndex?: number;
}

export interface CompeteRecoveryResult {
	cleaned: string[];
	preserved: string[];
	failed: Array<{ group: string; message: string }>;
}

export interface CompeteRecoveryOptions {
	/** Keep these quiesced active groups until their pending judge output is resolved. */
	preserveActiveGroups?: ReadonlySet<string>;
	/** Fail-closed journal fallback: quiesce, but retain, every abandoned active group. */
	preserveAllActive?: boolean;
}

interface CompeteGroupManifest {
	version: 2;
	kind: string;
	root: string;
	group: string;
	token: string;
	state: CompeteGroupState;
	createdAt: string;
	updatedAt: string;
	winnerIndex?: number;
	owner: CompeteProcessLease;
	runs: CompeteRunLease[];
}

interface CompeteProcessLease {
	host: string;
	pid: number;
	birthToken: string | null;
}

interface CompeteRunLease {
	runId: string;
	pid: number | null;
	birthToken: string | null;
	processGroup: boolean;
}

export interface CompeteRunAdmission {
	runId: string;
	pid: number | null;
	runtimeKind: RunKind;
}

const COMPETE_PARENT_SEGMENTS = [".clio-coder", "worktrees"] as const;
const COMPETE_MANIFEST_FILE = ".clio-coder-compete-owner.json";
const COMPETE_MANIFEST_KIND = "clio-coder-compete-group";
const LEGACY_COMPETE_MANIFEST_KIND = "clio-compete-group";
const COMPETE_COMMIT_IDENTITY = "clio-coder-compete";

const SAFE_GROUP = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const PROCESS_EXIT_GRACE_MS = 750;
const PROCESS_POLL_MS = 25;

function git(root: string, args: string[]): string {
	return execFileSync("git", ["-C", root, ...args], {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
		timeout: 30_000,
	}).trim();
}

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

interface ProcessSnapshot {
	alive: boolean;
	birthToken: string | null;
}

/**
 * Return a PID-reuse-resistant process identity where the host exposes one.
 * Linux's kernel start ticks are stable for the lifetime of a process. The
 * portable fallback uses `ps` start time; if neither is available we retain
 * liveness but refuse to signal a live PID during restart recovery.
 */
function processSnapshot(pid: number): ProcessSnapshot {
	if (!Number.isSafeInteger(pid) || pid <= 0) return { alive: false, birthToken: null };
	try {
		process.kill(pid, 0);
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "EPERM") return { alive: false, birthToken: null };
	}

	try {
		const stat = readFileSync(`/proc/${pid}/stat`, "utf8").trim();
		const close = stat.lastIndexOf(")");
		if (close > 0) {
			// Fields after the command name start at kernel field 3. Field 3 is
			// process state and field 22 (index 19 here) is starttime in ticks.
			const fields = stat
				.slice(close + 1)
				.trim()
				.split(/\s+/u);
			if (fields[0] === "Z") return { alive: false, birthToken: fields[19] ?? null };
			const startTicks = fields[19];
			if (startTicks !== undefined && /^\d+$/u.test(startTicks)) {
				return { alive: true, birthToken: `linux:${startTicks}` };
			}
		}
	} catch {
		// Non-Linux host or procfs unavailable; try the portable fallback.
	}

	try {
		const started = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
			timeout: 2_000,
		}).trim();
		if (started.length > 0) return { alive: true, birthToken: `ps:${started}` };
	} catch {
		// The PID exists, but it cannot be identified strongly enough to kill.
	}
	return { alive: true, birthToken: null };
}

function currentProcessLease(): CompeteProcessLease {
	return {
		host: hostname(),
		pid: process.pid,
		birthToken: processSnapshot(process.pid).birthToken,
	};
}

function validProcessLease(value: unknown): value is CompeteProcessLease {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const lease = value as Record<string, unknown>;
	return (
		typeof lease.host === "string" &&
		lease.host.length > 0 &&
		typeof lease.pid === "number" &&
		Number.isSafeInteger(lease.pid) &&
		lease.pid > 0 &&
		(lease.birthToken === null || typeof lease.birthToken === "string")
	);
}

function validRunLease(value: unknown): value is CompeteRunLease {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const lease = value as Record<string, unknown>;
	return (
		typeof lease.runId === "string" &&
		lease.runId.length > 0 &&
		(lease.pid === null || (typeof lease.pid === "number" && Number.isSafeInteger(lease.pid) && lease.pid > 0)) &&
		(lease.birthToken === null || typeof lease.birthToken === "string") &&
		typeof lease.processGroup === "boolean"
	);
}

function ownerIsAlive(owner: CompeteProcessLease): boolean {
	if (owner.host !== hostname()) return true;
	const snapshot = processSnapshot(owner.pid);
	if (!snapshot.alive) return false;
	// A null identity cannot distinguish PID reuse, so preserving is the only
	// safe choice. Supported hosts normally provide a token above.
	if (owner.birthToken === null || snapshot.birthToken === null) return true;
	return owner.birthToken === snapshot.birthToken;
}

function waitForProcessExit(pid: number, birthToken: string): boolean {
	const deadline = Date.now() + PROCESS_EXIT_GRACE_MS;
	const sleeper = new Int32Array(new SharedArrayBuffer(4));
	while (Date.now() < deadline) {
		const snapshot = processSnapshot(pid);
		if (!snapshot.alive || snapshot.birthToken !== birthToken) return true;
		Atomics.wait(sleeper, 0, 0, PROCESS_POLL_MS);
	}
	const finalSnapshot = processSnapshot(pid);
	return !finalSnapshot.alive || finalSnapshot.birthToken !== birthToken;
}

/** Terminate only the exact process identity durably leased to this group. */
function terminateRunLease(lease: CompeteRunLease): boolean {
	if (lease.pid === null) return true;
	const snapshot = processSnapshot(lease.pid);
	if (!snapshot.alive) return true;
	if (lease.birthToken === null || snapshot.birthToken === null) return false;
	if (lease.birthToken !== snapshot.birthToken) return true;

	const target = lease.processGroup && process.platform !== "win32" ? -lease.pid : lease.pid;
	try {
		process.kill(target, "SIGTERM");
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ESRCH") return true;
		return false;
	}
	if (waitForProcessExit(lease.pid, lease.birthToken)) return true;
	try {
		process.kill(target, "SIGKILL");
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ESRCH") return true;
		return false;
	}
	return waitForProcessExit(lease.pid, lease.birthToken);
}

function validateGroup(group: string): void {
	if (!SAFE_GROUP.test(group) || group === "." || group === "..") {
		throw new Error(`invalid compete group '${group}'`);
	}
}

function canonicalRoot(root: string): string {
	return realpathSync(root);
}

function competeParent(root: string): string {
	return join(root, ...COMPETE_PARENT_SEGMENTS);
}

function groupDirectory(root: string, group: string): string {
	validateGroup(group);
	return join(competeParent(root), group);
}

function manifestPath(directory: string): string {
	return join(directory, COMPETE_MANIFEST_FILE);
}

function isPlainDirectory(path: string): boolean {
	try {
		const stat = lstatSync(path);
		return stat.isDirectory() && !stat.isSymbolicLink();
	} catch {
		return false;
	}
}

function isCanonicalDirectoryAt(path: string): boolean {
	if (!isPlainDirectory(path)) return false;
	try {
		return relative(realpathSync(path), resolve(path)) === "";
	} catch {
		return false;
	}
}

/**
 * Whether `candidate` is strictly below `parent` after canonical resolution.
 * `relative()` makes the decision by path segment, so `/group-a2` can never
 * be mistaken for a child of `/group-a` as it can with textual startsWith.
 */
function isCanonicalPathInside(parent: string, candidate: string): boolean {
	return isCanonicalWorktreePathInside(parent, candidate);
}

function manifestFromUnknown(value: unknown): CompeteGroupManifest | null {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
	const manifest = value as Record<string, unknown>;
	if (
		manifest.version !== 2 ||
		(manifest.kind !== COMPETE_MANIFEST_KIND && manifest.kind !== LEGACY_COMPETE_MANIFEST_KIND) ||
		typeof manifest.root !== "string" ||
		typeof manifest.group !== "string" ||
		typeof manifest.token !== "string" ||
		manifest.token.length === 0 ||
		(manifest.state !== "active" && manifest.state !== "cleanup-ready" && manifest.state !== "winner-preserved") ||
		typeof manifest.createdAt !== "string" ||
		typeof manifest.updatedAt !== "string"
	) {
		return null;
	}
	if (
		!validProcessLease(manifest.owner) ||
		!Array.isArray(manifest.runs) ||
		!manifest.runs.every(validRunLease) ||
		new Set(manifest.runs.map((run) => run.runId)).size !== manifest.runs.length
	) {
		return null;
	}
	if (
		manifest.winnerIndex !== undefined &&
		(typeof manifest.winnerIndex !== "number" || !Number.isInteger(manifest.winnerIndex) || manifest.winnerIndex < 1)
	) {
		return null;
	}
	return manifest as unknown as CompeteGroupManifest;
}

function readManifest(root: string, group: string): CompeteGroupManifest | null {
	const canonical = canonicalRoot(root);
	const directory = groupDirectory(canonical, group);
	if (!isCanonicalDirectoryAt(directory)) return null;
	try {
		const parsed = JSON.parse(readFileSync(manifestPath(directory), "utf8")) as unknown;
		const manifest = manifestFromUnknown(parsed);
		if (manifest === null || manifest.root !== canonical || manifest.group !== group) return null;
		return manifest;
	} catch {
		return null;
	}
}

function ownershipFromManifest(manifest: CompeteGroupManifest): CompeteGroupOwnership {
	return {
		root: manifest.root,
		group: manifest.group,
		directory: groupDirectory(manifest.root, manifest.group),
		token: manifest.token,
		state: manifest.state,
		...(manifest.winnerIndex !== undefined ? { winnerIndex: manifest.winnerIndex } : {}),
	};
}

function assertOwnership(ownership: CompeteGroupOwnership): CompeteGroupManifest {
	const manifest = readManifest(ownership.root, ownership.group);
	if (manifest === null || manifest.token !== ownership.token) {
		throw new Error(`compete group ${ownership.group} has no matching ownership manifest; refusing cleanup`);
	}
	if (resolve(ownership.directory) !== resolve(groupDirectory(manifest.root, manifest.group))) {
		throw new Error(`compete group ${ownership.group} ownership path changed; refusing cleanup`);
	}
	return manifest;
}

function replaceManifest(ownership: CompeteGroupOwnership, manifest: CompeteGroupManifest): void {
	assertOwnership(ownership);
	const destination = manifestPath(ownership.directory);
	const temporary = `${destination}.${randomBytes(6).toString("hex")}.tmp`;
	try {
		writeFileSync(temporary, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
		renameSync(temporary, destination);
	} finally {
		if (existsSync(temporary)) rmSync(temporary, { force: true });
	}
}

export function isGitRepository(root: string): boolean {
	try {
		return git(root, ["rev-parse", "--is-inside-work-tree"]) === "true";
	} catch {
		return false;
	}
}

function competeBranch(group: string, index: number, legacy = false): string {
	validateGroup(group);
	if (!Number.isInteger(index) || index < 1) throw new Error(`invalid compete candidate index ${index}`);
	return `${legacy ? "clio" : "clio-coder"}/compete/${group}/${index}`;
}

function competeBranchMatches(branch: string, group: string, index: number): boolean {
	return branch === competeBranch(group, index) || branch === competeBranch(group, index, true);
}

/** Claim the group before creating a branch or candidate worktree. */
export function claimCompeteGroup(root: string, group: string): CompeteGroupOwnership {
	const canonical = canonicalRoot(root);
	const directory = groupDirectory(canonical, group);
	const parent = competeParent(canonical);
	mkdirSync(parent, { recursive: true });
	if (!isCanonicalDirectoryAt(parent)) {
		throw new Error(`compete parent ${parent} is not a canonical local directory`);
	}
	mkdirSync(directory);
	if (!isCanonicalDirectoryAt(directory)) {
		throw new Error(`compete group directory ${directory} is not canonical`);
	}
	const now = new Date().toISOString();
	const manifest: CompeteGroupManifest = {
		version: 2,
		kind: COMPETE_MANIFEST_KIND,
		root: canonical,
		group,
		token: randomBytes(16).toString("hex"),
		state: "active",
		createdAt: now,
		updatedAt: now,
		owner: currentProcessLease(),
		runs: [],
	};
	try {
		writeFileSync(manifestPath(directory), `${JSON.stringify(manifest, null, 2)}\n`, {
			encoding: "utf8",
			flag: "wx",
		});
	} catch (err) {
		// mkdirSync above proved this invocation created the directory. Roll back
		// only that still-empty claim; never sweep a pre-existing directory.
		try {
			rmdirSync(directory);
		} catch {
			// A partial or externally modified claim is now unproven and is kept.
		}
		throw err;
	}
	return ownershipFromManifest(manifest);
}

/** Load an exact durable claim, or null when ownership cannot be proven. */
export function loadCompeteGroup(root: string, group: string): CompeteGroupOwnership | null {
	validateGroup(group);
	const manifest = readManifest(root, group);
	return manifest === null ? null : ownershipFromManifest(manifest);
}

/**
 * Durably attach an admitted dispatch process to its compete transaction.
 * The dispatch extension invokes this before returning the run handle, which
 * closes the coordinator-crash window between process admission and tool-side
 * bookkeeping.
 */
export function registerCompeteGroupRun(ownership: CompeteGroupOwnership, admission: CompeteRunAdmission): void {
	const current = assertOwnership(ownership);
	if (current.state !== "active") {
		throw new Error(`compete group ${ownership.group} is ${current.state}; refusing new run ${admission.runId}`);
	}
	if (admission.runId.length === 0) throw new Error("worktree transaction run id cannot be empty");
	if (admission.pid !== null && (!Number.isSafeInteger(admission.pid) || admission.pid <= 0)) {
		throw new Error(`worktree transaction run ${admission.runId} has invalid pid ${admission.pid}`);
	}
	const lease: CompeteRunLease = {
		runId: admission.runId,
		pid: admission.pid,
		birthToken: admission.pid === null ? null : processSnapshot(admission.pid).birthToken,
		processGroup: admission.runtimeKind === "acp-delegation" && process.platform !== "win32",
	};
	const next: CompeteGroupManifest = {
		...current,
		runs: [...current.runs.filter((run) => run.runId !== admission.runId), lease],
		updatedAt: new Date().toISOString(),
	};
	replaceManifest(ownership, next);
}

/** Mark one leased process settled; stale leases remain safe to probe after a crash. */
export function settleCompeteGroupRun(ownership: CompeteGroupOwnership, runId: string): void {
	const current = assertOwnership(ownership);
	if (current.state !== "active") return;
	if (!current.runs.some((run) => run.runId === runId)) return;
	const next: CompeteGroupManifest = {
		...current,
		runs: current.runs.filter((run) => run.runId !== runId),
		updatedAt: new Date().toISOString(),
	};
	replaceManifest(ownership, next);
}

export function markCompeteGroupCleanupReady(ownership: CompeteGroupOwnership): CompeteGroupOwnership {
	const current = assertOwnership(ownership);
	const next: CompeteGroupManifest = {
		...current,
		state: "cleanup-ready",
		updatedAt: new Date().toISOString(),
	};
	Reflect.deleteProperty(next, "winnerIndex");
	replaceManifest(ownership, next);
	return ownershipFromManifest(next);
}

export function markCompeteGroupWinnerPreserved(
	ownership: CompeteGroupOwnership,
	winnerIndex: number,
): CompeteGroupOwnership {
	competeBranch(ownership.group, winnerIndex);
	const current = assertOwnership(ownership);
	const next: CompeteGroupManifest = {
		...current,
		state: "winner-preserved",
		winnerIndex,
		updatedAt: new Date().toISOString(),
	};
	replaceManifest(ownership, next);
	return ownershipFromManifest(next);
}

/**
 * Create one worktree for `index` from an explicit baseline commit. The
 * baseline is a parameter rather than HEAD so every candidate in a compete
 * transaction starts from the same approved state.
 */
function createCandidateWorktree(ownership: CompeteGroupOwnership, index: number, baseline: string): CandidateWorktree {
	assertOwnership(ownership);
	const branch = competeBranch(ownership.group, index);
	const path = join(ownership.directory, `candidate-${index}`);
	if (!isCanonicalPathInside(ownership.directory, path)) {
		throw new Error(`candidate ${index} path escapes compete group ${ownership.group}`);
	}
	git(ownership.root, ["worktree", "add", "-b", branch, path, baseline]);
	return { index, branch, path };
}

/**
 * Prefer herdr's worktree lifecycle while preserving Git as the recovery
 * authority. A failed or vanished mux is deliberately indistinguishable from
 * no mux to the caller except for the receipt provenance returned here.
 */
export async function createCandidateWorktreeMapped(
	ownership: CompeteGroupOwnership,
	index: number,
	baseline: string,
	mux?: CompeteMuxWorktrees,
): Promise<CandidateWorktree> {
	assertOwnership(ownership);
	const branch = competeBranch(ownership.group, index);
	const path = join(ownership.directory, `candidate-${index}`);
	if (!isCanonicalPathInside(ownership.directory, path)) {
		throw new Error(`candidate ${index} path escapes compete group ${ownership.group}`);
	}
	let fallback: RunGateWorktreeProvenance["fallback"] = "mux-unavailable";
	if (mux?.available()) {
		const created = await mux
			.worktreeCreate({
				cwd: ownership.root,
				branch,
				base: baseline,
				path,
				label: `clio-coder compete ${ownership.group} candidate ${index}`,
				focus: false,
			})
			.catch(() => null);
		if (created !== null) {
			if (resolve(created.worktree.path) !== resolve(path) || created.worktree.branch !== branch) {
				throw new Error(`herdr created candidate ${index} at an unexpected path or branch`);
			}
			return {
				index,
				branch,
				path,
				provenance: { backend: "herdr", path, branch, workspaceId: created.workspaceId },
			};
		}
		fallback = "mux-operation-failed";
	}
	const native = createCandidateWorktree(ownership, index, baseline);
	return { ...native, provenance: { backend: "native", path, branch, fallback } };
}

/**
 * Seal a candidate's work as one commit on its branch. Returns false when the
 * builder changed nothing (an empty candidate is a legitimate ranking fact).
 */
export function commitCandidateWork(worktree: CandidateWorktree, message: string): boolean {
	return commitWorktreePath(worktree.path, COMPETE_COMMIT_IDENTITY, message);
}

/** One-line stat summary of what a candidate branch changed relative to HEAD. */
export function candidateDiffStat(root: string, branch: string): string {
	return worktreeBranchDiffStat(root, branch);
}

/**
 * Return protected parent-checkout paths changed by a candidate branch. The
 * diff disables rename detection so both sides of a rename are considered;
 * path ownership is decided by canonical path segments, never text prefixes.
 */
export function protectedPathsChangedByCompeteBranch(
	root: string,
	branch: string,
	protectedPaths: ReadonlyArray<string>,
): string[] {
	return protectedPathsChangedByWorktreeBranch(root, branch, protectedPaths);
}

function registeredWorktreePaths(root: string): string[] {
	const listing = git(root, ["worktree", "list", "--porcelain", "-z"]);
	return listing
		.split("\0")
		.filter((entry) => entry.startsWith("worktree "))
		.map((entry) => entry.slice("worktree ".length))
		.filter((path): path is string => path !== undefined && path.length > 0);
}

function exactGroupBranches(root: string, group: string): string[] {
	return git(root, ["branch", "--list", "--format=%(refname:short)"])
		.split("\n")
		.filter((branch) => {
			const parts = branch.split("/");
			return (
				parts.length === 4 &&
				(parts[0] === "clio-coder" || parts[0] === "clio") &&
				parts[1] === "compete" &&
				parts[2] === group &&
				/^\d+$/.test(parts[3] ?? "")
			);
		});
}

/** Resolve a current candidate branch while retaining indefinite read support for released refs. */
export function competeBranchForCandidate(root: string, group: string, index: number): string {
	const branches = exactGroupBranches(root, group);
	return (
		branches.find((branch) => branch === competeBranch(group, index)) ??
		branches.find((branch) => branch === competeBranch(group, index, true)) ??
		competeBranch(group, index)
	);
}

function removeRegisteredWorktree(root: string, path: string): void {
	try {
		git(root, ["worktree", "remove", "--force", path]);
	} catch {
		if (existsSync(path)) rmSync(path, { recursive: true, force: true });
		git(root, ["worktree", "prune"]);
	}
}

function removeCandidateWorktree(
	ownership: CompeteGroupOwnership,
	worktree: CandidateWorktree,
	deleteBranch: boolean,
): void {
	assertOwnership(ownership);
	const expectedPath = join(ownership.directory, `candidate-${worktree.index}`);
	if (
		resolve(worktree.path) !== resolve(expectedPath) ||
		!competeBranchMatches(worktree.branch, ownership.group, worktree.index) ||
		!isCanonicalPathInside(ownership.directory, worktree.path)
	) {
		throw new Error(`candidate ${worktree.index} does not belong to compete group ${ownership.group}`);
	}
	removeRegisteredWorktree(ownership.root, worktree.path);
	if (deleteBranch && exactGroupBranches(ownership.root, ownership.group).includes(worktree.branch)) {
		git(ownership.root, ["branch", "-D", worktree.branch]);
	}
	const stillRegistered = registeredWorktreePaths(ownership.root).some(
		(path) => resolve(path) === resolve(worktree.path),
	);
	const branchRemains = deleteBranch && exactGroupBranches(ownership.root, ownership.group).includes(worktree.branch);
	if (stillRegistered || existsSync(worktree.path) || branchRemains) {
		throw new Error(`failed to remove candidate ${worktree.index} from compete group ${ownership.group}`);
	}
}

/** Remove through herdr when it owns the workspace, then verify with Git. */
export async function removeCandidateWorktreeMapped(
	ownership: CompeteGroupOwnership,
	worktree: CandidateWorktree,
	deleteBranch: boolean,
	mux?: CompeteMuxWorktrees,
): Promise<void> {
	const workspaceId = worktree.provenance?.backend === "herdr" ? worktree.provenance.workspaceId : undefined;
	if (workspaceId && mux?.available()) {
		await mux.worktreeRemove(workspaceId, { force: true }).catch(() => false);
	}
	// This is both the native fallback after mux loss and the postcondition check
	// after a successful RPC. It prunes an already-removed path harmlessly and
	// removes the candidate branch, which worktree.remove does not promise to do.
	removeCandidateWorktree(ownership, worktree, deleteBranch);
}

/**
 * Merge the winning candidate branch into the current branch. Fast-forward
 * is impossible by construction (the candidate branched from HEAD and HEAD
 * may have moved), so a regular merge commit is created; a conflict aborts
 * the merge and reports failure so the operator decides.
 */
export function mergeWinnerBranch(root: string, branch: string): { ok: true } | { ok: false; reason: string } {
	return mergeWorktreeBranch(root, branch, COMPETE_COMMIT_IDENTITY);
}

/**
 * Remove exactly one proven compete group. Registered worktrees are selected
 * by canonical segment containment and branches by parsed path segments;
 * neither operation uses a textual prefix or wildcard containing the group.
 * The owner manifest is removed last so an interrupted cleanup remains
 * recoverable.
 */
function cleanupWorktreeGroup(ownership: CompeteGroupOwnership): void {
	assertOwnership(ownership);
	for (const path of registeredWorktreePaths(ownership.root)) {
		if (!isCanonicalPathInside(ownership.directory, path)) continue;
		removeRegisteredWorktree(ownership.root, path);
	}
	git(ownership.root, ["worktree", "prune"]);

	const registeredRemain = registeredWorktreePaths(ownership.root).filter((path) =>
		isCanonicalPathInside(ownership.directory, path),
	);
	if (registeredRemain.length > 0) {
		throw new Error(
			`failed to remove ${registeredRemain.length} registered worktree(s) for compete group ${ownership.group}`,
		);
	}

	for (const branch of exactGroupBranches(ownership.root, ownership.group)) {
		git(ownership.root, ["branch", "-D", branch]);
	}
	const branchesRemain = exactGroupBranches(ownership.root, ownership.group);
	if (branchesRemain.length > 0) {
		throw new Error(`failed to remove ${branchesRemain.length} branch(es) for compete group ${ownership.group}`);
	}

	// Re-verify the manifest immediately before deleting the exact directory.
	// Remove every other owned entry first, then unlink the manifest last. A
	// crash during recursive content removal therefore leaves recovery proof.
	assertOwnership(ownership);
	for (const entry of readdirSync(ownership.directory)) {
		if (entry === COMPETE_MANIFEST_FILE) continue;
		rmSync(join(ownership.directory, entry), { recursive: true, force: true });
	}
	assertOwnership(ownership);
	const unexpected = readdirSync(ownership.directory).filter((entry) => entry !== COMPETE_MANIFEST_FILE);
	if (unexpected.length > 0) {
		throw new Error(`compete group ${ownership.group} changed during cleanup; ownership is preserved`);
	}
	unlinkSync(manifestPath(ownership.directory));
	rmdirSync(ownership.directory);
	// Never recursively delete the shared parent: another process may claim a
	// new group between an emptiness check and removal.
	try {
		rmdirSync(competeParent(ownership.root));
	} catch {
		// Non-empty (another group) or already absent.
	}
}

export function cleanupCompeteGroup(ownership: CompeteGroupOwnership): void {
	cleanupWorktreeGroup(ownership);
}

/**
 * Finish an abandoned compete transaction after its pending judge output has
 * been authenticated and parsed. A recovered winner is preserved for an
 * operator rather than auto-merged: restart recovery restores evidence and a
 * safe decision point, but never invents authority for a Git mutation.
 */
export function settleRecoveredCompeteDecision(
	root: string,
	group: string,
	winnerIndex: number | null,
): CompeteGroupOwnership | null {
	let ownership = loadCompeteGroup(root, group);
	if (ownership === null) return null;
	if (ownership.state === "cleanup-ready") {
		cleanupWorktreeGroup(ownership);
		return null;
	}
	if (ownership.state === "winner-preserved") {
		if (winnerIndex !== null && ownership.winnerIndex === winnerIndex) return ownership;
		throw new Error(`compete group ${group} was already preserved with a different winner`);
	}
	const manifest = assertOwnership(ownership);
	if (ownerIsAlive(manifest.owner)) {
		throw new Error(`compete group ${group} still has a live coordinator; refusing restart settlement`);
	}
	const unterminated = manifest.runs.filter((run) => !terminateRunLease(run));
	if (unterminated.length > 0) {
		throw new Error(`could not safely terminate ${unterminated.length} leased compete worker(s) for ${group}`);
	}

	if (winnerIndex === null) {
		ownership = markCompeteGroupCleanupReady(ownership);
		cleanupWorktreeGroup(ownership);
		return null;
	}
	const branches = exactGroupBranches(ownership.root, group);
	const winnerBranch = competeBranchForCandidate(ownership.root, group, winnerIndex);
	const winnerPath = join(ownership.directory, `candidate-${winnerIndex}`);
	if (
		!branches.includes(winnerBranch) ||
		!registeredWorktreePaths(ownership.root).some((path) => resolve(path) === resolve(winnerPath))
	) {
		throw new Error(`recovered winner ${winnerBranch} has no intact candidate worktree`);
	}
	ownership = markCompeteGroupWinnerPreserved(ownership, winnerIndex);
	for (const branch of branches) {
		const index = Number.parseInt(branch.split("/").at(-1) ?? "", 10);
		if (index === winnerIndex) continue;
		removeCandidateWorktree(ownership, { index, branch, path: join(ownership.directory, `candidate-${index}`) }, true);
	}
	return ownership;
}

/**
 * Recover restart leftovers without guessing ownership.
 *
 * - cleanup-ready groups are already proven quiescent and are swept;
 * - active groups whose coordinator lease is dead first terminate every
 *   exact, PID-reuse-checked worker lease, then transition and sweep;
 * - live/remote owners, preserved winners, and malformed entries remain
 *   untouched.
 *
 * This function is safe at orchestrator startup and before every compete
 * operation. A failed termination keeps the ownership proof and worktrees.
 */
export function recoverCleanupReadyCompeteGroups(
	root: string,
	options: CompeteRecoveryOptions = {},
): CompeteRecoveryResult {
	const canonical = canonicalRoot(root);
	const parent = competeParent(canonical);
	const result: CompeteRecoveryResult = { cleaned: [], preserved: [], failed: [] };
	if (!isPlainDirectory(parent)) return result;
	for (const entry of readdirSync(parent, { withFileTypes: true })) {
		if (!entry.isDirectory() || entry.isSymbolicLink()) {
			result.preserved.push(entry.name);
			continue;
		}
		let ownership: CompeteGroupOwnership | null = null;
		let manifest: CompeteGroupManifest | null = null;
		try {
			manifest = readManifest(canonical, entry.name);
			ownership = manifest === null ? null : ownershipFromManifest(manifest);
		} catch {
			// Invalid directory names and malformed claims are unproven.
		}
		if (ownership === null || manifest === null) {
			result.preserved.push(entry.name);
			continue;
		}
		if (ownership.state === "winner-preserved") {
			result.preserved.push(entry.name);
			continue;
		}
		if (ownership.state === "active") {
			if (ownerIsAlive(manifest.owner)) {
				result.preserved.push(entry.name);
				continue;
			}
			const unterminated = manifest.runs.filter((run) => !terminateRunLease(run));
			if (unterminated.length > 0) {
				result.failed.push({
					group: entry.name,
					message: `could not safely terminate ${unterminated.length} leased compete worker(s)`,
				});
				continue;
			}
			if (options.preserveAllActive === true || options.preserveActiveGroups?.has(entry.name) === true) {
				result.preserved.push(entry.name);
				continue;
			}
			try {
				ownership = markCompeteGroupCleanupReady(ownership);
			} catch (err) {
				result.failed.push({ group: entry.name, message: errorMessage(err) });
				continue;
			}
		}
		try {
			cleanupWorktreeGroup(ownership);
			result.cleaned.push(entry.name);
		} catch (err) {
			result.failed.push({ group: entry.name, message: errorMessage(err) });
		}
	}
	return result;
}
