import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CLIO_PROJECT_DIR } from "../../core/artifact-paths.js";
import { atomicWrite } from "../../engine/session.js";

export const USER_TASKS_FILE_VERSION = 1 as const;
export const USER_TASKS_RELATIVE_PATH = `${CLIO_PROJECT_DIR}/user-tasks.json`;

export type UserTaskStatus = "open" | "handed" | "picked" | "done" | "dropped";

export interface UserTask {
	id: string;
	title: string;
	note?: string;
	status: UserTaskStatus;
	createdAt: string;
	updatedAt: string;
	handedSessionId?: string;
	boardTaskId?: string;
}

interface UserTasksFile {
	version: typeof USER_TASKS_FILE_VERSION;
	nextId: number;
	tasks: UserTask[];
}

export interface UserTasksStoreDeps {
	cwd: string;
	now?: () => Date;
	exists?: (path: string) => boolean;
	read?: (path: string) => string;
	write?: (path: string, body: string) => void;
}

export interface UserTasksStore {
	readonly path: string;
	snapshot(): ReadonlyArray<UserTask>;
	get(id: string): UserTask | null;
	add(title: string, note?: string): UserTask;
	hand(id: string, sessionId?: string): UserTask;
	done(id: string): UserTask;
	drop(id: string): UserTask;
}

export class UserTasksStoreError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "UserTasksStoreError";
	}
}

const USER_TASK_STATUSES: ReadonlyArray<UserTaskStatus> = ["open", "handed", "picked", "done", "dropped"];
const FILE_KEYS = new Set(["version", "nextId", "tasks"]);
const TASK_KEYS = new Set([
	"id",
	"title",
	"note",
	"status",
	"createdAt",
	"updatedAt",
	"handedSessionId",
	"boardTaskId",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
	return Object.keys(value).every((key) => allowed.has(key));
}

function isOptionalString(value: unknown): boolean {
	return value === undefined || typeof value === "string";
}

function isUserTask(value: unknown): value is UserTask {
	if (!isRecord(value) || !hasOnlyKeys(value, TASK_KEYS)) return false;
	return (
		typeof value.id === "string" &&
		/^u[1-9]\d*$/.test(value.id) &&
		typeof value.title === "string" &&
		value.title.trim().length > 0 &&
		typeof value.status === "string" &&
		USER_TASK_STATUSES.includes(value.status as UserTaskStatus) &&
		typeof value.createdAt === "string" &&
		typeof value.updatedAt === "string" &&
		isOptionalString(value.note) &&
		isOptionalString(value.handedSessionId) &&
		isOptionalString(value.boardTaskId)
	);
}

function parseFile(body: string, path: string): UserTasksFile {
	let parsed: unknown;
	try {
		parsed = JSON.parse(body);
	} catch (error) {
		throw new UserTasksStoreError(`user tasks file is corrupt JSON: ${path}`, { cause: error });
	}
	if (!isRecord(parsed) || !hasOnlyKeys(parsed, FILE_KEYS)) {
		throw new UserTasksStoreError(`user tasks file has an invalid top-level shape: ${path}`);
	}
	if (
		parsed.version !== USER_TASKS_FILE_VERSION ||
		!Number.isSafeInteger(parsed.nextId) ||
		(parsed.nextId as number) < 1 ||
		!Array.isArray(parsed.tasks) ||
		!parsed.tasks.every(isUserTask)
	) {
		throw new UserTasksStoreError(`user tasks file failed schema validation: ${path}`);
	}
	const ids = new Set<string>();
	let maxId = 0;
	for (const task of parsed.tasks) {
		if (ids.has(task.id)) throw new UserTasksStoreError(`user tasks file contains duplicate id ${task.id}: ${path}`);
		ids.add(task.id);
		maxId = Math.max(maxId, Number(task.id.slice(1)));
	}
	if ((parsed.nextId as number) <= maxId) {
		throw new UserTasksStoreError(`user tasks file nextId would reuse an existing id: ${path}`);
	}
	return {
		version: USER_TASKS_FILE_VERSION,
		nextId: parsed.nextId as number,
		tasks: parsed.tasks.map(copyTask),
	};
}

function copyTask(task: UserTask): UserTask {
	return { ...task };
}

function initialFile(): UserTasksFile {
	return { version: USER_TASKS_FILE_VERSION, nextId: 1, tasks: [] };
}

export function createUserTasksStore(deps: UserTasksStoreDeps): UserTasksStore {
	const path = join(deps.cwd, USER_TASKS_RELATIVE_PATH);
	const exists = deps.exists ?? existsSync;
	const read = deps.read ?? ((target: string) => readFileSync(target, "utf8"));
	const write = deps.write ?? ((target: string, body: string) => atomicWrite(target, body));
	const now = (): string => (deps.now?.() ?? new Date()).toISOString();

	const load = (): UserTasksFile => {
		if (!exists(path)) return initialFile();
		try {
			return parseFile(read(path), path);
		} catch (error) {
			if (error instanceof UserTasksStoreError) throw error;
			throw new UserTasksStoreError(`could not read user tasks file: ${path}`, { cause: error });
		}
	};

	const save = (file: UserTasksFile): void => {
		try {
			write(path, `${JSON.stringify(file, null, 2)}\n`);
		} catch (error) {
			throw new UserTasksStoreError(`could not write user tasks file: ${path}`, { cause: error });
		}
	};

	const mutate = (
		id: string,
		allowed: ReadonlyArray<UserTaskStatus>,
		status: UserTaskStatus,
		sessionId?: string,
	): UserTask => {
		const file = load();
		const index = file.tasks.findIndex((task) => task.id === id);
		const current = file.tasks[index];
		if (!current) throw new UserTasksStoreError(`operator task ${id} was not found`);
		if (!allowed.includes(current.status)) {
			throw new UserTasksStoreError(`operator task ${id} is ${current.status}; it cannot move to ${status}`);
		}
		const updated: UserTask = { ...current, status, updatedAt: now() };
		if (status === "handed" && sessionId) updated.handedSessionId = sessionId;
		file.tasks[index] = updated;
		save(file);
		return copyTask(updated);
	};

	return {
		path,
		snapshot(): ReadonlyArray<UserTask> {
			return load().tasks.map(copyTask);
		},
		get(id: string): UserTask | null {
			const task = load().tasks.find((candidate) => candidate.id === id);
			return task ? copyTask(task) : null;
		},
		add(title: string, note?: string): UserTask {
			const normalizedTitle = title.trim();
			if (normalizedTitle.length === 0) throw new UserTasksStoreError("operator task title cannot be empty");
			const normalizedNote = note?.trim();
			const file = load();
			const timestamp = now();
			const task: UserTask = {
				id: `u${file.nextId}`,
				title: normalizedTitle,
				...(normalizedNote ? { note: normalizedNote } : {}),
				status: "open",
				createdAt: timestamp,
				updatedAt: timestamp,
			};
			file.nextId += 1;
			file.tasks.push(task);
			save(file);
			return copyTask(task);
		},
		hand(id: string, sessionId?: string): UserTask {
			return mutate(id, ["open"], "handed", sessionId);
		},
		done(id: string): UserTask {
			return mutate(id, ["open", "handed", "picked"], "done");
		},
		drop(id: string): UserTask {
			return mutate(id, ["open", "handed", "picked"], "dropped");
		},
	};
}
