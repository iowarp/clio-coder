import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { processAlive, processBirthToken } from "../../core/process-identity.js";
import { safeResourceWrite } from "../../core/safe-resource-write.js";
import { withStateFileLock } from "../../core/state-file-lock.js";
import { MEMORY_HISTORY_REVIEW_SYSTEM_PROMPT } from "../prompts/memory-intervention.js";
import type { MemoryCommitScope } from "./commit-state.js";
import type { CompletedLessonSource } from "./history-review.js";
import { lessonEvidence } from "./lesson-evidence.js";
import type { MemoryLessonJudge } from "./lesson-judge.js";
import type { MemoryObservationEvent } from "./observation-events.js";
import { observationEvent, observationTracing, traceObservation } from "./observation-events.js";
import { observationDigest } from "./observations.js";
import { provenRecipes, recipeAlreadyClaimed } from "./recipes.js";
import type { TaskMemoryBank, TaskMemoryEntry } from "./task-bank.js";
import { TASK_MEMORY_CONTENT_MAX_CHARS } from "./task-bank.js";
import { proposeInjectedTaskMemory } from "./task-bank-promotion.js";
import type { TaskMemoryEnvelope, TaskMemoryModelClient, TaskMemoryStepUsage } from "./task-memory-policy.js";
import { runTaskMemoryPolicy } from "./task-memory-policy.js";

export interface RetentionStatus {
	readonly phase: "idle" | "extracting" | "abstained" | "pending" | "retained" | "gated" | "skipped" | "exhausted";
	readonly reason: string | null;
	readonly extracted: number;
	readonly retained: readonly { readonly id: string; readonly text: string }[];
	readonly attempts: number;
	readonly revision: string | null;
	readonly candidateIds?: readonly string[];
}
export const EMPTY_RETENTION: RetentionStatus = {
	phase: "idle",
	reason: null,
	extracted: 0,
	retained: [],
	attempts: 0,
	revision: null,
};

export function retentionPath(stateDir: string, scope: MemoryCommitScope, source: CompletedLessonSource): string {
	return join(stateDir, "memory", "retention", `${observationDigest([scope.sessionId, source.revision])}.json`);
}

export function readRetention(
	path: string,
):
	| (RetentionStatus & { ownerPid?: number; ownerBirthToken?: string | null; candidates?: readonly TaskMemoryEntry[] })
	| null {
	try {
		if (statSync(path).size > 32 * 1024) return null;
		const value = JSON.parse(readFileSync(path, "utf8"));
		if (
			value.version !== 1 ||
			!["extracting", "abstained", "pending", "retained", "gated", "skipped", "exhausted"].includes(value.phase) ||
			!Number.isSafeInteger(value.attempts) ||
			value.attempts < 0 ||
			value.attempts > 2 ||
			!Array.isArray(value.retained) ||
			value.retained.length > 2 ||
			(value.candidateIds !== undefined &&
				(!Array.isArray(value.candidateIds) ||
					value.candidateIds.length > 2 ||
					!value.candidateIds.every((id: unknown) => typeof id === "string"))) ||
			(value.candidates !== undefined &&
				(!Array.isArray(value.candidates) || value.candidates.length > 2 || !value.candidates.every(retentionCandidate))) ||
			!value.retained.every(
				(record: { id?: unknown; text?: unknown }) => typeof record.id === "string" && typeof record.text === "string",
			)
		)
			return null;
		if (value.phase === "retained" && value.retained.some((record: { text: string }) => !reusableContent(record.text))) {
			value.phase = "pending";
			value.reason = "transient-task-content";
		}
		if (
			value.phase === "extracting" &&
			(typeof value.ownerPid !== "number" ||
				!processAlive(value.ownerPid) ||
				(value.ownerBirthToken != null && processBirthToken(value.ownerPid) !== value.ownerBirthToken))
		) {
			value.phase = "pending";
			value.reason = "process-interrupted";
		}
		if (value.phase === "pending" && value.attempts >= 2 && !value.candidates?.length) value.phase = "exhausted";
		return value;
	} catch {
		return null; /* The raw ledger remains the recoverable work source. */
	}
}

