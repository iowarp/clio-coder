/**
 * Operator consent for privilege-bearing project files. The settings loader
 * runs before domains start, so this authority store is a core leaf shared by
 * startup and the safety domain. Reading trust never creates state or grants it.
 * Approval pins one surface's captured bytes in one canonical workspace, never
 * a blanket permission for all content in a repository.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { safeResourceWrite } from "./safe-resource-write.js";
import { withStateFileLockSync } from "./state-file-lock.js";
import { taskWorktreeOrigin } from "./task-worktree-claim.js";
import { clioStateDir, clioStatePath, stateRootRemoved } from "./xdg.js";

export type WorkspaceTrustVerdict = "trusted" | "untrusted" | "changed";
export type ProjectTrustSurface = "safety" | "hooks" | "settings" | "extensions" | "plugins";

export interface ProjectSurfaceFile {
	path: string;
	/** Exact captured text, or null for an absent/unreadable file. */
	text: string | null;
	hash: string | null;
	error?: string;
}

export interface ProjectSurfaceSnapshot {
	workspaceRoot: string;
	surface: ProjectTrustSurface;
	files: ProjectSurfaceFile[];
	/** Null if any file could not be read. Missing files are part of the digest. */
	contentHash: string | null;
	verdict: WorkspaceTrustVerdict;
}

interface WorkspaceTrustRecord {
	version: 1;
	workspaceRoot: string;
	surfaces: Partial<Record<ProjectTrustSurface, string>>;
}

const SHA256 = /^[a-f0-9]{64}$/;
const SURFACES: ReadonlyArray<ProjectTrustSurface> = ["safety", "hooks", "settings", "extensions", "plugins"];

function sha256(value: string | Buffer): string {
	return createHash("sha256").update(value).digest("hex");
}

export function workspaceTrustDirectory(): string {
	return join(clioStatePath(), "workspace-trust");
}

function recordPath(canonicalRoot: string): string {
	return join(workspaceTrustDirectory(), `${sha256(canonicalRoot)}.json`);
}

function readRecord(canonicalRoot: string): WorkspaceTrustRecord | null {
	try {
		const raw: unknown = JSON.parse(readFileSync(recordPath(canonicalRoot), "utf8"));
		if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
		const record = raw as Record<string, unknown>;
		if (record.version !== 1 || record.workspaceRoot !== canonicalRoot) return null;
		if (record.surfaces === null || typeof record.surfaces !== "object" || Array.isArray(record.surfaces)) return null;
		const surfaces: WorkspaceTrustRecord["surfaces"] = {};
		for (const surface of SURFACES) {
			const hash = (record.surfaces as Record<string, unknown>)[surface];
			if (hash === undefined) continue;
			if (typeof hash !== "string" || !SHA256.test(hash)) return null;
			surfaces[surface] = hash;
		}
		return { version: 1, workspaceRoot: canonicalRoot, surfaces };
	} catch {
		// Missing, corrupt, or unreadable authority is never implicit consent.
		return null;
	}
}

/** Whether this workspace still carries an operator pin for the named surface. */
export function hasProjectSurfaceTrust(workspaceRoot: string, surface: ProjectTrustSurface): boolean {
	try {
		return readRecord(realpathSync(resolve(workspaceRoot)))?.surfaces[surface] !== undefined;
	} catch {
		// A missing workspace cannot carry consent.
		return false;
	}
}

export function projectSurfaceTrust(
	workspaceRoot: string,
	surface: ProjectTrustSurface,
	contentHash: string,
): WorkspaceTrustVerdict {
	if (!SURFACES.includes(surface) || !SHA256.test(contentHash)) return "untrusted";
	try {
		const root = realpathSync(resolve(workspaceRoot));
		const approved = readRecord(root)?.surfaces[surface];
		return approved === undefined ? "untrusted" : approved === contentHash ? "trusted" : "changed";
	} catch {
		return "untrusted";
	}
}

