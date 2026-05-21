/**
 * Clio session JSONL writer + reader (Phase 3 slice 1).
 *
 * On-disk layout under `clioDataDir()`:
 *   sessions/<cwdHash>/<sessionId>/
 *     meta.json      ClioSessionMeta
 *     current.jsonl  append-only ClioTurnRecord per line
 *     tree.json      [{id, parentId, at, kind}, ...]
 *
 * Atomicity:
 *   - current.jsonl is rewritten via `writeJsonlFileAtomic` (`.tmp` + fsync + rename).
 *   - tree.json and meta.json are written via `atomicWrite` (tmp + fsync + rename).
 *
 * This module sits in `src/engine/` because it is the engine's artifact
 * contract with the session domain, but it imports no pi-mono packages.
 * It is pure node: fs, path, crypto.
 */

import { createHash, randomBytes } from "node:crypto";
import {
	closeSync,
	existsSync,
	fsyncSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	renameSync,
	statSync,
	writeSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { readClioVersion, readPiMonoVersion } from "../core/package-root.js";
import { clioDataDir } from "../core/xdg.js";

export interface ClioSessionMeta {
	id: string;
	cwd: string;
	cwdHash: string;
	createdAt: string;
	endedAt: string | null;
	model: string | null;
	endpoint: string | null;
	compiledPromptHash: string | null;
	staticCompositionHash: string | null;
	clioVersion: string;
	piMonoVersion: string;
	platform: string;
	nodeVersion: string;
	/**
	 * v2 on every new session. v1 files on disk omit the field; readers
	 * treat missing as 1 and run the migration chain in
	 * src/domains/session/migrations on resume. Bumped by a future
	 * migration when the entry-union vocabulary changes again.
	 */
	sessionFormatVersion?: number;
}

export const CURRENT_SESSION_FORMAT_VERSION = 2;

export interface ClioSessionJsonlHeader {
	type: "session";
	version: number;
	id: string;
	timestamp: string;
	cwd: string;
	parentSession?: string;
	parentTurnId?: string;
}

export interface ClioTurnRecord {
	id: string;
	parentId: string | null;
	at: string;
	kind: "user" | "assistant" | "tool_call" | "tool_result" | "system" | "checkpoint";
	payload: unknown;
	dynamicInputs?: unknown;
	renderedPromptHash?: string;
}

export interface SessionTreeNode {
	id: string;
	parentId: string | null;
	at: string;
	kind: ClioTurnRecord["kind"];
}

export interface ClioSessionFile {
	current: string;
	tree: string;
	meta: string;
}

export interface ClioSessionWriter {
	append(turn: ClioTurnRecord): void;
	/**
	 * Write a pre-composed rich session entry as a JSON line. Unlike
	 * `append`, this does not project into the tree. Callers that need a
	 * tree node pass one via `treeNode`; Phase 12a leaves non-message
	 * entries off the tree and revisits in 12b when /fork lands.
	 */
	appendEntry(entry: unknown, opts?: { treeNode?: SessionTreeNode }): void;
	persistTree(): Promise<void>;
	close(): Promise<void>;
}

export interface ClioSessionReader {
	meta(): ClioSessionMeta;
	turns(): ReadonlyArray<unknown>;
	fileEntries(): ReadonlyArray<unknown>;
	header(): ClioSessionJsonlHeader | null;
	tree(): ReadonlyArray<SessionTreeNode>;
}

export function cwdHash(cwd: string): string {
	const normalized = resolve(cwd);
	return createHash("sha256").update(normalized).digest("hex").slice(0, 16);
}

export function sessionPaths(meta: ClioSessionMeta): ClioSessionFile {
	const dir = join(clioDataDir(), "sessions", meta.cwdHash, meta.id);
	mkdirSync(dir, { recursive: true });
	return {
		current: join(dir, "current.jsonl"),
		tree: join(dir, "tree.json"),
		meta: join(dir, "meta.json"),
	};
}

export function atomicWrite(targetPath: string, contents: string | Uint8Array): void {
	const dir = dirname(targetPath);
	mkdirSync(dir, { recursive: true });
	const suffix = randomBytes(6).toString("hex");
	const tmp = `${targetPath}.tmp-${suffix}`;
	const fd = openSync(tmp, "w");
	try {
		if (typeof contents === "string") {
			writeSync(fd, contents);
		} else {
			writeSync(fd, contents);
		}
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
	renameSync(tmp, targetPath);
	fsyncDirectory(dir);
}

export interface SessionJsonlWarning {
	path: string;
	line: number;
	message: string;
}

export type SessionJsonlWarningSink = (warning: SessionJsonlWarning) => void;

export interface SessionJsonlReadOptions {
	onWarning?: SessionJsonlWarningSink;
}

export interface SessionJsonlWriteOptions {
	beforeRename?: (tmpPath: string, targetPath: string) => void;
}

function defaultSessionJsonlWarning(warning: SessionJsonlWarning): void {
	process.stderr.write(`[clio:session] ${warning.path}:${warning.line}: ${warning.message}\n`);
}

function fsyncDirectory(path: string): void {
	let fd: number | null = null;
	try {
		fd = openSync(path, "r");
		fsyncSync(fd);
	} catch {
		// Some filesystems/platforms reject directory fsync. The temp-file
		// fsync + rename still preserves the important no-torn-file property.
	} finally {
		if (fd !== null) closeSync(fd);
	}
}

function serializeJsonl(entries: ReadonlyArray<unknown>): string {
	if (entries.length === 0) return "";
	const lines = entries.map((entry, index) => {
		const serialized = JSON.stringify(entry);
		if (serialized === undefined) {
			throw new Error(`session JSONL entry ${index + 1} is not serializable`);
		}
		return serialized;
	});
	return `${lines.join("\n")}\n`;
}

/**
 * Rewrite a JSONL file through `<target>.tmp` and rename over the target.
 * A crash or interruption before the rename leaves the original target
 * untouched; when no target exists yet, recovery readers can promote the tmp.
 */
export function writeJsonlFileAtomic(
	targetPath: string,
	entries: ReadonlyArray<unknown>,
	options: SessionJsonlWriteOptions = {},
): void {
	const dir = dirname(targetPath);
	mkdirSync(dir, { recursive: true });
	const body = serializeJsonl(entries);
	const tmp = `${targetPath}.tmp`;
	const fd = openSync(tmp, "w");
	try {
		writeSync(fd, body);
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
	options.beforeRename?.(tmp, targetPath);
	renameSync(tmp, targetPath);
	fsyncDirectory(dir);
}

function recoverJsonlTargetIfMissing(targetPath: string): string | null {
	if (existsSync(targetPath)) return targetPath;
	const tmp = `${targetPath}.tmp`;
	try {
		if (!statSync(tmp).isFile()) return null;
		renameSync(tmp, targetPath);
		fsyncDirectory(dirname(targetPath));
		return targetPath;
	} catch {
		return existsSync(targetPath) ? targetPath : existsSync(tmp) ? tmp : null;
	}
}

export function readSessionFileEntries(path: string, options: SessionJsonlReadOptions = {}): unknown[] {
	const readPath = recoverJsonlTargetIfMissing(path);
	if (readPath === null) return [];
	const raw = readFileSync(readPath, "utf8");
	const entries: unknown[] = [];
	const warn = options.onWarning ?? defaultSessionJsonlWarning;
	const lines = raw.split("\n");
	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index] ?? "";
		if (line.trim().length === 0) continue;
		try {
			entries.push(JSON.parse(line) as unknown);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			warn({ path: readPath, line: index + 1, message: `invalid JSON skipped: ${message}` });
		}
	}
	return entries;
}

function isPositiveInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function isOptionalString(value: unknown): boolean {
	return value === undefined || typeof value === "string";
}

function isSessionJsonlHeader(value: unknown): value is ClioSessionJsonlHeader {
	if (!value || typeof value !== "object") return false;
	const v = value as Record<string, unknown>;
	return (
		v.type === "session" &&
		isPositiveInteger(v.version) &&
		typeof v.id === "string" &&
		typeof v.timestamp === "string" &&
		typeof v.cwd === "string" &&
		isOptionalString(v.parentSession) &&
		isOptionalString(v.parentTurnId)
	);
}

function sessionHeaderFromMeta(
	meta: ClioSessionMeta,
	options: { parentSession?: string; parentTurnId?: string } = {},
): ClioSessionJsonlHeader {
	const header: ClioSessionJsonlHeader = {
		type: "session",
		version: CURRENT_SESSION_FORMAT_VERSION,
		id: meta.id,
		timestamp: meta.createdAt,
		cwd: meta.cwd,
	};
	if (options.parentSession !== undefined) header.parentSession = options.parentSession;
	if (options.parentTurnId !== undefined) header.parentTurnId = options.parentTurnId;
	return header;
}

function ensureSessionHeader(
	meta: ClioSessionMeta,
	entries: ReadonlyArray<unknown>,
	options: { parentSession?: string; parentTurnId?: string } = {},
): unknown[] {
	const first = entries[0];
	if (isSessionJsonlHeader(first)) return [...entries];
	return [sessionHeaderFromMeta(meta, options), ...entries];
}

function recordFromTurn(turn: ClioTurnRecord): unknown {
	const entry: Record<string, unknown> = {
		kind: "message",
		turnId: turn.id,
		parentTurnId: turn.parentId,
		timestamp: turn.at,
		role: turn.kind,
		payload: turn.payload,
	};
	if (turn.dynamicInputs !== undefined) entry.dynamicInputs = turn.dynamicInputs;
	if (turn.renderedPromptHash !== undefined) entry.renderedPromptHash = turn.renderedPromptHash;
	return entry;
}

function newTurnId(): string {
	const n = BigInt(`0x${randomBytes(8).toString("hex")}`);
	const raw = n.toString(36);
	if (raw.length >= 12) return raw.slice(0, 12);
	return raw.padStart(12, "0");
}

function buildMeta(input: { cwd: string; model?: string | null; endpoint?: string | null }): ClioSessionMeta {
	const resolvedCwd = resolve(input.cwd);
	return {
		id: newTurnId(),
		cwd: resolvedCwd,
		cwdHash: cwdHash(resolvedCwd),
		createdAt: new Date().toISOString(),
		endedAt: null,
		model: input.model ?? null,
		endpoint: input.endpoint ?? null,
		compiledPromptHash: null,
		staticCompositionHash: null,
		clioVersion: readClioVersion(),
		piMonoVersion: readPiMonoVersion(),
		platform: process.platform,
		nodeVersion: process.version,
		sessionFormatVersion: CURRENT_SESSION_FORMAT_VERSION,
	};
}

function readMetaFile(path: string): ClioSessionMeta {
	const raw = readFileSync(path, "utf8");
	return JSON.parse(raw) as ClioSessionMeta;
}

const TURN_KINDS: readonly ClioTurnRecord["kind"][] = [
	"user",
	"assistant",
	"tool_call",
	"tool_result",
	"system",
	"checkpoint",
];

function isTurnKind(value: unknown): value is ClioTurnRecord["kind"] {
	return typeof value === "string" && (TURN_KINDS as readonly string[]).includes(value);
}

function nullableString(value: unknown): value is string | null {
	return value === null || typeof value === "string";
}

function isSessionTreeNode(value: unknown): value is SessionTreeNode {
	if (!value || typeof value !== "object") return false;
	const node = value as Record<string, unknown>;
	return (
		typeof node.id === "string" && nullableString(node.parentId) && typeof node.at === "string" && isTurnKind(node.kind)
	);
}

function readTreeFile(path: string): SessionTreeNode[] {
	if (!existsSync(path)) return [];
	try {
		const raw = readFileSync(path, "utf8");
		if (raw.trim().length === 0) return [];
		const parsed = JSON.parse(raw) as unknown;
		if (!Array.isArray(parsed)) return [];
		return parsed.filter(isSessionTreeNode);
	} catch {
		return [];
	}
}

function treeNodeFromFileEntry(entry: unknown): SessionTreeNode | null {
	if (!entry || typeof entry !== "object" || isSessionJsonlHeader(entry)) return null;
	const value = entry as Record<string, unknown>;
	if (
		typeof value.id === "string" &&
		nullableString(value.parentId) &&
		typeof value.at === "string" &&
		isTurnKind(value.kind) &&
		Object.hasOwn(value, "payload")
	) {
		return { id: value.id, parentId: value.parentId, at: value.at, kind: value.kind };
	}
	if (
		value.kind === "message" &&
		typeof value.turnId === "string" &&
		nullableString(value.parentTurnId) &&
		typeof value.timestamp === "string" &&
		isTurnKind(value.role) &&
		Object.hasOwn(value, "payload")
	) {
		return { id: value.turnId, parentId: value.parentTurnId, at: value.timestamp, kind: value.role };
	}
	return null;
}

function treeFromFileEntries(fileEntries: ReadonlyArray<unknown>): SessionTreeNode[] {
	const nodes: SessionTreeNode[] = [];
	for (const entry of fileEntries) {
		const node = treeNodeFromFileEntry(entry);
		if (node) nodes.push(node);
	}
	return nodes;
}

function sameTreeNode(a: SessionTreeNode | undefined, b: SessionTreeNode): boolean {
	return !!a && a.id === b.id && a.parentId === b.parentId && a.at === b.at && a.kind === b.kind;
}

function sameTree(a: ReadonlyArray<SessionTreeNode>, b: ReadonlyArray<SessionTreeNode>): boolean {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i += 1) {
		const left = a[i];
		const right = b[i];
		if (!left || !right || !sameTreeNode(left, right)) return false;
	}
	return true;
}

