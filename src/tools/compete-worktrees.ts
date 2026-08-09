/**
 * Scratch git worktrees for the compete dispatch topology.
 *
 * Each candidate builds in its own worktree on its own branch
 * (`clio/compete/<group>/<n>`), created from the repository HEAD under
 * `<root>/.clio/worktrees/<group>/candidate-<n>`. The path sits inside the
 * project root because remote fleet nodes share the filesystem and doctor
 * preflight verifies path parity only for the project root; `.clio/` is
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
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { RunKind } from "../domains/dispatch/types.js";

export interface CandidateWorktree {
	index: number;
	branch: string;
	path: string;
}

export type CompeteGroupState = "active" | "cleanup-ready" | "winner-preserved";

/** Proof that this exact directory was claimed as one compete transaction. */
export interface CompeteGroupOwnership {
	namespace: WorktreeNamespace;
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

/**
 * The namespace one worktree transaction lives in. Compete candidates and
 * dispatch attempt isolation are the same transaction shape over different
 * directories and branch prefixes, so claiming, leasing, restart recovery, and
 * cleanup are written once here and bound per namespace rather than copied.
 */
export interface WorktreeNamespace {
	/** Branch segment: `clio/<segment>/<group>/<n>`. */
	branchSegment: string;
	/** Directory under the project root holding every group in this namespace. */
	parentSegments: ReadonlyArray<string>;
	/** Durable claim filename inside a group directory. */
	manifestFile: string;
	/** Discriminant sealed in the manifest so one namespace cannot claim another's. */
	manifestKind: string;
	/** Git author identity for commits this namespace creates. */
	commitIdentity: string;
	/** Human label used in ownership and cleanup errors. */
	label: string;
}

export const COMPETE_NAMESPACE: WorktreeNamespace = {
	branchSegment: "compete",
	parentSegments: [".clio", "worktrees"],
	manifestFile: ".clio-compete-owner.json",
	manifestKind: "clio-compete-group",
	commitIdentity: "clio-compete",
	label: "compete group",
};

export const ATTEMPT_NAMESPACE: WorktreeNamespace = {
	branchSegment: "attempt",
	parentSegments: [".clio", "attempts"],
	manifestFile: ".clio-attempt-owner.json",
	manifestKind: "clio-workspace-transaction",
	commitIdentity: "clio-attempt",
	label: "workspace transaction",
};

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

function namespaceParent(namespace: WorktreeNamespace, root: string): string {
	return join(root, ...namespace.parentSegments);
}

function groupDirectory(namespace: WorktreeNamespace, root: string, group: string): string {
	validateGroup(group);
	return join(namespaceParent(namespace, root), group);
}

function manifestPath(namespace: WorktreeNamespace, directory: string): string {
	return join(directory, namespace.manifestFile);
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
export function isCanonicalPathInside(parent: string, candidate: string): boolean {
	let canonicalParent: string;
	let canonicalCandidate: string;
	try {
		canonicalParent = realpathSync(parent);
	} catch {
		canonicalParent = resolve(parent);
	}
	try {
		canonicalCandidate = realpathSync(candidate);
	} catch {
		canonicalCandidate = resolve(candidate);
	}
	const rel = relative(canonicalParent, canonicalCandidate);
	return rel.length > 0 && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function manifestFromUnknown(namespace: WorktreeNamespace, value: unknown): CompeteGroupManifest | null {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
	const manifest = value as Record<string, unknown>;
	if (
		manifest.version !== 2 ||
		manifest.kind !== namespace.manifestKind ||
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

function readManifest(namespace: WorktreeNamespace, root: string, group: string): CompeteGroupManifest | null {
	const canonical = canonicalRoot(root);
	const directory = groupDirectory(namespace, canonical, group);
	if (!isCanonicalDirectoryAt(directory)) return null;
	try {
		const parsed = JSON.parse(readFileSync(manifestPath(namespace, directory), "utf8")) as unknown;
		const manifest = manifestFromUnknown(namespace, parsed);
		if (manifest === null || manifest.root !== canonical || manifest.group !== group) return null;
		return manifest;
	} catch {
		return null;
	}
}

function ownershipFromManifest(namespace: WorktreeNamespace, manifest: CompeteGroupManifest): CompeteGroupOwnership {
	return {
		namespace,
		root: manifest.root,
		group: manifest.group,
		directory: groupDirectory(namespace, manifest.root, manifest.group),
		token: manifest.token,
		state: manifest.state,
		...(manifest.winnerIndex !== undefined ? { winnerIndex: manifest.winnerIndex } : {}),
	};
}

function assertOwnership(ownership: CompeteGroupOwnership): CompeteGroupManifest {
	const namespace = ownership.namespace;
	const manifest = readManifest(namespace, ownership.root, ownership.group);
	if (manifest === null || manifest.token !== ownership.token) {
		throw new Error(`${namespace.label} ${ownership.group} has no matching ownership manifest; refusing cleanup`);
	}
	if (resolve(ownership.directory) !== resolve(groupDirectory(namespace, manifest.root, manifest.group))) {
		throw new Error(`${namespace.label} ${ownership.group} ownership path changed; refusing cleanup`);
	}
	return manifest;
}

function replaceManifest(ownership: CompeteGroupOwnership, manifest: CompeteGroupManifest): void {
	assertOwnership(ownership);
	const destination = manifestPath(ownership.namespace, ownership.directory);
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

function worktreeBranch(namespace: WorktreeNamespace, group: string, index: number): string {
	validateGroup(group);
	if (!Number.isInteger(index) || index < 1) throw new Error(`invalid ${namespace.label} index ${index}`);
	return `clio/${namespace.branchSegment}/${group}/${index}`;
}

function competeBranch(group: string, index: number): string {
	return worktreeBranch(COMPETE_NAMESPACE, group, index);
}

/** Claim the group before creating a branch or candidate worktree. */
export function claimWorktreeGroup(namespace: WorktreeNamespace, root: string, group: string): CompeteGroupOwnership {
	const canonical = canonicalRoot(root);
	const directory = groupDirectory(namespace, canonical, group);
	const parent = namespaceParent(namespace, canonical);
	mkdirSync(parent, { recursive: true });
	if (!isCanonicalDirectoryAt(parent)) {
		throw new Error(`${namespace.label} parent ${parent} is not a canonical local directory`);
	}
	mkdirSync(directory);
	if (!isCanonicalDirectoryAt(directory)) {
		throw new Error(`${namespace.label} directory ${directory} is not canonical`);
	}
	const now = new Date().toISOString();
	const manifest: CompeteGroupManifest = {
		version: 2,
		kind: namespace.manifestKind,
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
		writeFileSync(manifestPath(namespace, directory), `${JSON.stringify(manifest, null, 2)}\n`, {
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
	return ownershipFromManifest(namespace, manifest);
}

export function claimCompeteGroup(root: string, group: string): CompeteGroupOwnership {
	return claimWorktreeGroup(COMPETE_NAMESPACE, root, group);
}

/** Load an exact durable claim, or null when ownership cannot be proven. */
function loadWorktreeGroup(namespace: WorktreeNamespace, root: string, group: string): CompeteGroupOwnership | null {
	validateGroup(group);
	const manifest = readManifest(namespace, root, group);
	return manifest === null ? null : ownershipFromManifest(namespace, manifest);
}

export function loadCompeteGroup(root: string, group: string): CompeteGroupOwnership | null {
	return loadWorktreeGroup(COMPETE_NAMESPACE, root, group);
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
		throw new Error(
			`${ownership.namespace.label} ${ownership.group} is ${current.state}; refusing new run ${admission.runId}`,
		);
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
	return ownershipFromManifest(ownership.namespace, next);
}

export function markCompeteGroupWinnerPreserved(
	ownership: CompeteGroupOwnership,
	winnerIndex: number,
): CompeteGroupOwnership {
	worktreeBranch(ownership.namespace, ownership.group, winnerIndex);
	const current = assertOwnership(ownership);
	const next: CompeteGroupManifest = {
		...current,
		state: "winner-preserved",
		winnerIndex,
		updatedAt: new Date().toISOString(),
	};
	replaceManifest(ownership, next);
	return ownershipFromManifest(ownership.namespace, next);
}

/**
 * Create one worktree for `index` from an explicit baseline commit. The
 * baseline is a parameter rather than HEAD so every attempt in a transaction
 * starts from the same approved state: a fallback that branched from a later
 * HEAD would silently inherit whatever a failed predecessor left behind.
 */
export function createCandidateWorktree(
	ownership: CompeteGroupOwnership,
	index: number,
	baseline: string,
): CandidateWorktree {
	assertOwnership(ownership);
	const branch = worktreeBranch(ownership.namespace, ownership.group, index);
	const path = join(ownership.directory, `candidate-${index}`);
	if (!isCanonicalPathInside(ownership.directory, path)) {
		throw new Error(`candidate ${index} path escapes ${ownership.namespace.label} ${ownership.group}`);
	}
	git(ownership.root, ["worktree", "add", "-b", branch, path, baseline]);
	return { index, branch, path };
}

/**
 * Seal a candidate's work as one commit on its branch. Returns false when the
 * builder changed nothing (an empty candidate is a legitimate ranking fact).
 */
export function commitCandidateWork(
	worktree: CandidateWorktree,
	message: string,
	identity = COMPETE_NAMESPACE.commitIdentity,
): boolean {
	git(worktree.path, ["add", "-A"]);
	const staged = git(worktree.path, ["status", "--porcelain"]);
	if (staged.length === 0) return false;
	git(worktree.path, [
		"-c",
		`user.name=${identity}`,
		"-c",
		`user.email=${identity}@local`,
		"commit",
		"-m",
		message,
		"--no-verify",
	]);
	return true;
}

/** One-line stat summary of what a candidate branch changed relative to HEAD. */
export function candidateDiffStat(root: string, branch: string): string {
	try {
		return git(root, ["diff", "--shortstat", `HEAD...${branch}`]) || "no changes";
	} catch {
		return "diff unavailable";
	}
}

/**
 * Return protected parent-checkout paths changed by a candidate branch. The
 * diff disables rename detection so both sides of a rename are considered;
 * path ownership is decided by canonical path segments, never text prefixes.
 */
export function protectedPathsChangedByBranch(
	root: string,
	branch: string,
	protectedPaths: ReadonlyArray<string>,
	base = "HEAD",
): string[] {
	const canonical = canonicalRoot(root);
	const protectedInside = protectedPaths
		.map((path) => resolve(path))
		.filter((path) => {
			const rel = relative(canonical, path);
			return rel.length > 0 && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
		});
	if (protectedInside.length === 0) return [];
	const changed = git(canonical, ["diff", "--name-only", "-z", "--no-renames", `${base}...${branch}`])
		.split("\0")
		.filter((path) => path.length > 0)
		.map((path) => resolve(canonical, path));
	const blocked = new Set<string>();
	for (const candidate of changed) {
		for (const protectedPath of protectedInside) {
			const rel = relative(protectedPath, candidate);
			if (
				candidate === protectedPath ||
				(rel.length > 0 && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
			) {
				blocked.add(protectedPath);
			}
		}
	}
	return [...blocked].sort();
}

export function protectedPathsChangedByCompeteBranch(
	root: string,
	branch: string,
	protectedPaths: ReadonlyArray<string>,
): string[] {
	return protectedPathsChangedByBranch(root, branch, protectedPaths);
}

function registeredWorktreePaths(root: string): string[] {
	const listing = git(root, ["worktree", "list", "--porcelain", "-z"]);
	return listing
		.split("\0")
		.filter((entry) => entry.startsWith("worktree "))
		.map((entry) => entry.slice("worktree ".length))
		.filter((path): path is string => path !== undefined && path.length > 0);
}

function exactGroupBranches(namespace: WorktreeNamespace, root: string, group: string): string[] {
	return git(root, ["branch", "--list", "--format=%(refname:short)"])
		.split("\n")
		.filter((branch) => {
			const parts = branch.split("/");
			return (
				parts.length === 4 &&
				parts[0] === "clio" &&
				parts[1] === namespace.branchSegment &&
				parts[2] === group &&
				/^\d+$/.test(parts[3] ?? "")
			);
		});
}

function removeRegisteredWorktree(root: string, path: string): void {
	try {
		git(root, ["worktree", "remove", "--force", path]);
	} catch {
		if (existsSync(path)) rmSync(path, { recursive: true, force: true });
		git(root, ["worktree", "prune"]);
	}
}

export function removeCandidateWorktree(
	ownership: CompeteGroupOwnership,
	worktree: CandidateWorktree,
	deleteBranch: boolean,
): void {
	assertOwnership(ownership);
	const expectedPath = join(ownership.directory, `candidate-${worktree.index}`);
	const expectedBranch = worktreeBranch(ownership.namespace, ownership.group, worktree.index);
	if (
		resolve(worktree.path) !== resolve(expectedPath) ||
		worktree.branch !== expectedBranch ||
		!isCanonicalPathInside(ownership.directory, worktree.path)
	) {
		throw new Error(`candidate ${worktree.index} does not belong to ${ownership.namespace.label} ${ownership.group}`);
	}
	removeRegisteredWorktree(ownership.root, worktree.path);
	if (
		deleteBranch &&
		exactGroupBranches(ownership.namespace, ownership.root, ownership.group).includes(worktree.branch)
	) {
		git(ownership.root, ["branch", "-D", worktree.branch]);
	}
	const stillRegistered = registeredWorktreePaths(ownership.root).some(
		(path) => resolve(path) === resolve(worktree.path),
	);
	const branchRemains =
		deleteBranch && exactGroupBranches(ownership.namespace, ownership.root, ownership.group).includes(worktree.branch);
	if (stillRegistered || existsSync(worktree.path) || branchRemains) {
		throw new Error(`failed to remove candidate ${worktree.index} from ${ownership.namespace.label} ${ownership.group}`);
	}
}

/**
 * Merge the winning candidate branch into the current branch. Fast-forward
 * is impossible by construction (the candidate branched from HEAD and HEAD
 * may have moved), so a regular merge commit is created; a conflict aborts
 * the merge and reports failure so the operator decides.
 */
export function mergeWinnerBranch(
	root: string,
	branch: string,
	identity = COMPETE_NAMESPACE.commitIdentity,
): { ok: true } | { ok: false; reason: string } {
	try {
		git(root, [
			"-c",
			`user.name=${identity}`,
			"-c",
			`user.email=${identity}@local`,
			"merge",
			"--no-edit",
			"--no-verify",
			branch,
		]);
		return { ok: true };
	} catch (err) {
		try {
			git(root, ["merge", "--abort"]);
		} catch {
			// No merge in progress; nothing to abort.
		}
		return { ok: false, reason: err instanceof Error ? (err.message.split("\n")[0] ?? "merge failed") : String(err) };
	}
}

/**
 * Remove exactly one proven compete group. Registered worktrees are selected
 * by canonical segment containment and branches by parsed path segments;
 * neither operation uses a textual prefix or wildcard containing the group.
 * The owner manifest is removed last so an interrupted cleanup remains
 * recoverable.
 */
export function cleanupWorktreeGroup(ownership: CompeteGroupOwnership): void {
	const namespace = ownership.namespace;
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
			`failed to remove ${registeredRemain.length} registered worktree(s) for ${namespace.label} ${ownership.group}`,
		);
	}

	for (const branch of exactGroupBranches(namespace, ownership.root, ownership.group)) {
		git(ownership.root, ["branch", "-D", branch]);
	}
	const branchesRemain = exactGroupBranches(namespace, ownership.root, ownership.group);
	if (branchesRemain.length > 0) {
		throw new Error(`failed to remove ${branchesRemain.length} branch(es) for ${namespace.label} ${ownership.group}`);
	}

	// Re-verify the manifest immediately before deleting the exact directory.
	// Remove every other owned entry first, then unlink the manifest last. A
	// crash during recursive content removal therefore leaves recovery proof.
	assertOwnership(ownership);
	for (const entry of readdirSync(ownership.directory)) {
		if (entry === namespace.manifestFile) continue;
		rmSync(join(ownership.directory, entry), { recursive: true, force: true });
	}
	assertOwnership(ownership);
	const unexpected = readdirSync(ownership.directory).filter((entry) => entry !== namespace.manifestFile);
	if (unexpected.length > 0) {
		throw new Error(`${namespace.label} ${ownership.group} changed during cleanup; ownership is preserved`);
	}
	unlinkSync(manifestPath(namespace, ownership.directory));
	rmdirSync(ownership.directory);
	// Never recursively delete the shared parent: another process may claim a
	// new group between an emptiness check and removal.
	try {
		rmdirSync(namespaceParent(namespace, ownership.root));
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
	let ownership = loadWorktreeGroup(COMPETE_NAMESPACE, root, group);
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
	const winnerBranch = competeBranch(group, winnerIndex);
	const branches = exactGroupBranches(COMPETE_NAMESPACE, ownership.root, group);
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
function recoverCleanupReadyWorktreeGroups(
	namespace: WorktreeNamespace,
	root: string,
	options: CompeteRecoveryOptions = {},
): CompeteRecoveryResult {
	const canonical = canonicalRoot(root);
	const parent = namespaceParent(namespace, canonical);
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
			manifest = readManifest(namespace, canonical, entry.name);
			ownership = manifest === null ? null : ownershipFromManifest(namespace, manifest);
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

export function recoverCleanupReadyCompeteGroups(
	root: string,
	options: CompeteRecoveryOptions = {},
): CompeteRecoveryResult {
	return recoverCleanupReadyWorktreeGroups(COMPETE_NAMESPACE, root, options);
}
