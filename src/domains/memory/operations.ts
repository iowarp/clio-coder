import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { canonicalizeExistingPath } from "../../core/path-canonical.js";
import { canonicalProjectRoot, checkoutHead, repositoryRoot } from "../../core/project-root.js";
import {
	type MemoryMutationOptions,
	memoryRoot,
	mutateMemoryRecords,
	pruneStaleMemoryRecords,
	sortMemoryRecords,
	updateMemoryRecord,
} from "./store.js";
import type {
	MemoryAgentIdentity,
	MemoryClaim,
	MemoryClaimCommand,
	MemoryRecord,
	MemoryRepositoryIdentity,
	MemoryRetrievalOptions,
	MemoryRuntimeIdentity,
} from "./types.js";
import { validSourceValue } from "./validate.js";

export async function approveMemoryRecord(
	dataDir: string,
	memoryId: string,
	now: Date = new Date(),
): Promise<MemoryRecord> {
	let cleared: string[] = [];
	const approved = await updateMemoryRecord(dataDir, memoryId, (record) => {
		cleared = [...(record.regressions ?? [])];
		return approveRecord(record, now);
	});
	if (cleared.length > 0)
		appendClearedRegressions(dataDir, { id: approved.id, at: now.toISOString(), regressions: cleared });
	return approved;
}

/**
 * The regressions an operator re-approval cleared from one record. Approval removes `regressions` from the record so
 * it can stand in the prompt again; this line keeps what was overturned and when it was cleared, so a re-approved
 * record still shows it was once contradicted. Kept beside the store, not in it, so the record schema is unchanged.
 */
export interface ClearedMemoryRegressions {
	id: string;
	at: string;
	by: "operator";
	regressions: string[];
}

function memoryRegressionsClearedPath(dataDir: string): string {
	return join(memoryRoot(dataDir), "regressions-cleared.jsonl");
}

function appendClearedRegressions(dataDir: string, entry: Omit<ClearedMemoryRegressions, "by">): void {
	const path = memoryRegressionsClearedPath(dataDir);
	mkdirSync(dirname(path), { recursive: true });
	// One small line with O_APPEND, written after the approval landed, so it never names a clearing that did not happen.
	appendFileSync(
		path,
		`${JSON.stringify({ id: entry.id, at: entry.at, by: "operator", regressions: entry.regressions })}\n`,
		{
			mode: 0o600,
		},
	);
}

/** Every recorded clearing, oldest first, optionally for one record. A torn or foreign line is skipped. */
export function readClearedMemoryRegressions(dataDir: string, memoryId?: string): ClearedMemoryRegressions[] {
	let text: string;
	try {
		text = readFileSync(memoryRegressionsClearedPath(dataDir), "utf8");
	} catch {
		return [];
	}
	const entries: ClearedMemoryRegressions[] = [];
	for (const line of text.split("\n")) {
		if (line.trim().length === 0) continue;
		let value: unknown;
		try {
			value = JSON.parse(line);
		} catch {
			continue;
		}
		if (typeof value !== "object" || value === null) continue;
		const { id, at, regressions } = value as Record<string, unknown>;
		if (typeof id !== "string" || typeof at !== "string" || !Array.isArray(regressions)) continue;
		if (memoryId !== undefined && id !== memoryId) continue;
		const notes = regressions.filter((item): item is string => typeof item === "string");
		entries.push({ id, at, by: "operator", regressions: notes });
	}
	return entries;
}

export async function rejectMemoryRecord(
	dataDir: string,
	memoryId: string,
	now: Date = new Date(),
): Promise<MemoryRecord> {
	return updateMemoryRecord(dataDir, memoryId, (record) => rejectRecord(record, now));
}

/** Reject several records under one store lock, skipping any already rejected. Returns the ids this call rejected. */
export async function rejectMemoryRecords(
	dataDir: string,
	memoryIds: ReadonlySet<string>,
	now: Date = new Date(),
	options: MemoryMutationOptions = {},
): Promise<string[]> {
	return mutateMemoryRecords(
		dataDir,
		(records) => {
			const rejected: string[] = [];
			const next = records.map((record) => {
				if (!memoryIds.has(record.id) || record.rejectedAt !== undefined) return record;
				rejected.push(record.id);
				return rejectRecord(record, now);
			});
			return rejected.length > 0 ? { records: next, result: rejected } : { result: rejected };
		},
		options,
	);
}

export async function pruneStaleMemory(dataDir: string, now: Date = new Date()): Promise<MemoryRecord[]> {
	return pruneStaleMemoryRecords(dataDir, now);
}