/** Operator-only writer. Callers must present the reviewed digest, never auto-approve on load. */
export function recordProjectSurfaceTrust(
	workspaceRoot: string,
	surface: ProjectTrustSurface,
	contentHash: string,
): void {
	if (!SURFACES.includes(surface) || !SHA256.test(contentHash)) throw new Error("trust requires a full SHA-256 digest");
	const root = realpathSync(resolve(workspaceRoot));
	if (stateRootRemoved()) throw new Error("Clio state was removed; trust was not recorded");
	clioStateDir();
	withStateFileLockSync(recordPath(root), () => {
		if (stateRootRemoved()) throw new Error("Clio state was removed; trust was not recorded");
		const record = readRecord(root) ?? { version: 1, workspaceRoot: root, surfaces: {} };
		record.surfaces[surface] = contentHash;
		safeResourceWrite(recordPath(root), `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
	});
}

export function revokeProjectSurfaceTrust(workspaceRoot: string, surface: ProjectTrustSurface): void {
	const root = realpathSync(resolve(workspaceRoot));
	if (!readRecord(root) || stateRootRemoved()) return;
	withStateFileLockSync(recordPath(root), () => {
		if (stateRootRemoved()) return;
		const record = readRecord(root);
		if (record === null) return;
		delete record.surfaces[surface];
		safeResourceWrite(recordPath(root), `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
	});
}

function surfacePaths(root: string, surface: ProjectTrustSurface): string[] {
	if (surface === "extensions" || surface === "plugins") {
		// The install state records every project package's content digest and the
		// loaders reverify each tree against it, so this one file's bytes pin the
		// exact set of project packages the operator reviewed.
		return [join(root, ".clio-coder", surface, "state.json")];
	}
	if (surface !== "safety") {
		return [join(root, ".clio-coder", `${surface}.yaml`), join(root, ".clio-coder", `${surface}.local.yaml`)];
	}
	// Match safety policy discovery. An ancestor's policy still needs consent
	// for this workspace; trusting the parent never implicitly trusts a child.
	let cursor = root;
	while (true) {
		const candidate = join(cursor, ".clio-coder", "safety.yaml");
		if (existsSync(candidate)) return [candidate];
		const parent = dirname(cursor);
		if (parent === cursor) return [join(root, ".clio-coder", "safety.yaml")];
		cursor = parent;
	}
}

/** Safety entries resolve relative to their canonical source, so provenance is authority too. */
export function safetySurfaceTrustHash(canonicalSourcePath: string, contentHash: string): string {
	return sha256(JSON.stringify([[resolve(canonicalSourcePath), contentHash]]));
}

/**
 * A task worktree Clio created inherits its origin's approval of the package
 * surfaces while its install state is byte-identical to the origin's approved
 * state. Identical state pins identical content digests, so the worktree runs
 * nothing the operator did not already approve.
 */
function inheritsOriginTrust(snapshot: ProjectSurfaceSnapshot): boolean {
	if (snapshot.surface !== "extensions" && snapshot.surface !== "plugins") return false;
	const hash = snapshot.files[0]?.hash;
	if (hash === undefined || hash === null) return false;
	const origin = taskWorktreeOrigin(snapshot.workspaceRoot);
	if (origin === null) return false;
	const approved = captureOwnProjectSurface(origin, snapshot.surface);
	return approved.verdict === "trusted" && approved.files[0]?.hash === hash;
}

/** Capture once, hash once, and let loaders parse exactly the admitted bytes. */
export function captureProjectSurface(workspaceRoot: string, surface: ProjectTrustSurface): ProjectSurfaceSnapshot {
	const own = captureOwnProjectSurface(workspaceRoot, surface);
	return own.verdict !== "trusted" && inheritsOriginTrust(own) ? { ...own, verdict: "trusted" } : own;
}

function captureOwnProjectSurface(workspaceRoot: string, surface: ProjectTrustSurface): ProjectSurfaceSnapshot {
	let root = resolve(workspaceRoot);
	try {
		root = realpathSync(root);
	} catch {
		// A missing workspace has no authority; keep inspection best-effort.
	}
	const files = surfacePaths(root, surface).map((path): ProjectSurfaceFile => {
		try {
			const capturedPath = surface === "safety" ? realpathSync(path) : path;
			const bytes = readFileSync(capturedPath);
			return { path: capturedPath, text: bytes.toString("utf8"), hash: sha256(bytes) };
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return { path, text: null, hash: null };
			return { path, text: null, hash: null, error: `cannot read ${path}` };
		}
	});
	const contentHash = files.some((file) => file.error !== undefined)
		? null
		: surface === "safety"
			? files[0]?.hash
				? safetySurfaceTrustHash(files[0].path, files[0].hash)
				: null
			: sha256(JSON.stringify(files.map((file) => [file.path, file.hash])));
	return {
		workspaceRoot: root,
		surface,
		files,
		contentHash,
		verdict: contentHash === null ? "untrusted" : projectSurfaceTrust(root, surface, contentHash),
	};
}

/** Whether the operator approved this workspace's project-scoped extensions or plugins. */
export function projectPackagesTrusted(workspaceRoot: string, surface: "extensions" | "plugins"): boolean {
	try {
		return captureProjectSurface(workspaceRoot, surface).verdict === "trusted";
	} catch {
		// Authority that cannot be read is never consent.
		return false;
	}
}

/** Whether the project has no install state yet for this package surface. */
export function projectPackagesHaveNoState(workspaceRoot: string, surface: "extensions" | "plugins"): boolean {
	return !existsSync(join(resolve(workspaceRoot), ".clio-coder", surface, "state.json"));
}

/**
 * The operator's own first install into a project creates that surface's first
 * install state, so the state is theirs to approve. Call it only from an
 * operator install and only when {@link projectPackagesHaveNoState} held
 * before it ran. Archive imports and imports from other tools never call it,
 * and any later install, enable, disable or remove needs `config trust`.
 * Returns whether the new state was approved.
 */
export function approveFirstProjectInstall(workspaceRoot: string, surface: "extensions" | "plugins"): boolean {
	try {
		const snapshot = captureOwnProjectSurface(workspaceRoot, surface);
		if (snapshot.contentHash === null || !snapshot.files.some((file) => file.text !== null)) return false;
		recordProjectSurfaceTrust(snapshot.workspaceRoot, surface, snapshot.contentHash);
		return true;
	} catch {
		// The install already succeeded; without the record the package stays
		// unloaded and the trust notice names the command that approves it.
		return false;
	}
}

export function projectSurfaceTrustNotice(snapshot: ProjectSurfaceSnapshot, filePath: string): string {
	return `${filePath} is ${snapshot.verdict}; project ${snapshot.surface} ignored. Review with clio-coder config trust ${snapshot.surface}.`;
}
