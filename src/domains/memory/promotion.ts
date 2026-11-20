import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { createRedactionTally, redactSecretsPreservingMarkers } from "../evidence/redact.js";
import {
	COMMAND_CLAIM_REF_PREFIX,
	COMMAND_EVIDENCE_REF_PREFIX,
	type CommandSegment,
	commandSegment,
	parseSourceEvidenceRef,
} from "./command-evidence.js";
import { commandRefKeys } from "./lesson-evidence.js";
import { canonicalMemoryRepositoryIdentity, relatedRepositoryRoots } from "./operations.js";
import type { MemoryMutationOptions } from "./store.js";
import { insertMemoryRecordIfAbsent } from "./store.js";
import type { TaskMemoryEntry, TaskMemoryRenderableClass } from "./task-bank.js";
import type {
	MemoryAgentIdentity,
	MemoryClaim,
	MemoryClaimCommand,
	MemoryProposalResult,
	MemoryRecord,
	MemoryRepositoryIdentity,
	MemoryRuntimeIdentity,
} from "./types.js";
import { compareCodeUnits } from "./util.js";
import { assertValidMemoryRecord, validNamedIdentityKey, validSourceValue } from "./validate.js";

export type MemoryScopeSelection =
	| { scope: "repo"; repository: MemoryRepositoryIdentity }
	| { scope: "global"; acknowledgeGlobal: true }
	| { scope: "runtime"; runtime: MemoryRuntimeIdentity }
	| { scope: "agent"; agent: MemoryAgentIdentity };

export interface MemoryPromotionSourceRedaction {
	replacementCount: number;
	sourceFields: ReadonlyArray<string>;
}

export interface MemoryPromotionSource {
	kind: "task-bank-entry" | "handoff-snapshot";
	sessionId: string;
	evidenceRefs: ReadonlyArray<string>;
	entry: TaskMemoryEntry;
	runtimeIds?: ReadonlyArray<string>;
	agentIds?: ReadonlyArray<string>;
	redaction?: MemoryPromotionSourceRedaction;
}

interface ScopeSourceIdentities {
	runtimeIds?: ReadonlyArray<string>;
	agentIds?: ReadonlyArray<string>;
}

/**
 * Validate an operator-selected scope without inferring or widening it.
 * Runtime and agent scopes must name identities carried by the source.
 */
export function validateMemoryScopeSelection(
	selection: MemoryScopeSelection,
	source: ScopeSourceIdentities,
): MemoryScopeSelection {
	switch (selection.scope) {
		case "repo": {
			const repository = canonicalMemoryRepositoryIdentity(selection.repository.key);
			if (
				selection.repository.kind !== "canonical-path" ||
				repository === null ||
				repository.key !== selection.repository.key
			) {
				throw new Error("repo scope requires an existing canonical absolute repository identity");
			}
			return { scope: "repo", repository };
		}
		case "global":
			if (selection.acknowledgeGlobal !== true) {
				throw new Error("global scope requires a separate operator acknowledgement");
			}
			return selection;
		case "runtime": {
			const runtime = normalizeNamedIdentity(selection.runtime, "runtime");
			if (!(source.runtimeIds ?? []).includes(runtime.key)) {
				throw new Error(`runtime identity '${runtime.key}' does not match the promotion source`);
			}
			return { scope: "runtime", runtime };
		}
		case "agent": {
			const agent = normalizeNamedIdentity(selection.agent, "agent");
			if (!(source.agentIds ?? []).includes(agent.key)) {
				throw new Error(`agent identity '${agent.key}' does not match the promotion source`);
			}
			return { scope: "agent", agent };
		}
	}
}

export function memoryRuntimeIdentity(key: string): MemoryRuntimeIdentity {
	return normalizeNamedIdentity({ kind: "runtime", key }, "runtime");
}

export function memoryAgentIdentity(key: string): MemoryAgentIdentity {
	return normalizeNamedIdentity({ kind: "agent", key }, "agent");
}