/** One bounded pass through the existing routed client and evidence gate; no observer shutdown wait. */
export async function retainCompletedTask(input: {
	stateDir: string;
	dataDir: string;
	cwd: string;
	scope: MemoryCommitScope;
	source: CompletedLessonSource;
	bank: TaskMemoryBank;
	client: TaskMemoryModelClient;
	maxTokens: number;
	timeoutMs: number;
	signal: AbortSignal;
	isCurrent(): boolean;
	onUsage?: (usage: TaskMemoryStepUsage, current: boolean) => void;
	judge?: MemoryLessonJudge;
	onProgress?: (status: RetentionStatus) => void;
	/**
	 * Approved repository claims. The pass is shown them so it does not restate
	 * one in new words, and a host recipe never duplicates one.
	 */
	keptLessons?: () => ReadonlyArray<{ id: string; text: string; evidenceRefs?: readonly string[] }>;
}): Promise<RetentionStatus> {
	// One deadline covers inference and durable store waits. Returning on a raced promise alone
	// would leave a writer alive after headless shutdown or scope cancellation.
	const deadline = AbortSignal.timeout(Math.max(1, input.timeoutMs));
	const signal = AbortSignal.any([input.signal, deadline]);
	const current = input.isCurrent;
	return retainWithinDeadline({
		...input,
		signal,
		isCurrent: () => !signal.aborted && current(),
		// Cancellation by the caller (navigation, disposal) as opposed to this job's own deadline.
		withdrawn: () => input.signal.aborted || !current(),
	});
}