function recoverTreeFromJsonl(diskTree: SessionTreeNode[], fileEntries: ReadonlyArray<unknown>): SessionTreeNode[] {
	const recovered = treeFromFileEntries(fileEntries);
	if (recovered.length === 0) return diskTree;
	return sameTree(diskTree, recovered) ? diskTree : recovered;
}

function findSessionDir(id: string): string {
	const sessionsRoot = join(clioDataDir(), "sessions");
	if (!existsSync(sessionsRoot)) {
		throw new Error(`session not found: ${id}`);
	}
	for (const entry of readdirSync(sessionsRoot, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		const candidate = join(sessionsRoot, entry.name, id);
		if (existsSync(candidate) && statSync(candidate).isDirectory()) {
			return candidate;
		}
	}
	throw new Error(`session not found: ${id}`);
}

function createWriter(
	meta: ClioSessionMeta,
	initialTree: SessionTreeNode[],
	initialFileEntries: ReadonlyArray<unknown>,
	headerOptions: { parentSession?: string; parentTurnId?: string } = {},
): ClioSessionWriter {
	const paths = sessionPaths(meta);
	const tree: SessionTreeNode[] = [...initialTree];
	const fileEntries = ensureSessionHeader(meta, initialFileEntries, headerOptions);
	let closed = false;

	return {
		append(turn: ClioTurnRecord): void {
			if (closed) throw new Error("session writer closed");
			const record = recordFromTurn(turn);
			const nextEntries = [...fileEntries, record];
			writeJsonlFileAtomic(paths.current, nextEntries);
			fileEntries.push(record);
			tree.push({
				id: turn.id,
				parentId: turn.parentId,
				at: turn.at,
				kind: turn.kind,
			});
		},
		appendEntry(entry: unknown, opts?: { treeNode?: SessionTreeNode }): void {
			if (closed) throw new Error("session writer closed");
			const nextEntries = [...fileEntries, entry];
			writeJsonlFileAtomic(paths.current, nextEntries);
			fileEntries.push(entry);
			if (opts?.treeNode) tree.push(opts.treeNode);
		},
		async persistTree(): Promise<void> {
			atomicWrite(paths.tree, JSON.stringify(tree, null, 2));
		},
		async close(): Promise<void> {
			if (closed) return;
			writeJsonlFileAtomic(paths.current, fileEntries);
			atomicWrite(paths.tree, JSON.stringify(tree, null, 2));
			const ended: ClioSessionMeta = { ...meta, endedAt: new Date().toISOString() };
			atomicWrite(paths.meta, JSON.stringify(ended, null, 2));
			meta.endedAt = ended.endedAt;
			closed = true;
		},
	};
}

export function createSession(input: {
	cwd: string;
	model?: string | null;
	endpoint?: string | null;
	initialEntries?: ReadonlyArray<unknown>;
	initialTree?: ReadonlyArray<SessionTreeNode>;
	parentSession?: string;
	parentTurnId?: string;
}): {
	meta: ClioSessionMeta;
	writer: ClioSessionWriter;
} {
	const meta = buildMeta(input);
	const paths = sessionPaths(meta);
	atomicWrite(paths.meta, JSON.stringify(meta, null, 2));
	const headerOptions: { parentSession?: string; parentTurnId?: string } = {};
	if (input.parentSession !== undefined) headerOptions.parentSession = input.parentSession;
	if (input.parentTurnId !== undefined) headerOptions.parentTurnId = input.parentTurnId;
	const initialEntries = ensureSessionHeader(meta, input.initialEntries ?? [], headerOptions);
	const initialTree = [...(input.initialTree ?? [])];
	writeJsonlFileAtomic(paths.current, initialEntries);
	atomicWrite(paths.tree, JSON.stringify(initialTree, null, 2));
	const writer = createWriter(meta, initialTree, initialEntries, headerOptions);
	return { meta, writer };
}

export function openSession(id: string): ClioSessionReader {
	const dir = findSessionDir(id);
	const metaPath = join(dir, "meta.json");
	const meta = readMetaFile(metaPath);
	const currentPath = join(dir, "current.jsonl");
	const fileEntries = readSessionFileEntries(currentPath);
	const turns = fileEntries.filter((entry) => !isSessionJsonlHeader(entry));
	const header = fileEntries.find(isSessionJsonlHeader) ?? null;
	const tree = recoverTreeFromJsonl(readTreeFile(join(dir, "tree.json")), fileEntries);
	return {
		meta(): ClioSessionMeta {
			return meta;
		},
		turns(): ReadonlyArray<unknown> {
			return turns;
		},
		fileEntries(): ReadonlyArray<unknown> {
			return fileEntries;
		},
		header(): ClioSessionJsonlHeader | null {
			return header;
		},
		tree(): ReadonlyArray<SessionTreeNode> {
			return tree;
		},
	};
}

export function resumeSession(id: string): { meta: ClioSessionMeta; writer: ClioSessionWriter } {
	const dir = findSessionDir(id);
	const metaPath = join(dir, "meta.json");
	const meta = readMetaFile(metaPath);
	// resume reopens an active session; clear endedAt if it was set by a prior close
	if (meta.endedAt !== null) {
		meta.endedAt = null;
		atomicWrite(metaPath, JSON.stringify(meta, null, 2));
	}
	const existingFileEntries = readSessionFileEntries(join(dir, "current.jsonl"));
	const existingTree = recoverTreeFromJsonl(readTreeFile(join(dir, "tree.json")), existingFileEntries);
	const writer = createWriter(meta, existingTree, existingFileEntries);
	return { meta, writer };
}
