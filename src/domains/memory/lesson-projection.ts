/**
 * The approved repository lessons an action-time reminder may cite, as an
 * immutable projection of the durable store.
 *
 * Action reminders used to reduce each record to its id and prose, so the
 * conditions stored beside the prose, who approved it and which command its
 * evidence named never reached the reminder. The projection keeps them, and
 * it is cached by the store's revision and the workspace's repository
 * authority: tool boundaries ask for it on every call, and rereading and
 * resorting the whole store there was most of the work.
 */

import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import { COMMAND_EVIDENCE_REF_PREFIX } from "./command-evidence.js";
import { type LessonCommands, lessonCommands, lessonSubject } from "./lesson-evidence.js";
import { canonicalMemoryRepositoryIdentity, eligibleMemoryRecords } from "./operations.js";
import { memoryStorePath, readMemoryStoreSnapshot } from "./store.js";
import type { MemoryRecord } from "./types.js";

export type KeptLessonApproval = "operator" | "automatic";

export interface KeptLesson {
	readonly id: string;
	readonly text: string;
	/** Prose conditions; scope identities the eligibility filter already matched are left out. */
	readonly appliesWhen: readonly string[];
	readonly avoidWhen: readonly string[];
	/** An operator approved it, or the evidence gate retained it without one. */
	readonly approval: KeptLessonApproval;
	/** `command:` and `source:` evidence identities recorded with the claim. */
	readonly evidenceRefs: readonly string[];
	readonly commands: LessonCommands;
	readonly paths: readonly string[];
	/** Changes whenever the text, conditions or approval change; a reminder cites this. */
	readonly revision: string;
}

/** Scope applicability written by promotion; eligibility already decided these. */
const SCOPE_CONDITION = /^(?:repository|runtime|agent):/u;

export function projectKeptLesson(record: MemoryRecord): KeptLesson {
	const appliesWhen = record.appliesWhen.filter((condition) => !SCOPE_CONDITION.test(condition));
	const avoidWhen = [...record.avoidWhen];
	// A record approved before approval stamps existed was reviewed by a person (see guardian-gate).
	const approval: KeptLessonApproval = record.approval?.by === "guardian" ? "automatic" : "operator";
	const evidenceRefs = record.evidenceRefs.filter(
		(ref) => ref.startsWith(COMMAND_EVIDENCE_REF_PREFIX) || ref.startsWith("source:"),
	);
	return Object.freeze({
		id: record.id,
		text: record.lesson,
		appliesWhen: Object.freeze(appliesWhen),
		avoidWhen: Object.freeze(avoidWhen),
		approval,
		evidenceRefs: Object.freeze(evidenceRefs),
		commands: Object.freeze(lessonCommands(record.lesson, record.evidenceRefs)),
		paths: Object.freeze([...lessonSubject(record.lesson).paths]),
		revision: createHash("sha256")
			.update(JSON.stringify([record.lesson, appliesWhen, avoidWhen, approval, evidenceRefs]))
			.digest("hex")
			.slice(0, 16),
	});
}

/**
 * A lesson supplied as bare `{ id, text }` (older callers) read from its text
 * alone: no conditions, operator approval as the store's legacy default, and
 * command roles from the wording rules.
 */
export function asKeptLesson(lesson: { id: string; text: string } & Partial<KeptLesson>): KeptLesson {
	if (
		lesson.commands !== undefined &&
		lesson.paths !== undefined &&
		lesson.revision !== undefined &&
		lesson.approval !== undefined &&
		lesson.appliesWhen !== undefined &&
		lesson.avoidWhen !== undefined &&
		lesson.evidenceRefs !== undefined
	)
		return lesson as KeptLesson;
	return projectKeptLesson({
		id: lesson.id,
		scope: "repo",
		key: lesson.id,
		lesson: lesson.text,
		evidenceRefs: [...(lesson.evidenceRefs ?? [])],
		appliesWhen: [...(lesson.appliesWhen ?? [])],
		avoidWhen: [...(lesson.avoidWhen ?? [])],
		confidence: 1,
		createdAt: new Date(0).toISOString(),
		approved: true,
		...(lesson.approval === "automatic" ? { approval: { by: "guardian" as const, at: new Date(0).toISOString() } } : {}),
	});
}

/** How a reminder names who stands behind a lesson. */
export function keptLessonLabel(lesson: KeptLesson): string {
	if (lesson.approval === "operator") return "operator-approved";
	return lesson.evidenceRefs.length > 0 ? "retained automatically from execution evidence" : "retained automatically";
}

/** One reminder line: the claim with its provenance and the conditions stored beside it. */
export function renderKeptLesson(lesson: KeptLesson): string {
	const conditions = [
		lesson.appliesWhen.length ? ` Applies when: ${lesson.appliesWhen.map(compact).join("; ")}.` : "",
		lesson.avoidWhen.length ? ` Avoid when: ${lesson.avoidWhen.map(compact).join("; ")}.` : "",
	].join("");
	return `Memory: [${lesson.id}] (${keptLessonLabel(lesson)}) ${compact(lesson.text)}${conditions}`;
}

export interface KeptLessonSource {
	/** Approved lessons for the repository the workspace belongs to; empty outside a repository. */
	lessons(workspaceRoot: string): readonly KeptLesson[];
}

/**
 * Reads the store only when its file identity changes, and projects only when
 * its content revision or the workspace's repository authority does. An
 * unreadable store yields no lessons; the session continues without them.
 */
export function createKeptLessonSource(dataDir: () => string): KeptLessonSource {
	let file: { path: string; stamp: string; revision: string; records: readonly MemoryRecord[] } | null = null;
	let projected: { key: string; lessons: readonly KeptLesson[] } | null = null;
	const repositories = new Map<string, string | null>();
	const repositoryKey = (root: string): string | null => {
		if (!repositories.has(root)) {
			if (repositories.size >= 32) repositories.delete(repositories.keys().next().value ?? "");
			repositories.set(root, canonicalMemoryRepositoryIdentity(root)?.key ?? null);
		}
		return repositories.get(root) ?? null;
	};
	return {
		lessons(workspaceRoot) {
			const root = dataDir();
			const path = memoryStorePath(root);
			let stamp = "missing";
			try {
				const info = statSync(path);
				stamp = `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}`;
			} catch {
				/* A missing store has no lessons; the stamp still keys the empty read. */
			}
			try {
				if (file?.path !== path || file.stamp !== stamp) {
					const snapshot = readMemoryStoreSnapshot(root);
					file = { path, stamp, revision: snapshot.revision, records: snapshot.records };
				}
			} catch {
				file = null;
				projected = null;
				return [];
			}
			const repository = repositoryKey(workspaceRoot);
			if (repository === null) return [];
			const key = JSON.stringify([path, file.revision, repository]);
			if (projected?.key !== key) {
				const eligible = eligibleMemoryRecords(file.records, {
					scopes: ["repo"],
					activeRepository: { kind: "canonical-path", key: repository },
				});
				projected = { key, lessons: Object.freeze(eligible.map(projectKeptLesson)) };
			}
			return projected.lessons;
		},
	};
}

function compact(value: string): string {
	return value.replace(/\s+/gu, " ").trim();
}
