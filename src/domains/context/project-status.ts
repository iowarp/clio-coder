/** Demand-only current evidence. Never folded into the project snapshot or assistant summaries. */
import { execFile } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { createUserTasksStore, USER_TASKS_RELATIVE_PATH } from "../user-tasks/store.js";
import type { Codewiki } from "./codewiki/schema.js";
import type { Fingerprint } from "./fingerprint.js";
import { buildProjectOrientation, orientationInputsMatch, orientationKnownInputsMatch } from "./orientation.js";
import { readClioState } from "./state.js";

const exec = promisify(execFile);

export async function readProjectStatus(
	cwd: string,
	current?: { codewiki: Codewiki; fingerprint: Fingerprint },
): Promise<Record<string, unknown>> {
	const observedAt = new Date().toISOString();
	const state = readClioState(cwd);
	const orientation = current ? buildProjectOrientation(cwd, current.codewiki, current.fingerprint) : state?.orientation;
	let git: Record<string, unknown> = { state: "unknown" };
	try {
		const [head, branch, status] = await Promise.all([
			exec("git", ["rev-parse", "--verify", "HEAD"], { cwd, timeout: 5_000 }),
			exec("git", ["symbolic-ref", "--quiet", "--short", "HEAD"], { cwd, timeout: 5_000 }).catch(() => null),
			exec("git", ["status", "--porcelain=v1", "-z", "--untracked-files=normal"], {
				cwd,
				timeout: 5_000,
				maxBuffer: 64 * 1024,
			}),
		]);
		git = {
			state: "observed",
			source: "git HEAD / symbolic-ref / status --porcelain=v1 -z",
			head: head.stdout.trim(),
			branch: branch?.stdout.trim() ?? null,
			porcelain: status.stdout.split("\0").filter(Boolean).slice(0, 24),
			statusRecords: status.stdout.split("\0").filter(Boolean).length,
			statusTruncated: status.stdout.split("\0").filter(Boolean).length > 24,
		};
	} catch {
		/* An unavailable or oversized Git observation remains unknown. */
	}
	let tasks: Record<string, unknown> = { state: "absent", source: USER_TASKS_RELATIVE_PATH };
	try {
		const path = join(cwd, USER_TASKS_RELATIVE_PATH);
		if (existsSync(path)) {
			const store = createUserTasksStore({
				cwd,
				read: (file) => {
					if (statSync(file).size > 64 * 1024) throw new Error("operator task store exceeds observation limit");
					return readFileSync(file, "utf8");
				},
				write: () => {
					throw new Error("project status is read-only");
				},
			});
			const snapshot = store.snapshot();
			tasks = {
				state: "observed",
				source: USER_TASKS_RELATIVE_PATH,
				total: snapshot.length,
				shown: snapshot.slice(0, 12).map((task) => ({
					id: task.id,
					title: task.title.slice(0, 240),
					status: task.status,
					updatedAt: task.updatedAt,
					...(task.note ? { note: task.note.slice(0, 400) } : {}),
					...(task.acceptance ? { acceptanceSource: `${USER_TASKS_RELATIVE_PATH}: task ${task.id} acceptance` } : {}),
					...(task.handedSessionId ? { sessionId: task.handedSessionId, boardTaskId: task.boardTaskId } : {}),
				})),
			};
		}
	} catch {
		tasks = { state: "unknown", source: USER_TASKS_RELATIVE_PATH, reason: "malformed, unreadable, or oversized" };
	}
	return {
		observedAt,
		orientation: orientation
			? {
					...orientation,
					freshness: orientationInputsMatch(cwd, orientation)
						? "recorded snapshot; manifests match"
						: orientationKnownInputsMatch(cwd, orientation)
							? "recorded snapshot; manifest coverage partial (unknown inputs)"
							: "stale or different workspace",
				}
			: null,
		git,
		operatorTasks: tasks,
		interpretation:
			"Manifest purpose is declared identity, not an operator acceptance contract. Operator task status is a store observation, not proof of passing checks. No global blocker or completion inference is made. Session task boards, decisions, and verification receipts remain owned by their sessions; use tasks action=list and inspect linked session/evidence stores. Snapshot paths are candidates: inspect current source before editing.",
	};
}