/**
 * Whether a record may stand in a prompt at all: operator-approved, evidence-linked and not contradicted. Fresh
 * selection and the withdrawal of a record an already compiled prompt carries both read this one predicate.
 */
export function memoryRecordEligible(record: MemoryRecord): boolean {
	return (
		record.approved &&
		record.evidenceRefs.length > 0 &&
		(record.regressions === undefined || record.regressions.length === 0)
	);
}

/** Eligibility precedes ranking or budget truncation; output retains legacy priority. */
export function eligibleMemoryRecords(
	records: ReadonlyArray<MemoryRecord>,
	options: Omit<MemoryRetrievalOptions, "tokenBudget">,
): MemoryRecord[] {
	const allowedScopes = options.scopes === undefined ? null : new Set(options.scopes);
	const activeRepository = canonicalActiveRepository(options.activeRepository);
	const activeRuntime = validActiveNamedIdentity(options.activeRuntime, "runtime");
	const activeAgent = validActiveNamedIdentity(options.activeAgent, "agent");
	return sortMemoryRecords(records)
		.filter(memoryRecordEligible)
		.filter((record) => allowedScopes === null || allowedScopes.has(record.scope))
		.filter((record) => repositoryApplies(record, activeRepository))
		.filter((record) => runtimeApplies(record, activeRuntime))
		.filter((record) => agentApplies(record, activeAgent))
		.sort(compareRetrievalPriority);
}

export function cloneMemoryRecord(record: MemoryRecord): MemoryRecord {
	const next: MemoryRecord = {
		id: record.id,
		scope: record.scope,
		key: record.key,
		lesson: record.lesson,
		evidenceRefs: [...record.evidenceRefs],
		appliesWhen: [...record.appliesWhen],
		avoidWhen: [...record.avoidWhen],
		confidence: record.confidence,
		createdAt: record.createdAt,
		approved: record.approved,
	};
	if (record.lastVerifiedAt !== undefined) next.lastVerifiedAt = record.lastVerifiedAt;
	if (record.regressions !== undefined) next.regressions = [...record.regressions];
	if (record.rejectedAt !== undefined) next.rejectedAt = record.rejectedAt;
	if (record.repository !== undefined) next.repository = { ...record.repository };
	if (record.runtime !== undefined) next.runtime = { ...record.runtime };
	if (record.agent !== undefined) next.agent = { ...record.agent };
	if (record.provenance !== undefined) {
		next.provenance = {
			...record.provenance,
			...(record.provenance.redaction === undefined
				? {}
				: {
						redaction: {
							...record.provenance.redaction,
							sourceFields: [...record.provenance.redaction.sourceFields],
						},
					}),
		};
	}
	if (record.approval !== undefined) next.approval = { ...record.approval };
	if (record.observations !== undefined) next.observations = record.observations.map((item) => ({ ...item }));
	if (record.claim !== undefined) next.claim = cloneClaim(record.claim);
	if (record.revisions !== undefined) next.revisions = record.revisions.map((item) => ({ ...item }));
	if (record.deliveredCount !== undefined) next.deliveredCount = record.deliveredCount;
	if (record.lastDeliveredAt !== undefined) next.lastDeliveredAt = record.lastDeliveredAt;
	return next;
}

function cloneClaim(claim: MemoryClaim): MemoryClaim {
	const command = (item: MemoryClaimCommand): MemoryClaimCommand => ({
		...item,
		assignments: [...item.assignments],
		argv: [...item.argv],
	});
	switch (claim.kind) {
		case "command":
			return { kind: "command", command: command(claim.command) };
		case "fix":
			return { kind: "fix", failed: command(claim.failed), fixed: command(claim.fixed) };
		case "source":
			return { ...claim };
	}
}

/**
 * Where a verdict was observed: the branch the checkout holding `cwd` has checked out and its head commit, read
 * from Git's files with no subprocess. Either is absent when it cannot be read (no repository, a detached head has
 * no branch, an unborn branch has no head).
 */
export function checkoutPosition(cwd: string): { branch?: string; head?: string } {
	// The enclosing checkout, as the handbook walk finds it: a home directory that is a repository owns only itself.
	const root = repositoryRoot(resolve(cwd));
	if (root === null) return {};
	const head = checkoutHead(root);
	let branch: string | undefined;
	try {
		const dotGit = join(root, ".git");
		const pointer = lstatSync(dotGit).isFile()
			? /^gitdir:\s*(.+?)\s*$/mu.exec(readFileSync(dotGit, "utf8"))?.[1]
			: dotGit;
		if (pointer !== undefined) {
			const ref = /^ref:\s*refs\/heads\/(\S+)$/u.exec(readFileSync(join(resolve(root, pointer), "HEAD"), "utf8").trim());
			if (ref?.[1] !== undefined && validSourceValue(ref[1])) branch = ref[1];
		}
	} catch {
		// An unreadable HEAD names no branch.
	}
	return { ...(branch !== undefined ? { branch } : {}), ...(head !== null ? { head } : {}) };
}