/** Create one reviewable proposal from a selected non-private task-bank entry. */
export async function proposeMemoryPromotion(
	dataDir: string,
	source: MemoryPromotionSource,
	selection: MemoryScopeSelection,
	now: Date = new Date(),
	/** Runs inside the store lock, so an equivalent record found here cannot be raced into a duplicate. */
	findExisting?: (records: ReadonlyArray<MemoryRecord>) => MemoryRecord | null,
	options: MemoryMutationOptions = {},
): Promise<MemoryProposalResult> {
	const record = memoryRecordFromPromotion(source, selection, now);
	return insertMemoryRecordIfAbsent(dataDir, record, findExisting, options);
}

export function memoryRecordFromPromotion(
	source: MemoryPromotionSource,
	selection: MemoryScopeSelection,
	now: Date = new Date(),
): MemoryRecord {
	validatePromotionSource(source);
	const entryKind = source.entry.kind;
	if (entryKind === "status") throw new Error("private task-memory status cannot be promoted");
	const validatedScope = validateMemoryScopeSelection(selection, {
		runtimeIds: source.runtimeIds ?? [],
		agentIds: source.agentIds ?? [],
	});
	const tally = createRedactionTally();
	const lesson = redactSecretsPreservingMarkers(source.entry.content, tally).replace(/\s+/gu, " ").trim();
	const sourceFields = new Set(source.redaction?.sourceFields ?? []);
	if (lesson !== source.entry.content) sourceFields.add("content");
	const replacementCount = (source.redaction?.replacementCount ?? 0) + tally.count;
	const scopeKey = memoryScopeIdentityKey(validatedScope);
	const record: MemoryRecord = {
		id: promotedMemoryId({
			sourceKind: source.kind,
			sessionId: source.sessionId,
			entryId: source.entry.id,
			entryKind,
			evidenceRefs: uniqueStrings(source.evidenceRefs),
			lesson,
			scopeKey,
		}),
		scope: validatedScope.scope,
		key: `promotion:${source.kind}:${source.sessionId}:${source.entry.id}`,
		lesson,
		evidenceRefs: uniqueStrings(source.evidenceRefs),
		appliesWhen: scopeApplicability(validatedScope),
		avoidWhen: [],
		confidence: 0.6,
		createdAt: now.toISOString(),
		approved: false,
		provenance: {
			sourceKind: source.kind,
			sourceSessionId: source.sessionId,
			sourceEntryId: source.entry.id,
			sourceEntryKind: entryKind,
			sourceEntryCreatedAt: source.entry.createdAt,
			sourceEntryLastTouchedAt: source.entry.lastTouchedAt,
			redaction: {
				appliedBeforePersistence: true,
				replacementCount,
				sourceFields: [...sourceFields].sort(compareCodeUnits),
			},
		},
	};
	applyScopeIdentity(record, validatedScope);
	const claim = claimFromEvidence(record.lesson, record.evidenceRefs);
	if (claim !== null) {
		if (validatedScope.scope === "repo") {
			const refusal = claimPathRefusal(claim, validatedScope.repository.key);
			if (refusal !== null) throw new Error(refusal);
		}
		record.claim = claim;
	}
	return assertValidMemoryRecord(record, "promoted");
}

/**
 * What a record's evidence refs claim, read from the refs and the lesson text alone. A verified `command:` ref is a
 * command claim on the quoted span whose evidence identity it names; without one, a single `source:` ref is a
 * source claim. A `command-claimed:` ref grants nothing and claims nothing. More than one candidate, or a command
 * whose words the store could not hold, is no claim.
 *
 * New records store the claim they were built with. A record written before claim identity has none stored and is
 * read through this function on every use (`recordClaim`); its derived claim is never written back.
 */
