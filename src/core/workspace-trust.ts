/**
 * Operator consent for privilege-bearing project files. The settings loader
 * runs before domains start, so this authority store is a core leaf shared by
 * startup and the safety domain. Reading trust never creates state or grants it.
 * Approval pins one surface's captured bytes in one canonical workspace, never
 * a blanket permission for all content in a repository. Package surfaces pin
 * package identities instead, so reinstalls, disables and removals keep consent.
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

type PackageTrustSurface = "extensions" | "plugins";
/** A digest approves exact bytes; an identity set approves enabled package identities. */
type SurfaceApproval = string | { identities: string[] };

interface WorkspaceTrustRecord {
	workspaceRoot: string;
	surfaces: Partial<Record<ProjectTrustSurface, SurfaceApproval>>;
}

interface PackageIdentities {
	/** Every installed record's identity, enabled or disabled, sorted and unique. */
	all: string[];
	enabled: string[];
	/** Each install-state id's identity, or null when its record pins no content. */
	byId: Map<string, string | null>;
	/** False when a record carries no content digest, so its identity pins no content. */
	pinned: boolean;
}

const SHA256 = /^[a-f0-9]{64}$/;
const SURFACES: ReadonlyArray<ProjectTrustSurface> = ["safety", "hooks", "settings", "extensions", "plugins"];

function sha256(value: string | Buffer): string {
	return createHash("sha256").update(value).digest("hex");
}

function isPackageSurface(surface: ProjectTrustSurface): surface is PackageTrustSurface {
	return surface === "extensions" || surface === "plugins";
}

function isObject(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function canonicalJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	if (isObject(value)) {
		const keys = Object.keys(value).sort();
		return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
	}
	return JSON.stringify(value);
}

/**
 * installedAt and the disabled list stay out of a package identity, so a
 * reinstall of identical content or a disable never asks for consent again.
 * trust stays in, so a project flipping a plugin from foreign to trusted does.
 * envelopeDigest stays in, so a recorded capability envelope change does too.
 * A plugin record's kind stays in, since it moves the package between the
 * extension and plugin precedence namespaces.
 * Returns null for install state that cannot be parsed.
 */
function packageIdentities(surface: PackageTrustSurface, text: string | null): PackageIdentities | null {
	if (text === null) return { all: [], enabled: [], byId: new Map(), pinned: true };
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch {
		return null;
	}
	if (!isObject(raw) || !isObject(raw.installed) || !Array.isArray(raw.disabled)) return null;
	if (!raw.disabled.every((id) => typeof id === "string")) return null;
	const disabled = new Set<unknown>(raw.disabled);
	const all = new Set<string>();
	const enabled: string[] = [];
	const byId = new Map<string, string | null>();
	let pinned = true;
	for (const [id, entry] of Object.entries(raw.installed)) {
		if (!isObject(entry)) return null;
		if (entry.contentDigest === undefined) pinned = false;
		else if (typeof entry.contentDigest !== "string" || !SHA256.test(entry.contentDigest)) return null;
		if (
			entry.envelopeDigest !== undefined &&
			(typeof entry.envelopeDigest !== "string" || !SHA256.test(entry.envelopeDigest))
		)
			return null;
		const identity = sha256(
			canonicalJson({
				surface,
				id,
				contentDigest: entry.contentDigest ?? null,
				envelopeDigest: entry.envelopeDigest ?? null,
				source: entry.source ?? null,
				origin: entry.origin ?? null,
				trust: entry.trust ?? null,
				...(surface === "plugins" ? { kind: entry.kind ?? null } : {}),
			}),
		);
		all.add(identity);
		byId.set(id, entry.contentDigest === undefined ? null : identity);
		if (!disabled.has(id)) enabled.push(identity);
	}
	return { all: [...all].sort(), enabled, byId, pinned };
}