async function retainWithinDeadline(
	input: Parameters<typeof retainCompletedTask>[0] & { withdrawn(): boolean },
): Promise<RetentionStatus> {
	const path = retentionPath(input.stateDir, input.scope, input.source);
	let savedCandidates: readonly TaskMemoryEntry[] = [];
	if (!existsSync(input.stateDir) || !input.isCurrent())
		return { ...EMPTY_RETENTION, phase: "pending", reason: "scope-changed", revision: input.source.revision };
	const claim = await withStateFileLock(
		path,
		() => {
			const previous = readRetention(path);
			if (
				previous &&
				(previous.phase === "retained" ||
					previous.phase === "abstained" ||
					previous.phase === "gated" ||
					(previous.attempts >= 2 && !previous.candidates?.length))
			)
				return { claimed: false, status: previous };
			if (previous?.phase === "extracting")
				return { claimed: false, status: { ...previous, phase: "pending" as const, reason: "other-process-extracting" } };
			input.signal.throwIfAborted();
			if (!input.isCurrent()) throw new Error("memory extraction lost content authority");
			savedCandidates = (previous?.candidates ?? []).filter(
				(entry) =>
					reusableLesson(entry) &&
					lessonEvidence(entry, {
						succeededCommands: input.source.succeededCommands,
						observedReads: input.source.observedReads,
						workspaceRoot: input.cwd,
					}) !== null,
			);
			if (previous && previous.attempts >= 2 && !savedCandidates.length) {
				const gated: RetentionStatus = { ...previous, phase: "gated", reason: "candidate-evidence-changed" };
				write(gated);
				return { claimed: false, status: gated };
			}
			const status: RetentionStatus = {
				phase: "extracting",
				reason: null,
				extracted: previous?.extracted ?? 0,
				retained: [],
				...(previous?.candidateIds ? { candidateIds: previous.candidateIds } : {}),
				attempts: (previous?.attempts ?? 0) + (savedCandidates.length ? 0 : 1),
				revision: input.source.revision,
			};
			write(status);
			return { claimed: true, status };
		},
		{ timeoutMs: 100, signal: input.signal },
	);
	if (!claim.claimed) return claim.status;
	const attempts = claim.status.attempts;
	const status: RetentionStatus = {
		...claim.status,
	};
	input.onProgress?.(status);
	function write(value: RetentionStatus) {
		safeResourceWrite(
			path,
			JSON.stringify({
				version: 1,
				ownerPid: process.pid,
				ownerBirthToken: processBirthToken(process.pid),
				...value,
				sessionId: input.scope.sessionId,
				sourceRefs: input.source.refs,
				at: new Date().toISOString(),
				...((value.phase === "extracting" || value.phase === "pending") && savedCandidates.length
					? { candidates: savedCandidates }
					: {}),
			}),
			{ mode: 0o600 },
		);
	}
	const save = async (value: RetentionStatus, release = false) => {
		if (!existsSync(input.stateDir) || (!input.isCurrent() && !release)) return;
		await withStateFileLock(
			path,
			() => {
				if (!input.isCurrent() && !release) return;
				const current = readRetention(path);
				if (current?.ownerPid !== process.pid || current.attempts !== attempts || current.phase !== "extracting") return;
				write(value);
			},
			{ timeoutMs: 100, ...(release ? {} : { signal: input.signal }) },
		);
	};
	const event = (name: MemoryObservationEvent, facts: Record<string, unknown>) =>
		observationEvent(
			name,
			{
				revision: input.source.revision,
				...facts,
			},
			input.scope.sessionId,
		);
	const restoringCandidates = savedCandidates.length > 0;
	event(restoringCandidates ? "lesson-candidates-restored" : "lesson-extraction-started", {
		attempts,
		route: input.client.route ?? null,
		timeoutMs: input.timeoutMs,
	});
	const started = performance.now();
	let usage: TaskMemoryStepUsage | null = null;
	if (!savedCandidates.length && observationTracing())
		traceObservation("lesson-input", {
			sourceRefs: input.source.refs,
			trajectory: input.source.text,
			route: input.client.route ?? null,
		});
	const before = new Map(input.bank.snapshot().knowledge.map((entry) => [entry.id, entry.content]));
	try {
		const result = savedCandidates.length
			? { decision: "silent" as const, reason: "suppressed" as const, bankOperations: 0, droppedOperations: 0 }
			: await runTaskMemoryPolicy(input.bank, input.client, {
					task: "Retain only reusable, evidence-backed lessons from this completed repository task.",
					trajectory: [],
					deterministicTrigger: false,
					maxTokens: input.maxTokens,
					modelMaxTokens: input.maxTokens,
					timeoutMs: input.timeoutMs,
					signal: input.signal,
					isCurrent: input.isCurrent,
					suppressIntervention: true,
					workspaceRoot: input.cwd,
					pass: {
						systemPrompt: MEMORY_HISTORY_REVIEW_SYSTEM_PROMPT,
						trajectoryText: input.source.text,
						trajectoryMaxChars: 4000,
						// Separate claims stay separate records, so a rewording of a kept
						// lesson would file a second one; the pass sees what is kept.
						keptLessons: (input.keptLessons?.() ?? []).slice(0, 10).map(({ id, text }) => ({ id, text })),
					},
					onStepUsage: (step) => {
						usage = step;
						input.onUsage?.(step, input.isCurrent());
					},
					...(observationTracing()
						? {
								onEnvelope: (envelope: TaskMemoryEnvelope) =>
									traceObservation("lesson-output", {
										decision: envelope.decision,
										reason: envelope.reason,
										response: envelope.response,
									}),
							}
						: {}),
				});
		if (!restoringCandidates)
			event("lesson-extraction-settled", {
				attempts,
				usage,
				durationMs: performance.now() - started,
				decision: result.decision,
				reason: result.reason,
			});
		// Recipes the task's own receipts prove; computed after the model pass so a
		// lesson the model wrote for the same command keeps the model's wording.
		const proven = restoringCandidates ? [] : provenRecipes(input.source, input.cwd);
		const answered =
			result.decision !== "timeout" &&
			result.decision !== "malformed" &&
			["model_silent", "suppressed", "intervened", "duplicate_reminder", "invalid_reminder", "over_budget"].includes(
				result.reason,
			);
		if ((!answered && proven.length === 0) || !input.isCurrent()) {
			// A foreground request that claimed the endpoint mid-call is occupancy, not an answer.
			const notAdmitted = [
				"endpoint_busy",
				"endpoint_preempted",
				"cost_ceiling",
				"quota_unknown",
				"quota_window",
				"quota_retry",
				"time_budget",
				"information_flow_blocked",
				"no_client",
			].includes(result.reason);
			// A job its caller withdrew before any model usage arrived spent no attempt:
			// closing a session 25 ms after its last turn must not cost the task a review.
			const unspent = notAdmitted || (usage === null && input.withdrawn());
			const pending: RetentionStatus = {
				...status,
				attempts: unspent ? attempts - 1 : attempts,
				phase: !unspent && attempts >= 2 ? "exhausted" : "pending",
				reason: input.signal.aborted ? "deadline-or-cancelled" : input.isCurrent() ? result.reason : "scope-changed",
			};
			await save(pending, !input.isCurrent());
			event("lesson-extraction-deferred", { reason: pending.reason, attempts });
			return pending;
		}
		const quoted = (command: string) =>
			input.bank.snapshot().knowledge.some((entry) => entry.durable === true && entry.content.includes(`\`${command}\``));
		const kept = input.keptLessons?.() ?? [];
		for (const recipe of proven)
			if (!quoted(recipe.command) && !recipeAlreadyClaimed(recipe, kept))
				input.bank.saveKnowledge(recipe.content, { durable: true, evidenceCommand: recipe.command });
		const candidates = savedCandidates.length
			? [...savedCandidates]
			: input.bank
					.snapshot()
					.knowledge.filter((entry) => entry.durable === true && before.get(entry.id) !== entry.content);
		const extracted = restoringCandidates ? status.extracted : candidates.length;
		const transient = candidates.filter((entry) => !reusableLesson(entry));
		const lessons = candidates
			.filter(
				(entry) =>
					entry.durable === true &&
					reusableLesson(entry) &&
					lessonEvidence(entry, {
						succeededCommands: input.source.succeededCommands,
						observedReads: input.source.observedReads,
						workspaceRoot: input.cwd,
					}) !== null,
			)
			.slice(0, 2);
		event(restoringCandidates ? "lesson-candidates-revalidated" : "lesson-extraction-completed", {
			proven: proven.map((recipe) => recipe.rule),
			answered,
			operations: result.bankOperations,
			dropped: result.droppedOperations,
			grounded: lessons.length,
			extracted,
		});
		if (transient.length && input.isCurrent()) {
			for (const entry of transient) input.bank.saveKnowledge(entry.content, { id: entry.id, durable: false });
			event("lesson-candidates-rejected", { reason: "transient-task-content", count: transient.length });
		}
		const prepared = { ...status, extracted, candidateIds: lessons.map((entry) => entry.id) };
		savedCandidates = lessons;
		input.onProgress?.(prepared);
		await save(prepared);
		input.signal.throwIfAborted();
		if (!input.isCurrent()) throw new Error("memory judgment lost content authority");
		const judged = input.judge && lessons.length ? await input.judge(lessons, input.source, input.signal) : undefined;
		if (input.judge && lessons.length)
			event("lesson-judgment", { candidates: lessons.length, accepted: judged?.size ?? 0, unavailable: judged === null });
		const proposed = await proposeInjectedTaskMemory(input.dataDir, {
			sessionId: input.scope.sessionId,
			cwd: input.cwd,
			entries: lessons,
			observation: "held",
			...(judged !== undefined ? { heldEntryIds: judged ?? new Set<string>() } : {}),
			writeOptions: { signal: input.signal, timeoutMs: 100, isCurrent: input.isCurrent },
		});
		const selectedRecords =
			judged === undefined
				? proposed.records
				: lessons
						.filter((entry) => judged?.has(entry.id))
						.flatMap((entry) => {
							const record = proposed.recordByEntry.get(entry.id);
							return record ? [record] : [];
						});
		const retained = [
			...new Map(selectedRecords.filter((record) => record.approved).map((record) => [record.id, record])).values(),
		].map((record) => ({
			id: record.id,
			text: record.lesson,
		}));
		// Stored proposals the gate held are settled: another pass over the same
		// candidates restores them free of an attempt and would only append the same
		// session's `held` again, which once evicted an older contradiction. Only an
		// unavailable judge or a failed store write leaves saved candidates pending.
		// Lessons the host could bind to no receipt or source are a deterministic
		// verdict over this source: the same ledger yields the same evidence, so a
		// second extraction could only reword them. In the live session they stay
		// in its bank for scope-end filing as pending; a closed session's job runs
		// on a bank nothing files, so there they are dropped, as a second attempt
		// would have dropped them. The task itself is settled (SPEC R07).
		const final: RetentionStatus = {
			...prepared,
			phase: retained.length
				? "retained"
				: proposed.errors.length > 0 || (lessons.length > 0 && judged === null)
					? "pending"
					: lessons.length > 0
						? "gated"
						: result.droppedOperations
							? "pending"
							: "abstained",
			reason: proposed.errors.length
				? "store-error"
				: lessons.length && !retained.length
					? judged === null
						? "judge-unavailable"
						: judged !== undefined
							? "judge-gated"
							: "evidence-gate-held"
					: result.droppedOperations
						? "invalid-operations"
						: extracted && !lessons.length
							? "missing-source-evidence"
							: lessons.length
								? null
								: "no-eligible-lesson",
			extracted,
			retained,
		};
		const bounded =
			final.phase === "pending" && attempts >= 2 && !savedCandidates.length
				? { ...final, phase: "exhausted" as const }
				: final;
		await save(bounded);
		event(
			retained.length
				? "lessons-retained"
				: final.phase === "gated"
					? "lesson-judgment-gated"
					: final.phase === "abstained"
						? "lesson-extraction-abstained"
						: "lesson-retention-deferred",
			{
				phase: bounded.phase,
				reason: bounded.reason,
				extracted: bounded.extracted,
				retainedIds: retained.map((record) => record.id),
				attempts,
			},
		);
		return bounded;
	} catch {
		const recorded = readRetention(path);
		const pending: RetentionStatus = {
			...status,
			extracted: recorded?.extracted ?? 0,
			...(recorded?.candidateIds ? { candidateIds: recorded.candidateIds } : {}),
			phase: attempts >= 2 && !savedCandidates.length ? "exhausted" : "pending",
			reason: input.signal.aborted ? "deadline-or-cancelled" : "store-error",
		};
		await save(pending, true).catch(() => {
			/* The claim is recoverable after process interruption. */
		});
		event("lesson-retention-deferred", { phase: pending.phase, reason: pending.reason, attempts });
		return pending;
	}
}

