import { readFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { canonicalizeExistingPath } from "../../core/path-canonical.js";
import { ceilChars } from "../session/context-accounting.js";
import { pruneStaleMemoryRecords, sortMemoryRecords, updateMemoryRecord } from "./store.js";
import type {
	MemoryAgentIdentity,
	MemoryRecord,
	MemoryRepositoryIdentity,
	MemoryRetrievalOptions,
	MemoryRuntimeIdentity,
} from "./types.js";

export async function approveMemoryRecord(
	dataDir: string,
	memoryId: string,
	now: Date = new Date(),
): Promise<MemoryRecord> {
	return updateMemoryRecord(dataDir, memoryId, (record) => approveRecord(record, now));
}

export async function rejectMemoryRecord(
	dataDir: string,
	memoryId: string,
	now: Date = new Date(),
): Promise<MemoryRecord> {
	return updateMemoryRecord(dataDir, memoryId, (record) => rejectRecord(record, now));
}

export async function pruneStaleMemory(dataDir: string, now: Date = new Date()): Promise<MemoryRecord[]> {
	return pruneStaleMemoryRecords(dataDir, now);
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
		.filter((record) => record.approved)
		.filter((record) => record.evidenceRefs.length > 0)
		.filter((record) => record.regressions === undefined || record.regressions.length === 0)
		.filter((record) => allowedScopes === null || allowedScopes.has(record.scope))
		.filter((record) => repositoryApplies(record, activeRepository))
		.filter((record) => runtimeApplies(record, activeRuntime))
		.filter((record) => agentApplies(record, activeAgent))
		.sort(compareRetrievalPriority);
}

export function estimateMemoryTokens(record: MemoryRecord): number {
	const text = [
		record.scope,
		record.key,
		record.lesson,
		...(record.repository === undefined ? [] : [record.repository.kind, record.repository.key]),
		...(record.runtime === undefined ? [] : [record.runtime.kind, record.runtime.key]),
		...(record.agent === undefined ? [] : [record.agent.kind, record.agent.key]),
		...record.evidenceRefs,
		...record.appliesWhen,
		...record.avoidWhen,
		...(record.regressions ?? []),
	].join("\n");
	return Math.max(1, ceilChars(text.length));
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
	return next;
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
	const key = linkedWorktreeMainRoot(canonical) ?? canonical;
	return { kind: "canonical-path", key };
}

/**
 * The main checkout a linked Git worktree belongs to, or null for anything
 * else. Fleet lanes each run in their own worktree, and keying memory on the
 * worktree path meant a lesson learned in a lane applied to no other lane and
 * never to the checkout it merges into. Read from the worktree's own `.git`
 * pointer and `commondir`, so no subprocess runs on the prompt-build path.
 */
function linkedWorktreeMainRoot(root: string): string | null {
	try {
		const pointer = readFileSync(join(root, ".git"), "utf8");
		const gitDir = /^gitdir: (.+)$/mu.exec(pointer)?.[1]?.trim();
		if (!gitDir) return null;
		const absoluteGitDir = resolve(root, gitDir);
		const commonDir = resolve(absoluteGitDir, readFileSync(join(absoluteGitDir, "commondir"), "utf8").trim());
		if (basename(commonDir) !== ".git") return null;
		const mainRoot = canonicalizeExistingPath(dirname(commonDir));
		return isUsableAbsoluteRepositoryPath(mainRoot) && mainRoot !== root ? mainRoot : null;
	} catch {
		// `.git` is a directory (the main checkout), absent (not a repository), or
		// unreadable. Each of those keeps the path identity it always had.
		return null;
	}
}

function canonicalActiveRepository(
	identity: MemoryRepositoryIdentity | null | undefined,
): MemoryRepositoryIdentity | null {
	if (identity === null || identity === undefined || identity.kind !== "canonical-path") return null;
	const canonical = canonicalMemoryRepositoryIdentity(identity.key);
	if (canonical === null || canonical.key !== identity.key) return null;
	return canonical;
}

function repositoryApplies(record: MemoryRecord, activeRepository: MemoryRepositoryIdentity | null): boolean {
	if (record.scope !== "repo") return true;
	if (activeRepository === null) return false;

	// The structured field is the only applicability mechanism: a repo-scoped
	// record without it never enters any repository prompt.
	if (record.repository === undefined) return false;
	return record.repository.kind === activeRepository.kind && record.repository.key === activeRepository.key;
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
