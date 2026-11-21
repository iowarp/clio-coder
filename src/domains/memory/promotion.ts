import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { repositoryRoot as enclosingRepository } from "../../core/project-root.js";
import { createRedactionTally, redactSecretsPreservingMarkers } from "../evidence/redact.js";
import {
	COMMAND_CLAIM_REF_PREFIX,
	COMMAND_EVIDENCE_REF_PREFIX,
	type CommandSegment,
	commandSegment,
	commandTextHash,
	parseSourceEvidenceRef,
	segmentKeyRef,
} from "./command-evidence.js";
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
	const claim = claimFromEvidence(
		record.lesson,
		record.evidenceRefs,
		validatedScope.scope === "repo" ? validatedScope.repository.key : undefined,
	);
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
 * whose words the store could not hold, is no claim. A quoted span is read against the repository root, as
 * evidence identity reads a receipt, so `cd <root> && pnpm test` claims `pnpm test`; a ref for a command with no
 * evidence identity of its own (`cd <root> && pnpm test` read without the root) names its span by the text hash.
 *
 * A record stores the claim it was built with; this runs when it is built, and once in the memory store upgrade.
 */
export function claimFromEvidence(
	lesson: string,
	evidenceRefs: ReadonlyArray<string>,
	root?: string,
): MemoryClaim | null {
	const hashes = new Set(
		evidenceRefs
			.filter((ref) => ref.startsWith(COMMAND_EVIDENCE_REF_PREFIX))
			.map((ref) => ref.slice(COMMAND_EVIDENCE_REF_PREFIX.length)),
	);
	if (hashes.size > 1) return null;
	const [hash] = [...hashes];
	if (hash !== undefined) {
		for (const match of lesson.matchAll(/`([^`\n]+)`/gu)) {
			const span = (match[1] ?? "").trim();
			const segment = commandSegment(span, root);
			if (segment === null) continue;
			const named = segmentKeyRef(hash)
				? segment.key === hash || commandSegment(span)?.key === hash
				: commandTextHash(span) === hash;
			if (named) return commandClaimOf(segment);
		}
		return null;
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

/** The claim a record makes: the one it stores, or none. */
export function recordClaim(record: MemoryRecord): MemoryClaim | null {
	return record.claim ?? null;
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
	// A declared scratch parameter is a parameter: its value is masked, keeping any `--flag=` prefix, so every
	// session's concrete scratch path names the one claim. An undeclared argv is its evidence key.
	const command = (item: MemoryClaimCommand) => {
		const at = item.scratchParameter;
		if (at === undefined) return [item.key, null];
		const argv = item.argv.map((word, index) =>
			index === at ? `${word.startsWith("-") ? word.slice(0, word.indexOf("=") + 1) : ""}\u0000scratch` : word,
		);
		return [item.assignments, argv, at];
	};
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
 * Why a claim may not be written, or null. A note binds only paths of the repository it is filed under, judged where
 * they land with symlinks resolved: a path outside the canonical root, inside a linked worktree, or under a scratch
 * root is a fact about one checkout or one run, and is refused at write. A relative source path is read against the
 * root. A repository that itself sits under a scratch root still owns its own paths. The program word may name an
 * installed tool outside the repository (`/usr/bin/python3`), never a file of another checkout or a scratch root. A
 * declared scratch parameter is the one exception, and only when it holds a path under a scratch root.
 */
export function claimPathRefusal(
	claim: MemoryClaim,
	repositoryRoot: string,
	scratchRoots: ReadonlyArray<string> = [],
): string | null {
	return pathRefusal(claim, repositoryRoot, [tmpdir(), "/tmp", "/var/tmp", ...scratchRoots]);
}

/**
 * The same rule at delivery, for a record written before it (CLI-P25), minus the judgement that needs the writer's
 * scratch roots: its TMPDIR and settings are not the reader's, so a declared scratch parameter is not asked to lie under
 * the reader's roots. Everything else stands: a scratch parameter inside the checkout or another worktree, a program
 * under /tmp or /var/tmp, and a path of another worktree or checkout, or outside the repository, are refused. Whatever
 * passed at write passes here.
 */
export function claimDeliveryPathRefusal(claim: MemoryClaim, repositoryRoot: string): string | null {
	return pathRefusal(claim, repositoryRoot, ["/tmp", "/var/tmp"], false);
}

/** `writerRoots` false: the scratch roots are not the writer's, so a scratch parameter's placement under them is unjudged. */
function pathRefusal(
	claim: MemoryClaim,
	repositoryRoot: string,
	scratchRoots: ReadonlyArray<string>,
	writerRoots = true,
): string | null {
	const root = landedPath(repositoryRoot);
	const worktrees = (relatedRepositoryRoots(root)?.roots ?? []).map(landedPath).filter((other) => other !== root);
	const scratch = [...new Set(scratchRoots.filter((dir) => isAbsolute(dir)))].map(landedPath);
	const within = (path: string, dir: string) => path === dir || strictlyInside(path, dir);
	const inWorktree = (target: string) => worktrees.some((other) => within(target, other));
	const inRepository = (target: string) =>
		within(target, root) &&
		!inWorktree(target) &&
		!scratch.some((dir) => strictlyInside(dir, root) && within(target, dir));
	const underScratch = (target: string) => scratch.some((dir) => within(target, dir));
	const refused = ({ path, use }: { path: string; use: "word" | "program" | "scratch" }): boolean => {
		const target = landedPath(resolve(root, path));
		if (use === "scratch") return within(target, root) || inWorktree(target) || (writerRoots && !underScratch(target));
		if (inRepository(target)) return false;
		if (use === "word") return true;
		return underScratch(target) || inWorktree(target) || enclosingRepository(target) !== null;
	};
	const paths: Array<{ path: string; use: "word" | "program" | "scratch" }> = [];
	const command = (item: MemoryClaimCommand) => {
		for (const [index, word] of [...item.assignments, ...item.argv].entries()) {
			const at = index - item.assignments.length;
			const value = word.includes("=") ? word.slice(word.indexOf("=") + 1) : word;
			if (at === item.scratchParameter) {
				paths.push({ path: isAbsolute(value) ? value : "\u0000", use: "scratch" });
				continue;
			}
			for (const candidate of new Set([word, value]))
				if (isAbsolute(candidate)) paths.push({ path: candidate, use: at === 0 ? "program" : "word" });
		}
	};
	if (claim.kind === "command") command(claim.command);
	if (claim.kind === "fix") {
		command(claim.failed);
		command(claim.fixed);
	}
	if (claim.kind === "source") paths.push({ path: claim.path, use: "word" });
	const bad = paths.find(refused);
	if (bad === undefined) return null;
	return bad.use === "scratch"
		? writerRoots
			? "memory note declares a scratch parameter that holds no path under a scratch root"
			: "memory note declares a scratch parameter that holds a path of a repository checkout"
		: `memory note binds a path outside its repository checkout: ${bad.path}`;
}

function strictlyInside(path: string, root: string): boolean {
	const inside = relative(root, path);
	return inside.length > 0 && inside !== ".." && !inside.startsWith(`..${sep}`) && !isAbsolute(inside);
}

/** Where a path lands: the real path of its nearest existing ancestor, with the rest unchanged. */
function landedPath(path: string): string {
	const rest: string[] = [];
	for (let current = resolve(path); ; ) {
		try {
			return join(realpathSync(current), ...rest.reverse());
		} catch {
			const parent = dirname(current);
			if (parent === current) return resolve(path);
			rest.push(basename(current));
			current = parent;
		}
	}
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
	/** Conditions the claim holds under beyond its repository; they are part of its identity. */
	appliesWhen?: ReadonlyArray<string>;
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
		appliesWhen: [
			`repository:${input.repository.kind}:${input.repository.key}`,
			// A condition is the note's words too, so it is redacted exactly as the lesson is.
			...new Set(
				(input.appliesWhen ?? [])
					.map((item) => redactSecretsPreservingMarkers(item, createRedactionTally()).replace(/\s+/gu, " ").trim())
					.filter((item) => item.length > 0),
			),
		],
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