function reusableLesson(entry: TaskMemoryEntry): boolean {
	return reusableContent(entry.content);
}

function retentionCandidate(value: unknown): value is TaskMemoryEntry {
	if (value === null || typeof value !== "object") return false;
	const entry = value as Record<string, unknown>;
	const source = entry.evidenceSource;
	return (
		entry.kind === "knowledge" &&
		entry.durable === true &&
		typeof entry.id === "string" &&
		/^tm-k-[0-9a-z]+$/u.test(entry.id) &&
		typeof entry.content === "string" &&
		entry.content.length > 0 &&
		entry.content.length <= TASK_MEMORY_CONTENT_MAX_CHARS &&
		typeof entry.createdAt === "string" &&
		typeof entry.lastTouchedAt === "string" &&
		Number.isSafeInteger(entry.injectionCount) &&
		Number(entry.injectionCount) >= 0 &&
		(entry.evidenceCommand === undefined || typeof entry.evidenceCommand === "string") &&
		(source === undefined ||
			(source !== null &&
				typeof source === "object" &&
				typeof (source as Record<string, unknown>).path === "string" &&
				typeof (source as Record<string, unknown>).quote === "string"))
	);
}
function reusableContent(content: string): boolean {
	const prose = content.replace(/`[^`]*`/gu, "");
	return !/\b(?:this (?:task|session)|(?:we|I) (?:just )?(?:fixed|changed|implemented)|verification (?:passed|complete)|(?:current(?:ly)?|now) (?:config|configuration|mode|label|status|state)|(?:label|codeword|passphrase) (?:is|was)|(?:remains?|is|still) (?:pending|in progress))\b/iu.test(
		prose,
	);
}