/**
 * Build the path identity expected by memory selection. The input must be an
 * absolute active repository root. Existing symlinks are resolved; non-Git
 * directories are valid identities too. Missing/moved paths stay distinct
 * from their former location and therefore fail closed against old records.
 */
export function canonicalMemoryRepositoryIdentity(repositoryPath: string): MemoryRepositoryIdentity | null {
	if (!isUsableAbsoluteRepositoryPath(repositoryPath)) return null;
	const canonical = canonicalizeExistingPath(repositoryPath);
	if (!isUsableAbsoluteRepositoryPath(canonical)) return null;
	// The one project key claims share (#406): the repository root, a linked worktree folded into its main checkout.
	const root = canonicalProjectRoot(canonical);
	const key = isUsableAbsoluteRepositoryPath(root) ? root : canonical;
	const fingerprint = repositoryFingerprints.get(key);
	return fingerprint ? { kind: "canonical-path", key, fingerprint } : { kind: "canonical-path", key };
}

/** Root commits read once per session per repository key; `null` means none could be read. */
const repositoryFingerprints = new Map<string, string | null>();
/**
 * Every root commit any ref of the repository reaches. A record learned on another branch whose history starts
 * elsewhere (an orphan branch, or a history merged in later) still belongs to this repository. Walking every ref can
 * take seconds on a large repository, so it runs at the first record whose fingerprint differs, never at session start.
 */
const repositoryRootCommits = new Map<string, ReadonlySet<string>>();

function reachableRootCommits(key: string): ReadonlySet<string> {
	let roots = repositoryRootCommits.get(key);
	if (roots === undefined) {
		try {
			roots = new Set(rootCommits(key, ["--all"]));
		} catch {
			// A broken ref walk leaves only the HEAD fingerprint matching.
			roots = new Set();
		}
		repositoryRootCommits.set(key, roots);
	}
	return roots;
}

function rootCommits(cwd: string, revisions: ReadonlyArray<string>): string[] {
	const out = execFileSync("git", ["rev-list", "--max-parents=0", ...revisions], {
		cwd,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "ignore"],
		timeout: 5000,
	});
	return out
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => /^[0-9a-f]{40,64}$/u.test(line));
}

/**
 * Read the repository's root commit once, at session start and off the prompt-build path, so identities built
 * afterwards carry it. A new repository at a reused path then has a different fingerprint than the old one's
 * records. Shallow clones, empty repositories and non-repositories get none and keep path-only matching.
 */
export function primeMemoryRepositoryFingerprint(cwd: string): void {
	const identity = canonicalMemoryRepositoryIdentity(cwd);
	if (identity === null || repositoryFingerprints.has(identity.key)) return;
	let fingerprint: string | null = null;
	try {
		if (existsSync(join(identity.key, ".git")) && !existsSync(join(identity.key, ".git", "shallow"))) {
			fingerprint = rootCommits(identity.key, ["HEAD"])[0] ?? null;
		}
	} catch {
		// No git, no commits, or a broken repository: path-only matching.
	}
	repositoryFingerprints.set(identity.key, fingerprint);
}

/** Linked worktrees a repository may have before the guardian stops listing them. */
const RELATED_WORKTREE_LIMIT = 64;

/**
 * The checkout roots that share one canonical repository identity: the main
 * checkout, every linked worktree its `.git/worktrees/<name>/gitdir` records,
 * and the queried directory itself when it sits below one of them. A worktree
 * is listed only when its own `.git` pointer resolves back to the same main
 * root, so a stale record or an unrelated directory never joins the set. Read
 * from Git's own files; no subprocess runs.
 */
export function relatedRepositoryRoots(cwd: string): { repository: MemoryRepositoryIdentity; roots: string[] } | null {
	const repository = canonicalMemoryRepositoryIdentity(cwd);
	if (repository === null) return null;
	const roots = new Set<string>([repository.key]);
	const current = canonicalizeExistingPath(cwd);
	if (isUsableAbsoluteRepositoryPath(current)) roots.add(current);
	let names: string[] = [];
	try {
		names = readdirSync(join(repository.key, ".git", "worktrees")).sort();
	} catch {
		// No linked worktrees, or `.git` is not a directory here: the main root alone.
	}
	for (const name of names) {
		if (roots.size >= RELATED_WORKTREE_LIMIT) break;
		try {
			const gitFile = readFileSync(join(repository.key, ".git", "worktrees", name, "gitdir"), "utf8").trim();
			if (!isAbsolute(gitFile)) continue;
			const root = canonicalizeExistingPath(dirname(gitFile));
			if (canonicalMemoryRepositoryIdentity(root)?.key === repository.key) roots.add(root);
		} catch {
			// A pruned or unreadable worktree record names nothing this repository can vouch for.
		}
	}
	return { repository, roots: [...roots] };
}