function identitiesApproved(packages: PackageIdentities, approval: SurfaceApproval | undefined): boolean {
	if (typeof approval !== "object" || !packages.pinned) return false;
	const approved = new Set(approval.identities);
	return packages.enabled.every((identity) => approved.has(identity));
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
		if ((record.version !== 1 && record.version !== 2) || record.workspaceRoot !== canonicalRoot) return null;
		if (!isObject(record.surfaces)) return null;
		const surfaces: WorkspaceTrustRecord["surfaces"] = {};
		for (const surface of SURFACES) {
			const approval = record.surfaces[surface];
			if (approval === undefined) continue;
			if (typeof approval === "string" && SHA256.test(approval)) {
				// A version 1 package digest stays an exact-bytes approval.
				surfaces[surface] = approval;
				continue;
			}
			if (
				record.version !== 2 ||
				!isPackageSurface(surface) ||
				!isObject(approval) ||
				!Array.isArray(approval.identities) ||
				!approval.identities.every((identity) => typeof identity === "string" && SHA256.test(identity))
			)
				return null;
			surfaces[surface] = { identities: [...(approval.identities as string[])] };
		}
		return { workspaceRoot: canonicalRoot, surfaces };
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

/**
 * Package surfaces approve identity sets that a digest cannot be checked
 * against, so they are refused here; read them through captureProjectSurface.
 */
export function projectSurfaceTrust(
	workspaceRoot: string,
	surface: Exclude<ProjectTrustSurface, PackageTrustSurface>,
	contentHash: string,
): WorkspaceTrustVerdict {
	if (isPackageSurface(surface)) throw new Error(`project ${surface} trust needs captureProjectSurface, not a digest`);
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
	writeSurfaceApproval(workspaceRoot, surface, contentHash);
}

/**
 * Operator-only writer for a reviewed package snapshot. The identities come
 * from the snapshot's captured bytes, so approval covers exactly what was
 * reviewed. State with a record that pins no content falls back to its bytes.
 */
export function recordProjectPackageTrust(snapshot: ProjectSurfaceSnapshot): void {
	const surface = snapshot.surface;
	if (!isPackageSurface(surface)) throw new Error(`project ${surface} is not a package surface`);
	if (snapshot.contentHash === null || !SHA256.test(snapshot.contentHash))
		throw new Error("trust requires a full SHA-256 digest");
	const packages = packageIdentities(surface, snapshot.files[0]?.text ?? null);
	if (packages === null) throw new Error(`project ${surface} install state cannot be parsed; trust was not recorded`);
	writeSurfaceApproval(
		snapshot.workspaceRoot,
		surface,
		packages.pinned ? { identities: packages.all } : snapshot.contentHash,
	);
}

/**
 * Version 2 only when an identity set needs it, so an older build that reads
 * only version 1 keeps reading a file that holds nothing but digests.
 */
function writeRecord(record: WorkspaceTrustRecord): void {
	const version = Object.values(record.surfaces).some((approval) => typeof approval === "object") ? 2 : 1;
	safeResourceWrite(
		recordPath(record.workspaceRoot),
		`${JSON.stringify({ version, workspaceRoot: record.workspaceRoot, surfaces: record.surfaces }, null, 2)}\n`,
		{ mode: 0o600 },
	);
}

function writeSurfaceApproval(workspaceRoot: string, surface: ProjectTrustSurface, approval: SurfaceApproval): void {
	const root = realpathSync(resolve(workspaceRoot));
	if (stateRootRemoved()) throw new Error("Clio state was removed; trust was not recorded");
	clioStateDir();
	withStateFileLockSync(recordPath(root), () => {
		if (stateRootRemoved()) throw new Error("Clio state was removed; trust was not recorded");
		const record: WorkspaceTrustRecord = readRecord(root) ?? { workspaceRoot: root, surfaces: {} };
		record.surfaces[surface] = approval;
		writeRecord(record);
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
		writeRecord(record);
	});
}

function surfacePaths(root: string, surface: ProjectTrustSurface): string[] {
	if (surface === "extensions" || surface === "plugins") {
		// The install state records every project package's content digest and the
		// loaders reverify each tree against it, so the identities parsed from this
		// one file pin the project packages the operator reviewed.
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
 * A task worktree Clio created inherits its trusted origin's approval of the
 * package surfaces while its enabled package identities are within the
 * origin's approved set, or its install state is byte-identical to the
 * origin's. Either way the worktree runs nothing the operator did not approve.
 * Returns the origin approval it inherits.
 */
function inheritedOriginApproval(snapshot: ProjectSurfaceSnapshot): SurfaceApproval | undefined {
	if (!isPackageSurface(snapshot.surface)) return undefined;
	const file = snapshot.files[0];
	if (file?.hash === undefined || file.hash === null) return undefined;
	const origin = taskWorktreeOrigin(snapshot.workspaceRoot);
	if (origin === null) return undefined;
	const approved = captureOwnProjectSurface(origin, snapshot.surface);
	if (approved.verdict !== "trusted") return undefined;
	const approval = readRecord(approved.workspaceRoot)?.surfaces[snapshot.surface];
	if (approval === undefined || approved.files[0]?.hash === file.hash) return approval;
	const packages = packageIdentities(snapshot.surface, file.text);
	return packages !== null && identitiesApproved(packages, approval) ? approval : undefined;
}

/** Removals and disables never need consent; unparseable state is never trusted. */
function packageSurfaceVerdict(
	root: string,
	surface: PackageTrustSurface,
	text: string | null,
	contentHash: string,
): WorkspaceTrustVerdict {
	const approval = readRecord(root)?.surfaces[surface];
	if (approval === undefined) return "untrusted";
	const packages = packageIdentities(surface, text);
	if (packages === null) return "untrusted";
	if (typeof approval === "string") return approval === contentHash ? "trusted" : "changed";
	return identitiesApproved(packages, approval) ? "trusted" : "changed";
}

/** Capture once, hash once, and let loaders parse exactly the admitted bytes. */
export function captureProjectSurface(workspaceRoot: string, surface: ProjectTrustSurface): ProjectSurfaceSnapshot {
	return captureWithApproval(workspaceRoot, surface).snapshot;
}

/** The snapshot and the approval its trusted verdict rests on, own or inherited. */
function captureWithApproval(
	workspaceRoot: string,
	surface: ProjectTrustSurface,
): { snapshot: ProjectSurfaceSnapshot; approval: SurfaceApproval | undefined } {
	const own = captureOwnProjectSurface(workspaceRoot, surface);
	if (own.verdict === "trusted") return { snapshot: own, approval: readRecord(own.workspaceRoot)?.surfaces[surface] };
	const inherited = inheritedOriginApproval(own);
	return inherited === undefined
		? { snapshot: own, approval: undefined }
		: { snapshot: { ...own, verdict: "trusted" }, approval: inherited };
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
		verdict:
			contentHash === null
				? "untrusted"
				: isPackageSurface(surface)
					? packageSurfaceVerdict(root, surface, files[0]?.text ?? null, contentHash)
					: projectSurfaceTrust(root, surface, contentHash),
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

export interface ProjectPackageTrust {
	verdict: WorkspaceTrustVerdict;
	/** Install-state ids whose own record is approved. Empty unless the surface is trusted. */
	approvedIds: ReadonlySet<string>;
}

/**
 * Per-record consent for a package surface. The surface verdict checks only
 * enabled identities, so a trusted surface can still hold a disabled record
 * nobody approved. Loaders block every record outside approvedIds, so such a
 * record neither loads nor shadows a user copy of the same id.
 */
export function projectPackageTrust(workspaceRoot: string, surface: PackageTrustSurface): ProjectPackageTrust {
	try {
		const { snapshot, approval } = captureWithApproval(workspaceRoot, surface);
		const packages = packageIdentities(surface, snapshot.files[0]?.text ?? null);
		if (snapshot.verdict !== "trusted" || packages === null || approval === undefined)
			return { verdict: snapshot.verdict === "trusted" ? "changed" : snapshot.verdict, approvedIds: new Set() };
		// A matching byte digest approved every record the operator reviewed in those bytes.
		if (typeof approval === "string") return { verdict: "trusted", approvedIds: new Set(packages.byId.keys()) };
		const approved = new Set(approval.identities);
		const approvedIds = new Set<string>();
		for (const [id, identity] of packages.byId) if (identity !== null && approved.has(identity)) approvedIds.add(id);
		return { verdict: "trusted", approvedIds };
	} catch {
		// Authority that cannot be read is never consent.
		return { verdict: "untrusted", approvedIds: new Set() };
	}
}

/** What an operator install may approve, captured before the install runs. */
export interface ProjectInstallBaseline {
	surface: PackageTrustSurface;
	/** This workspace's own approval before the install, so a revoke in the window is seen. */
	approval: SurfaceApproval | null;
	/** Identities approved, or enabled under an approved surface, before the install. */
	approved: string[];
}

/**
 * Call before an operator install. The surface may be approved after the
 * install only when it had no install state or its state was trusted, so an
 * install never launders packages nobody approved. Returns null otherwise.
 */
export function captureProjectInstallBaseline(
	workspaceRoot: string,
	surface: PackageTrustSurface,
): ProjectInstallBaseline | null {
	try {
		const { snapshot, approval: effective } = captureWithApproval(workspaceRoot, surface);
		const approval = readRecord(snapshot.workspaceRoot)?.surfaces[surface] ?? null;
		const text = snapshot.files[0]?.text ?? null;
		if (text === null) return snapshot.files[0]?.error === undefined ? { surface, approval, approved: [] } : null;
		if (snapshot.verdict !== "trusted") return null;
		const packages = packageIdentities(surface, text);
		if (packages === null) return null;
		// A trusted surface approves its enabled identities. A matching byte digest
		// also approved the disabled ones, which the operator reviewed with them.
		const approved = new Set(packages.enabled);
		if (typeof effective === "object") for (const identity of effective.identities) approved.add(identity);
		else if (effective !== undefined) for (const identity of packages.all) approved.add(identity);
		return { surface, approval, approved: [...approved] };
	} catch {
		// Authority that cannot be read is never consent.
		return null;
	}
}

/**
 * The identities approved right before an install's approval is written,
 * read under the trust record lock. Null when the surface lost the approval
 * the baseline saw, so a revoke in the install window is never undone.
 */
function approvedAtCommit(current: SurfaceApproval | undefined, baseline: ProjectInstallBaseline): string[] | null {
	if (current === undefined) return baseline.approval === null ? baseline.approved : null;
	if (typeof current === "object")
		return baseline.approval === null ? [...current.identities, ...baseline.approved] : current.identities;
	return current === baseline.approval ? baseline.approved : null;
}

/**
 * Approves the operator's own install into a project: the identities of the
 * records this install wrote, added to the surface's approved set as it stands
 * under the lock. A record another writer added or changed in the install
 * window stays unapproved. It records identities, never a byte digest. Archive
 * imports and imports from other tools never call it, and enable or later
 * changes by anyone else need `config trust`. Returns whether the new state
 * was approved.
 */
export function approveOperatorProjectInstall(
	workspaceRoot: string,
	baseline: ProjectInstallBaseline,
	writtenIds: ReadonlyArray<string>,
): boolean {
	try {
		const root = realpathSync(resolve(workspaceRoot));
		if (stateRootRemoved()) return false;
		clioStateDir();
		return withStateFileLockSync(recordPath(root), () => {
			if (stateRootRemoved()) return false;
			const snapshot = captureOwnProjectSurface(root, baseline.surface);
			const packages = packageIdentities(baseline.surface, snapshot.files[0]?.text ?? null);
			if (packages === null) return false;
			const record: WorkspaceTrustRecord = readRecord(root) ?? { workspaceRoot: root, surfaces: {} };
			const before = approvedAtCommit(record.surfaces[baseline.surface], baseline);
			if (before === null) return false;
			// Records without a content digest pin no content, so only a review approves them.
			const written = writtenIds.flatMap((id) => {
				const identity = packages.byId.get(id);
				return typeof identity === "string" ? [identity] : [];
			});
			const approval = { identities: [...new Set([...before, ...written])].sort() };
			record.surfaces[baseline.surface] = approval;
			writeRecord(record);
			return identitiesApproved(packages, approval);
		});
	} catch {
		// The install already succeeded; without the record the package stays
		// unloaded and the trust notice names the command that approves it.
		return false;
	}
}

export interface ProjectPackageEntry {
	id: string;
	source: string | null;
	/** Canonical JSON of the recorded origin, which is part of the identity. */
	origin: string | null;
	trust: string | null;
	/** A plugin record's kind; extension records carry none. */
	kind: string | null;
	contentDigest: string | null;
	envelopeDigest: string | null;
	enabled: boolean;
}

/**
 * The packages a package surface snapshot approves, so `config trust` can
 * show identities instead of install-state text. Null when the state cannot be
 * parsed, which approval refuses too.
 */
export function projectPackageEntries(snapshot: ProjectSurfaceSnapshot): ProjectPackageEntry[] | null {
	if (!isPackageSurface(snapshot.surface)) return null;
	const text = snapshot.files[0]?.text ?? null;
	if (text === null) return [];
	if (packageIdentities(snapshot.surface, text) === null) return null;
	const raw = JSON.parse(text) as { installed: Record<string, Record<string, unknown>>; disabled: string[] };
	return Object.entries(raw.installed)
		.map(([id, entry]) => ({
			id,
			source: typeof entry.source === "string" ? entry.source : null,
			origin: entry.origin === undefined ? null : canonicalJson(entry.origin),
			trust: typeof entry.trust === "string" ? entry.trust : null,
			kind: typeof entry.kind === "string" ? entry.kind : null,
			contentDigest: typeof entry.contentDigest === "string" ? entry.contentDigest : null,
			envelopeDigest: typeof entry.envelopeDigest === "string" ? entry.envelopeDigest : null,
			enabled: !raw.disabled.includes(id),
		}))
		.sort((a, b) => a.id.localeCompare(b.id));
}

export function projectSurfaceTrustNotice(snapshot: ProjectSurfaceSnapshot, filePath: string): string {
	return `${filePath} is ${snapshot.verdict}; project ${snapshot.surface} ignored. Review with clio-coder config trust ${snapshot.surface}.`;
}