function claimFromEvidence(lesson: string, evidenceRefs: ReadonlyArray<string>): MemoryClaim | null {
	const declared = commandRefKeys(
		lesson,
		evidenceRefs.filter((ref) => ref.startsWith(COMMAND_EVIDENCE_REF_PREFIX)),
	);
	if (declared.size > 1) return null;
	if (declared.size === 1) {
		const segments = [...lesson.matchAll(/`([^`\n]+)`/gu)]
			.map((match) => commandSegment((match[1] ?? "").trim()))
			.filter((segment): segment is CommandSegment => segment !== null && declared.has(segment.key));
		const segment = segments[0];
		return segment === undefined ? null : commandClaimOf(segment);
	}
	const sources = evidenceRefs.flatMap((ref) => parseSourceEvidenceRef(ref) ?? []);
	const source = sources.length === 1 ? sources[0] : undefined;
	return source === undefined ? null : { kind: "source", path: source.path, spanHash: source.spanHash };
}

/** A segment as a claim binds it, or null when a word is empty and the store could not hold it. */
export function claimCommand(segment: CommandSegment, scratchParameter?: number): MemoryClaimCommand | null {
	if (segment.argv.some((word) => word.length === 0)) return null;
	if (scratchParameter !== undefined && (scratchParameter <= 0 || scratchParameter >= segment.argv.length)) return null;
	return {
		assignments: [...segment.assignments],
		argv: [...segment.argv],
		key: segment.key,
		...(scratchParameter !== undefined ? { scratchParameter } : {}),
	};
}

function commandClaimOf(segment: CommandSegment): MemoryClaim | null {
	const command = claimCommand(segment);
	return command === null ? null : { kind: "command", command };
}

/** The claim a record makes: the one it stores, or, for a record written before claim identity, its refs' claim. */
export function recordClaim(record: MemoryRecord): MemoryClaim | null {
	return record.claim ?? claimFromEvidence(record.lesson, record.evidenceRefs);
}

/**
 * Claim identity: repository, kind and body, plus any condition the record states beyond its repository, so
 * opposing facts that hold under different conditions stay two claims. Wording is not part of it. Only a
 * repository record with a claim has one.
 */
export function memoryClaimKey(record: MemoryRecord): string | null {
	if (record.scope !== "repo" || record.repository === undefined) return null;
	const claim = recordClaim(record);
	if (claim === null) return null;
	const conditions = record.appliesWhen.filter((condition) => !condition.startsWith("repository:")).sort();
	return createHash("sha256")
		.update(JSON.stringify([record.repository.key, claim.kind, claimBody(claim), conditions]))
		.digest("hex");
}

function claimBody(claim: MemoryClaim): unknown {
	const command = (item: MemoryClaimCommand) => [item.key, item.scratchParameter ?? null];
	switch (claim.kind) {
		case "command":
			return command(claim.command);
		case "fix":
			return [command(claim.failed), command(claim.fixed)];
		case "source":
			return [claim.path, claim.spanHash];
	}
}

/** Refs that carry evidence identity; a `session:` ref names provenance and changes per session. */
function gatingRef(ref: string): boolean {
	return (
		ref.startsWith(COMMAND_EVIDENCE_REF_PREFIX) || ref.startsWith(COMMAND_CLAIM_REF_PREFIX) || ref.startsWith("source:")
	);
}

/**
 * The revision a verdict judges: the lesson's words and its evidence. A rewording or a changed ref is a new
 * revision, and demonstrations of an earlier one do not count toward it.
 */
export function memoryRevision(record: Pick<MemoryRecord, "lesson" | "evidenceRefs">): string {
	const refs = [...new Set(record.evidenceRefs.filter(gatingRef))].sort();
	return createHash("sha256")
		.update(JSON.stringify([record.lesson.replace(/\s+/gu, " ").trim(), refs]))
		.digest("hex")
		.slice(0, 16);
}

/** The session that wrote a record's current wording: the reviser of its last revision, else the record's author. */
export function revisionAuthor(record: MemoryRecord): string | undefined {
	const last = record.revisions?.at(-1);
	if (last !== undefined && last.revision === memoryRevision(record)) return last.sessionId;
	return record.provenance?.sourceSessionId;
}

/**
 * Why a claim may not be written, or null. A note binds only paths of the repository it is filed under: an
 * absolute path outside the canonical root, inside a linked worktree, or under a scratch root is a fact about one
 * checkout or one run, and is refused at write. A declared scratch parameter is the exception it declares.
 */
export function claimPathRefusal(
	claim: MemoryClaim,
	repositoryRoot: string,
	scratchRoots: ReadonlyArray<string> = [],
): string | null {
	const root = resolve(repositoryRoot);
	const worktrees = (relatedRepositoryRoots(root)?.roots ?? []).filter((other) => strictlyInside(other, root));
	const scratch = [tmpdir(), "/tmp", "/var/tmp", ...scratchRoots]
		.filter((dir) => isAbsolute(dir))
		.map((dir) => resolve(dir));
	const refused = ({ path, program }: { path: string; program: boolean }): boolean => {
		const target = resolve(path);
		if (worktrees.some((other) => target === other || strictlyInside(target, other))) return true;
		if (scratch.some((dir) => target === dir || strictlyInside(target, dir))) {
			// The repository may itself sit under a scratch root; then only a scratch root inside it marks scratch.
			if (!strictlyInside(target, root)) return true;
			if (scratch.some((dir) => strictlyInside(dir, root) && (target === dir || strictlyInside(target, dir)))) return true;
		}
		// An installed program (`/usr/bin/python3`) names the host's tool, not a file of another checkout.
		return !program && target !== root && !strictlyInside(target, root);
	};
	const paths: Array<{ path: string; program: boolean }> = [];
	const command = (item: MemoryClaimCommand) => {
		for (const [index, word] of [...item.assignments, ...item.argv].entries()) {
			const at = index - item.assignments.length;
			if (at === item.scratchParameter) continue;
			const value = word.includes("=") ? word.slice(word.indexOf("=") + 1) : word;
			for (const candidate of new Set([word, value]))
				if (isAbsolute(candidate)) paths.push({ path: candidate, program: at === 0 });
		}
	};
	if (claim.kind === "command") command(claim.command);
	if (claim.kind === "fix") {
		command(claim.failed);
		command(claim.fixed);
	}
	if (claim.kind === "source" && isAbsolute(claim.path)) paths.push({ path: claim.path, program: false });
	const bad = paths.find(refused);
	return bad === undefined ? null : `memory note binds a path outside its repository checkout: ${bad.path}`;
}

function strictlyInside(path: string, root: string): boolean {
	const inside = relative(root, path);
	return inside.length > 0 && inside !== ".." && !inside.startsWith(`..${sep}`) && !isAbsolute(inside);
}

/**
 * A note composed from a session's receipts: unapproved, at repository scope, authored by that session, its id
 * derived from its claim identity so every session filing the claim names the same record. Its evidence ref is the
 * command its claim recommends (a fix claim's fixed pattern) or its quoted source. A claim whose words would carry
 * a secret is refused rather than redacted, since a redacted argv names a different command.
 */
export function claimNote(input: {
	sessionId: string;
	lesson: string;
	claim: MemoryClaim;
	repository: MemoryRepositoryIdentity;
	at: string;
}): MemoryRecord {
	const lesson = redactSecretsPreservingMarkers(input.lesson, createRedactionTally()).replace(/\s+/gu, " ").trim();
	const claimText = JSON.stringify(input.claim);
	if (redactSecretsPreservingMarkers(claimText, createRedactionTally()) !== claimText)
		throw new Error("a memory note cannot bind a secret");
	const claim = input.claim;
	const evidence =
		claim.kind === "source"
			? `source:${claim.path}#${claim.spanHash}`
			: `${COMMAND_EVIDENCE_REF_PREFIX}${claim.kind === "fix" ? claim.fixed.key : claim.command.key}`;
	const record: MemoryRecord = {
		id: "mem-0000000000000000",
		scope: "repo",
		key: `claim:${claim.kind}`,
		lesson,
		evidenceRefs: [`session:${input.sessionId}`, evidence],
		appliesWhen: [`repository:${input.repository.kind}:${input.repository.key}`],
		avoidWhen: [],
		confidence: 0.6,
		createdAt: input.at,
		approved: false,
		repository: { ...input.repository },
		provenance: { sourceKind: "evidence", evidenceId: `session:${input.sessionId}`, sourceSessionId: input.sessionId },
		claim,
	};
	const identity = memoryClaimKey(record);
	if (identity === null) throw new Error("a memory note requires a claim");
	record.id = `mem-${identity.slice(0, 16)}`;
	record.key = `claim:${claim.kind}:${identity.slice(0, 16)}`;
	return assertValidMemoryRecord(record, "claim note");
}

export function applyScopeIdentity(record: MemoryRecord, selection: MemoryScopeSelection): void {
	if (selection.scope === "repo") record.repository = { ...selection.repository };
	if (selection.scope === "runtime") record.runtime = { ...selection.runtime };
	if (selection.scope === "agent") record.agent = { ...selection.agent };
}

export function memoryScopeIdentityKey(selection: MemoryScopeSelection): string {
	switch (selection.scope) {
		case "repo":
			return `repo:${selection.repository.kind}:${selection.repository.key}`;
		case "global":
			return "global:acknowledged";
		case "runtime":
			return `runtime:${selection.runtime.key}`;
		case "agent":
			return `agent:${selection.agent.key}`;
	}
}

function validatePromotionSource(source: MemoryPromotionSource): void {
	if (!validSourceValue(source.sessionId)) throw new Error("promotion requires a valid source session id");
	if (source.evidenceRefs.length === 0 || source.evidenceRefs.some((value) => !validSourceValue(value))) {
		throw new Error("promotion requires at least one valid source evidence ref");
	}
	if (source.entry.kind === "status") throw new Error("private task-memory status cannot be promoted");
	if (source.entry.kind !== "knowledge" && source.entry.kind !== "procedural") {
		throw new Error("promotion requires a knowledge or procedural task-memory entry");
	}
	if (!validSourceValue(source.entry.id) || source.entry.content.trim().length === 0) {
		throw new Error("promotion requires a valid task-memory entry");
	}
	for (const runtimeId of source.runtimeIds ?? []) memoryRuntimeIdentity(runtimeId);
	for (const agentId of source.agentIds ?? []) memoryAgentIdentity(agentId);
	if (source.redaction !== undefined) {
		if (!Number.isInteger(source.redaction.replacementCount) || source.redaction.replacementCount < 0) {
			throw new Error("promotion source redaction count must be a non-negative integer");
		}
		if (source.redaction.sourceFields.some((field) => !validSourceValue(field))) {
			throw new Error("promotion source redaction fields must be valid non-empty strings");
		}
	}
}

function normalizeNamedIdentity<T extends "runtime" | "agent">(
	identity: { kind: T; key: string },
	kind: T,
): { kind: T; key: string } {
	if (identity.kind !== kind || !validNamedIdentityKey(identity.key)) {
		throw new Error(`${kind} scope requires a valid ${kind} identity`);
	}
	return { kind, key: identity.key };
}

function scopeApplicability(selection: MemoryScopeSelection): string[] {
	switch (selection.scope) {
		case "repo":
			return [`repository:${selection.repository.kind}:${selection.repository.key}`];
		case "global":
			return [];
		case "runtime":
			return [`runtime:${selection.runtime.key}`];
		case "agent":
			return [`agent:${selection.agent.key}`];
	}
}

function promotedMemoryId(value: {
	sourceKind: MemoryPromotionSource["kind"];
	sessionId: string;
	entryId: string;
	entryKind: TaskMemoryRenderableClass;
	evidenceRefs: string[];
	lesson: string;
	scopeKey: string;
}): string {
	const digest = createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex").slice(0, 16);
	return `mem-${digest}`;
}

function uniqueStrings(values: ReadonlyArray<string>): string[] {
	return [...new Set(values)].sort(compareCodeUnits);
}

/**
 * Propose one task-bank entry from a session as a durable memory candidate, the
 * way the terminal's memory overlay does. Repository scope needs the session's
 * canonical repository identity; global scope is the caller's to confirm first.
 * The record id is derived from the entry, the session and the scope, so a
 * retried proposal finds the existing candidate instead of writing a second.
 */
export async function proposeTaskBankPromotion(
	dataDir: string,
	session: { id: string; cwd: string },
	entry: TaskMemoryEntry,
	scope: "repo" | "global",
): Promise<MemoryProposalResult> {
	const selection: MemoryScopeSelection =
		scope === "global"
			? { scope: "global", acknowledgeGlobal: true }
			: (() => {
					const repository = canonicalMemoryRepositoryIdentity(session.cwd);
					if (repository === null) throw new Error("repo promotion requires a canonical active repository identity");
					return { scope: "repo", repository } as const;
				})();
	return proposeMemoryPromotion(
		dataDir,
		{ kind: "task-bank-entry", sessionId: session.id, evidenceRefs: [`session-${session.id}`], entry },
		selection,
	);
}