function canonicalActiveRepository(
	identity: MemoryRepositoryIdentity | null | undefined,
): MemoryRepositoryIdentity | null {
	if (identity === null || identity === undefined || identity.kind !== "canonical-path") return null;
	const canonical = canonicalMemoryRepositoryIdentity(identity.key);
	if (canonical === null || canonical.key !== identity.key) return null;
	if (canonical.fingerprint === undefined && identity.fingerprint !== undefined)
		canonical.fingerprint = identity.fingerprint;
	return canonical;
}

function repositoryApplies(record: MemoryRecord, activeRepository: MemoryRepositoryIdentity | null): boolean {
	if (record.scope !== "repo") return true;
	if (activeRepository === null) return false;

	// The structured field is the only applicability mechanism: a repo-scoped
	// record without it never enters any repository prompt.
	if (record.repository === undefined) return false;
	if (record.repository.kind !== activeRepository.kind) return false;
	const key = record.repository.key;
	// Another repository's record is refused before the fingerprint check, which may walk every ref of this one.
	if (key !== activeRepository.key && !key.startsWith(`${activeRepository.key}${sep}`)) return false;
	if (
		record.repository.fingerprint !== undefined &&
		activeRepository.fingerprint !== undefined &&
		record.repository.fingerprint !== activeRepository.fingerprint &&
		!reachableRootCommits(activeRepository.key).has(record.repository.fingerprint)
	) {
		return false;
	}
	if (key === activeRepository.key) return true;
	// Records learned in a subdirectory session before identities resolved to the repository root still apply when
	// that directory resolves to this repository now: never below a directory outside Git, never inside a nested one.
	return canonicalMemoryRepositoryIdentity(key)?.key === activeRepository.key;
}

function runtimeApplies(record: MemoryRecord, activeRuntime: MemoryRuntimeIdentity | null): boolean {
	if (record.scope !== "runtime") return true;
	if (activeRuntime === null || record.runtime === undefined) return false;
	return record.runtime.kind === activeRuntime.kind && record.runtime.key === activeRuntime.key;
}

function agentApplies(record: MemoryRecord, activeAgent: MemoryAgentIdentity | null): boolean {
	if (record.scope !== "agent") return true;
	if (activeAgent === null || record.agent === undefined) return false;
	return record.agent.kind === activeAgent.kind && record.agent.key === activeAgent.key;
}

function validActiveNamedIdentity<T extends "runtime" | "agent">(
	identity: { kind: T; key: string } | null | undefined,
	kind: T,
): { kind: T; key: string } | null {
	if (
		identity === null ||
		identity === undefined ||
		identity.kind !== kind ||
		identity.key.length === 0 ||
		identity.key.length > 256 ||
		identity.key.trim() !== identity.key ||
		/[\0\r\n\t ]/u.test(identity.key)
	) {
		return null;
	}
	return { kind, key: identity.key };
}

function isUsableAbsoluteRepositoryPath(value: string): boolean {
	return value.length > 0 && !/[\0\r\n]/u.test(value) && isAbsolute(value);
}

function approveRecord(record: MemoryRecord, now: Date): MemoryRecord {
	const next = cloneMemoryRecord(record);
	next.approved = true;
	next.lastVerifiedAt = now.toISOString();
	next.approval = { by: "operator", at: now.toISOString() };
	// An operator approval overrides the guardian's demotion along with the rejection.
	Reflect.deleteProperty(next, "regressions");
	Reflect.deleteProperty(next, "rejectedAt");
	return next;
}

function rejectRecord(record: MemoryRecord, now: Date): MemoryRecord {
	const next = cloneMemoryRecord(record);
	next.approved = false;
	next.rejectedAt = now.toISOString();
	Reflect.deleteProperty(next, "approval");
	return next;
}

function compareRetrievalPriority(left: MemoryRecord, right: MemoryRecord): number {
	const leftVerified = left.lastVerifiedAt ?? left.createdAt;
	const rightVerified = right.lastVerifiedAt ?? right.createdAt;
	const byVerified = rightVerified.localeCompare(leftVerified);
	if (byVerified !== 0) return byVerified;
	return left.id.localeCompare(right.id);
}
