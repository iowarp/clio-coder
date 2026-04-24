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
 *   - current.jsonl is opened in "a" mode; each append fsyncs the fd.
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
	turns(): ReadonlyArray<ClioTurnRecord>;
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

function readTurnsFile(path: string): ClioTurnRecord[] {
	if (!existsSync(path)) return [];
	const raw = readFileSync(path, "utf8");
	const out: ClioTurnRecord[] = [];
	for (const line of raw.split("\n")) {
		if (line.length === 0) continue;
		out.push(JSON.parse(line) as ClioTurnRecord);
	}
	return out;
}

function readTreeFile(path: string): SessionTreeNode[] {
	if (!existsSync(path)) return [];
	const raw = readFileSync(path, "utf8");
	if (raw.trim().length === 0) return [];
	return JSON.parse(raw) as SessionTreeNode[];
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

function createWriter(meta: ClioSessionMeta, initialTree: SessionTreeNode[]): ClioSessionWriter {
	const paths = sessionPaths(meta);
	let fd: number | null = openSync(paths.current, "a");
	const tree: SessionTreeNode[] = [...initialTree];
	let closed = false;

	return {
		append(turn: ClioTurnRecord): void {
			if (closed || fd === null) throw new Error("session writer closed");
			const line = `${JSON.stringify(turn)}\n`;
			writeSync(fd, line);
			fsyncSync(fd);
			tree.push({
				id: turn.id,
				parentId: turn.parentId,
				at: turn.at,
				kind: turn.kind,
			});
		},
		appendEntry(entry: unknown, opts?: { treeNode?: SessionTreeNode }): void {
			if (closed || fd === null) throw new Error("session writer closed");
			const line = `${JSON.stringify(entry)}\n`;
			writeSync(fd, line);
			fsyncSync(fd);
			if (opts?.treeNode) tree.push(opts.treeNode);
		},
		async persistTree(): Promise<void> {
			atomicWrite(paths.tree, JSON.stringify(tree, null, 2));
		},
		async close(): Promise<void> {
			if (closed) return;
			closed = true;
			if (fd !== null) {
				try {
					fsyncSync(fd);
				} finally {
					closeSync(fd);
					fd = null;
				}
			}
			atomicWrite(paths.tree, JSON.stringify(tree, null, 2));
			const ended: ClioSessionMeta = { ...meta, endedAt: new Date().toISOString() };
			atomicWrite(paths.meta, JSON.stringify(ended, null, 2));
			meta.endedAt = ended.endedAt;
		},
	};
}

export function createSession(input: { cwd: string; model?: string | null; endpoint?: string | null }): {
	meta: ClioSessionMeta;
	writer: ClioSessionWriter;
} {
	const meta = buildMeta(input);
	const paths = sessionPaths(meta);
	atomicWrite(paths.meta, JSON.stringify(meta, null, 2));
	// touch current.jsonl so the file exists even if no turns land before crash
	closeSync(openSync(paths.current, "a"));
	atomicWrite(paths.tree, "[]");
	const writer = createWriter(meta, []);
	return { meta, writer };
}

export function openSession(id: string): ClioSessionReader {
	const dir = findSessionDir(id);
	const metaPath = join(dir, "meta.json");
	const meta = readMetaFile(metaPath);
	const turns = readTurnsFile(join(dir, "current.jsonl"));
	const tree = readTreeFile(join(dir, "tree.json"));
	return {
		meta(): ClioSessionMeta {
			return meta;
		},
		turns(): ReadonlyArray<ClioTurnRecord> {
			return turns;
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
	const existingTree = readTreeFile(join(dir, "tree.json"));
	const writer = createWriter(meta, existingTree);
	return { meta, writer };
}
