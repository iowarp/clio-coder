import { isAbsolute, join, relative, sep } from "node:path";

export type ProjectId = string;
export type ProjectPath = readonly string[];

export interface LocalSandboxProjectIdentity {
	kind: "local-sandbox";
	sandboxId: string;
	relativeRoot: string[];
}

export interface NativeProjectIdentity {
	kind: "native";
	platform: "linux" | "darwin" | "windows";
	canonicalPath: string;
}

export interface WslProjectIdentity {
	kind: "wsl";
	distro: string;
	linuxPath: string;
}

/** Tagged now so later backends never have to infer an operating system from a path string. */
export type ProjectIdentity = LocalSandboxProjectIdentity | NativeProjectIdentity | WslProjectIdentity;

/** Contains no host-absolute path or filesystem capability. */
export interface ProjectSummary {
	id: ProjectId;
	displayName: string;
	identity: ProjectIdentity;
	createdAt: string;
	lastOpenedAt: string;
	revision: number;
}

export type ProjectTreeNodeKind = "directory" | "file" | "symlink" | "other";

export interface ProjectTreeNode {
	name: string;
	path: string[];
	kind: ProjectTreeNodeKind;
	operable: boolean;
	blockedReason?: "symlink" | "unsupported-name" | "boundary";
	nodeVersion?: string;
	size?: number;
	modifiedAt?: string;
	children?: ProjectTreeNode[];
}

export interface ProjectTree {
	projectId: ProjectId;
	root: ProjectTreeNode;
	truncated: boolean;
	nodeCount: number;
	maxDepth: number;
	maxNodes: number;
	projectRevision: number;
}

export interface TreeRequest {
	projectId: ProjectId;
	root?: ProjectPath;
	maxDepth?: number;
	maxNodes?: number;
}

export interface CreateProjectRequest {
	displayName: string;
	directoryName: string;
}

export interface RegisterProjectRequest {
	displayName?: string;
	relativeRoot: ProjectPath;
}

export interface SeedProjectRequest {
	id?: ProjectId;
	displayName: string;
	relativeRoot: ProjectPath;
	createIfMissing?: boolean;
}

export interface CreateEntryRequest {
	projectId: ProjectId;
	parent: ProjectPath;
	name: string;
}

export interface MoveEntryRequest {
	projectId: ProjectId;
	source: ProjectPath;
	destination: {
		parent: ProjectPath;
		name: string;
	};
	/** Best-effort optimistic concurrency token returned by a tree response. */
	expectedNodeVersion?: string;
}

export interface PrepareDeleteRequest {
	projectId: ProjectId;
	target: ProjectPath;
	/** Best-effort optimistic concurrency token returned by a tree response. */
	expectedNodeVersion?: string;
}

export interface ConfirmDeleteRequest {
	projectId: ProjectId;
	confirmationId: string;
}

export interface ProjectMutationResult {
	projectId: ProjectId;
	path: string[];
	revision: number;
	entry?: ProjectTreeNode;
}

export interface MoveEntryResult extends ProjectMutationResult {
	previousPath: string[];
}

export interface DeleteChallenge {
	confirmationId: string;
	projectId: ProjectId;
	target: string[];
	targetKind: "file" | "empty-directory";
	displayPath: string;
	expiresAt: string;
}

export interface ProjectStoreOptions {
	sandboxRoot: string;
	sandboxId?: string;
	seeds?: readonly SeedProjectRequest[];
	idFactory?: () => string;
	now?: () => number;
	deleteConfirmationTtlMs?: number;
}

export type ProjectStoreErrorCode =
	| "already_exists"
	| "confirmation_expired"
	| "confirmation_mismatch"
	| "confirmation_not_found"
	| "directory_not_empty"
	| "filesystem_error"
	| "invalid_display_name"
	| "invalid_move"
	| "invalid_path"
	| "invalid_project_id"
	| "not_directory"
	| "not_found"
	| "outside_project"
	| "permission_denied"
	| "project_not_found"
	| "project_overlap"
	| "root_changed"
	| "stale_entry"
	| "symlink_blocked"
	| "unsupported_entry";

/** A renderer-safe domain error: its message never contains an absolute host path. */
export class ProjectStoreError extends Error {
	override readonly name = "ProjectStoreError";

	constructor(
		readonly code: ProjectStoreErrorCode,
		message: string,
	) {
		super(message);
	}
}

interface NodeFingerprint {
	kind: ProjectTreeNodeKind;
	dev: number;
	ino: number | null;
	size: number;
	mtimeMs: number | null;
	ctimeMs: number | null;
}

interface RootIdentity {
	dev: number;
	ino: number | null;
}

interface StoredProject {
	id: ProjectId;
	displayName: string;
	identity: LocalSandboxProjectIdentity;
	createdAt: string;
	lastOpenedAt: string;
	revision: number;
	canonicalRoot: string;
	rootIdentity: RootIdentity;
}

interface ResolvedEntry {
	canonicalPath: string;
	info: Deno.FileInfo;
	fingerprint: NodeFingerprint;
}

interface StoredDeleteChallenge {
	id: string;
	projectId: ProjectId;
	target: string[];
	fingerprint: NodeFingerprint;
	expiresAtMs: number;
}

const HARD_MAX_TREE_DEPTH = 5;
const HARD_MAX_TREE_NODES = 200;
const MAX_PATH_SEGMENTS = 64;
const MAX_PATH_BYTES = 4096;
const MAX_SEGMENT_BYTES = 255;
const MAX_DISPLAY_NAME_LENGTH = 120;
const DEFAULT_DELETE_TTL_MS = 60_000;
const MAX_DELETE_CHALLENGES = 128;
const DRIVE_QUALIFIED = /^[a-zA-Z]:/u;
const OPAQUE_ID = /^[a-zA-Z0-9_-]+$/u;
const textEncoder = new TextEncoder();

class SerialExecutor {
	#tail: Promise<void> = Promise.resolve();

	run<T>(operation: () => Promise<T>): Promise<T> {
		const result = this.#tail.then(operation, operation);
		this.#tail = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}
}

export class ProjectStore {
	readonly #sandboxId: string;
	readonly #canonicalSandboxRoot: string;
	readonly #sandboxRootIdentity: RootIdentity;
	readonly #idFactory: () => string;
	readonly #now: () => number;
	readonly #deleteConfirmationTtlMs: number;
	readonly #versionSecret = crypto.randomUUID();
	readonly #projects = new Map<ProjectId, StoredProject>();
	readonly #deleteChallenges = new Map<string, StoredDeleteChallenge>();
	readonly #registryExecutor = new SerialExecutor();
	readonly #projectExecutors = new Map<ProjectId, SerialExecutor>();

	private constructor(
		options: ProjectStoreOptions,
		canonicalSandboxRoot: string,
		sandboxRootIdentity: RootIdentity,
	) {
		this.#sandboxId = options.sandboxId ?? "local-development";
		this.#canonicalSandboxRoot = canonicalSandboxRoot;
		this.#sandboxRootIdentity = sandboxRootIdentity;
		this.#idFactory = options.idFactory ?? (() => crypto.randomUUID());
		this.#now = options.now ?? (() => Date.now());
		this.#deleteConfirmationTtlMs = options.deleteConfirmationTtlMs ?? DEFAULT_DELETE_TTL_MS;

		if (!Number.isSafeInteger(this.#deleteConfirmationTtlMs) || this.#deleteConfirmationTtlMs <= 0) {
			throw new ProjectStoreError("filesystem_error", "The delete confirmation lifetime is invalid.");
		}
	}

	static async open(options: ProjectStoreOptions): Promise<ProjectStore> {
		try {
			await Deno.mkdir(options.sandboxRoot, { recursive: true });
		} catch (error) {
			throw mapFilesystemError(error, "filesystem_error", "The project sandbox could not be prepared.");
		}
		const suppliedRootInfo = await safeLstat(options.sandboxRoot, "The project sandbox is unavailable.");
		if (suppliedRootInfo.isSymlink) {
			throw new ProjectStoreError("symlink_blocked", "The project sandbox cannot be a symbolic link.");
		}
		if (!suppliedRootInfo.isDirectory) {
			throw new ProjectStoreError("not_directory", "The project sandbox is not a directory.");
		}

		const canonicalSandboxRoot = await safeRealPath(options.sandboxRoot, "The project sandbox is unavailable.");
		const canonicalRootInfo = await safeLstat(canonicalSandboxRoot, "The project sandbox is unavailable.");
		const store = new ProjectStore(options, canonicalSandboxRoot, rootIdentity(canonicalRootInfo));

		for (const seed of options.seeds ?? []) {
			await store.seedProject(seed);
		}

		return store;
	}

	listProjects(): ProjectSummary[] {
		return [...this.#projects.values()].map(toProjectSummary);
	}

	getProject(projectId: ProjectId): ProjectSummary {
		return toProjectSummary(this.#requireProject(projectId));
	}

	async resolveTrustedRoot(projectId: ProjectId): Promise<string> {
		const project = this.#requireProject(projectId);
		await this.#assertProjectRoot(project);
		return project.canonicalRoot;
	}

	async createProject(request: CreateProjectRequest): Promise<ProjectSummary> {
		return await this.#registryExecutor.run(async () => {
			const displayName = validateDisplayName(request.displayName);
			const directoryName = validateEntryName(request.directoryName);
			await this.#assertSandboxRoot();
			const target = join(this.#canonicalSandboxRoot, directoryName);
			assertContained(this.#canonicalSandboxRoot, target);

			try {
				await Deno.mkdir(target);
			} catch (error) {
				throw mapFilesystemError(error, "filesystem_error", "The project directory could not be created.");
			}

			try {
				return await this.#registerResolvedProject({
					displayName,
					relativeRoot: [directoryName],
				});
			} catch (error) {
				// The directory is known to be newly created and empty. Avoid leaving it behind if registry validation fails.
				try {
					await Deno.remove(target);
				} catch {
					// Preserve the original domain error; cleanup is best effort only.
				}
				throw error;
			}
		});
	}

	async registerProject(request: RegisterProjectRequest): Promise<ProjectSummary> {
		return await this.#registryExecutor.run(async () => {
			const relativeRoot = validateProjectPath(request.relativeRoot, false);
			const displayName = validateDisplayName(request.displayName ?? relativeRoot.at(-1) ?? "Project");
			return await this.#registerResolvedProject({ displayName, relativeRoot });
		});
	}

	async seedProject(request: SeedProjectRequest): Promise<ProjectSummary> {
		return await this.#registryExecutor.run(async () => {
			const relativeRoot = validateProjectPath(request.relativeRoot, false);
			const displayName = validateDisplayName(request.displayName);
			if (request.id !== undefined) validateOpaqueId(request.id);
			await this.#assertSandboxRoot();

			if (request.createIfMissing) {
				if (relativeRoot.length !== 1) {
					throw new ProjectStoreError(
						"invalid_path",
						"A seeded project can create only one direct child of the controlled sandbox.",
					);
				}
				const target = join(this.#canonicalSandboxRoot, relativeRoot[0] as string);
				try {
					await Deno.mkdir(target);
				} catch (error) {
					if (!(error instanceof Deno.errors.AlreadyExists)) {
						throw mapFilesystemError(error, "filesystem_error", "The seeded project could not be created.");
					}
				}
			}

			return await this.#registerResolvedProject({
				displayName,
				relativeRoot,
				requestedId: request.id,
			});
		});
	}

	async getTree(request: TreeRequest): Promise<ProjectTree> {
		const project = this.#requireProject(request.projectId);
		return await this.#executorFor(project.id).run(async () => {
			const rootPath = validateProjectPath(request.root ?? [], true);
			const maxDepth = boundedInteger(request.maxDepth, HARD_MAX_TREE_DEPTH, 0, HARD_MAX_TREE_DEPTH);
			const maxNodes = boundedInteger(request.maxNodes, HARD_MAX_TREE_NODES, 1, HARD_MAX_TREE_NODES);
			const resolvedRoot = await this.#resolveProjectEntry(project, rootPath);
			if (!resolvedRoot.info.isDirectory) {
				throw new ProjectStoreError("not_directory", "The requested tree root is not a directory.");
			}

			let nodeCount = 0;
			let truncated = false;

			const buildNode = async (
				absolutePath: string,
				path: string[],
				info: Deno.FileInfo,
				depth: number,
			): Promise<ProjectTreeNode> => {
				nodeCount += 1;
				const fingerprint = nodeFingerprint(info);
				const node: ProjectTreeNode = {
					name: path.at(-1) ?? project.displayName,
					path: [...path],
					kind: fingerprint.kind,
					operable: fingerprint.kind === "file" || fingerprint.kind === "directory",
					nodeVersion: await this.#nodeVersion(project.id, path, fingerprint),
					...(info.isFile ? { size: info.size } : {}),
					...(info.mtime ? { modifiedAt: info.mtime.toISOString() } : {}),
				};

				if (!info.isDirectory) return node;
				if (depth >= maxDepth) {
					if (await directoryHasEntry(absolutePath)) truncated = true;
					return { ...node, children: [] };
				}

				const remaining = maxNodes - nodeCount;
				if (remaining <= 0) {
					if (await directoryHasEntry(absolutePath)) truncated = true;
					return { ...node, children: [] };
				}

				const names: string[] = [];
				for await (const entry of Deno.readDir(absolutePath)) {
					names.push(entry.name);
					if (names.length > remaining) {
						truncated = true;
						break;
					}
				}
				names.sort(codePointCompare);

				const children: ProjectTreeNode[] = [];
				for (const name of names) {
					if (nodeCount >= maxNodes) {
						truncated = true;
						break;
					}
					const childPath = [...path, name];
					const childAbsolutePath = join(absolutePath, name);
					let childInfo: Deno.FileInfo;
					try {
						childInfo = await Deno.lstat(childAbsolutePath);
					} catch (error) {
						if (error instanceof Deno.errors.NotFound) continue;
						throw mapFilesystemError(error, "filesystem_error", "The project tree could not be read.");
					}

					if (!isValidExistingEntryName(name)) {
						nodeCount += 1;
						children.push({
							name,
							path: childPath,
							kind: kindOf(childInfo),
							operable: false,
							blockedReason: "unsupported-name",
						});
						continue;
					}

					if (childInfo.isSymlink) {
						nodeCount += 1;
						children.push({
							name,
							path: childPath,
							kind: "symlink",
							operable: false,
							blockedReason: "symlink",
						});
						continue;
					}

					let canonicalChild: string;
					try {
						canonicalChild = await Deno.realPath(childAbsolutePath);
						assertContained(project.canonicalRoot, canonicalChild);
					} catch (error) {
						if (error instanceof Deno.errors.NotFound) continue;
						if (error instanceof ProjectStoreError && error.code !== "outside_project") throw error;
						nodeCount += 1;
						children.push({
							name,
							path: childPath,
							kind: kindOf(childInfo),
							operable: false,
							blockedReason: "boundary",
						});
						continue;
					}

					children.push(await buildNode(canonicalChild, childPath, childInfo, depth + 1));
				}

				return { ...node, children };
			};

			const root = await buildNode(resolvedRoot.canonicalPath, [...rootPath], resolvedRoot.info, 0);
			return {
				projectId: project.id,
				root,
				truncated,
				nodeCount,
				maxDepth,
				maxNodes,
				projectRevision: project.revision,
			};
		});
	}

	async createFile(request: CreateEntryRequest): Promise<ProjectMutationResult> {
		return await this.#createEntry(request, "file");
	}

	async createFolder(request: CreateEntryRequest): Promise<ProjectMutationResult> {
		return await this.#createEntry(request, "directory");
	}

	async moveEntry(request: MoveEntryRequest): Promise<MoveEntryResult> {
		const project = this.#requireProject(request.projectId);
		return await this.#executorFor(project.id).run(async () => {
			const source = validateProjectPath(request.source, false);
			const destinationParent = validateProjectPath(request.destination.parent, true);
			const destinationName = validateEntryName(request.destination.name);
			const destination = validateProjectPath([...destinationParent, destinationName], false);
			if (pathsEqual(source, destination) || isPathPrefix(source, destination)) {
				throw new ProjectStoreError("invalid_move", "A project entry cannot be moved into itself.");
			}

			const sourceEntry = await this.#resolveProjectEntry(project, source);
			if (request.expectedNodeVersion !== undefined) {
				const currentVersion = await this.#nodeVersion(project.id, source, sourceEntry.fingerprint);
				if (currentVersion !== request.expectedNodeVersion) {
					throw new ProjectStoreError("stale_entry", "The project entry changed before it could be moved.");
				}
			}

			const parentEntry = await this.#resolveProjectEntry(project, destinationParent);
			if (!parentEntry.info.isDirectory) {
				throw new ProjectStoreError("not_directory", "The move destination is not a directory.");
			}
			const destinationAbsolutePath = join(parentEntry.canonicalPath, destinationName);
			assertContained(project.canonicalRoot, destinationAbsolutePath);
			await assertDoesNotExist(destinationAbsolutePath);

			// Revalidate both sides as late as Deno's path API permits. Deno.rename has no atomic no-replace option.
			const revalidatedSource = await this.#resolveProjectEntry(project, source);
			if (!fingerprintsEqual(sourceEntry.fingerprint, revalidatedSource.fingerprint)) {
				throw new ProjectStoreError("stale_entry", "The project entry changed before it could be moved.");
			}
			const revalidatedParent = await this.#resolveProjectEntry(project, destinationParent);
			const revalidatedDestination = join(revalidatedParent.canonicalPath, destinationName);
			await assertDoesNotExist(revalidatedDestination);

			try {
				await Deno.rename(revalidatedSource.canonicalPath, revalidatedDestination);
			} catch (error) {
				throw mapFilesystemError(error, "filesystem_error", "The project entry could not be moved.");
			}

			project.revision += 1;
			const moved = await this.#resolveProjectEntry(project, destination);
			return {
				projectId: project.id,
				path: [...destination],
				previousPath: [...source],
				revision: project.revision,
				entry: await this.#entryDto(project, destination, moved.info),
			};
		});
	}

	async prepareDelete(request: PrepareDeleteRequest): Promise<DeleteChallenge> {
		const project = this.#requireProject(request.projectId);
		return await this.#executorFor(project.id).run(async () => {
			const target = validateProjectPath(request.target, false);
			const entry = await this.#resolveProjectEntry(project, target);
			if (!entry.info.isFile && !entry.info.isDirectory) {
				throw new ProjectStoreError("unsupported_entry", "Only files and empty directories can be deleted.");
			}
			if (request.expectedNodeVersion !== undefined) {
				const currentVersion = await this.#nodeVersion(project.id, target, entry.fingerprint);
				if (currentVersion !== request.expectedNodeVersion) {
					throw new ProjectStoreError("stale_entry", "The project entry changed before deletion was prepared.");
				}
			}
			if (entry.info.isDirectory && (await directoryHasEntry(entry.canonicalPath))) {
				throw new ProjectStoreError("directory_not_empty", "Only an empty project directory can be deleted.");
			}

			this.#pruneDeleteChallenges();
			const confirmationId = this.#nextOpaqueId("confirmation");
			const expiresAtMs = this.#now() + this.#deleteConfirmationTtlMs;
			this.#deleteChallenges.set(confirmationId, {
				id: confirmationId,
				projectId: project.id,
				target: [...target],
				fingerprint: entry.fingerprint,
				expiresAtMs,
			});

			return {
				confirmationId,
				projectId: project.id,
				target: [...target],
				targetKind: entry.info.isFile ? "file" : "empty-directory",
				displayPath: target.join("/"),
				expiresAt: new Date(expiresAtMs).toISOString(),
			};
		});
	}

	async confirmDelete(request: ConfirmDeleteRequest): Promise<ProjectMutationResult> {
		const project = this.#requireProject(request.projectId);
		return await this.#executorFor(project.id).run(async () => {
			const challenge = this.#deleteChallenges.get(request.confirmationId);
			if (!challenge) {
				throw new ProjectStoreError(
					"confirmation_not_found",
					"The delete confirmation is unknown or was already used.",
				);
			}
			if (challenge.projectId !== project.id) {
				throw new ProjectStoreError("confirmation_mismatch", "The delete confirmation belongs to another project.");
			}
			if (this.#now() >= challenge.expiresAtMs) {
				this.#deleteChallenges.delete(challenge.id);
				throw new ProjectStoreError("confirmation_expired", "The delete confirmation expired.");
			}

			// A valid confirmation is one-use even if final revalidation or deletion fails.
			this.#deleteChallenges.delete(challenge.id);
			const entry = await this.#resolveProjectEntry(project, challenge.target);
			if (!fingerprintsEqual(challenge.fingerprint, entry.fingerprint)) {
				throw new ProjectStoreError("stale_entry", "The project entry changed after deletion was prepared.");
			}
			if (!entry.info.isFile && !entry.info.isDirectory) {
				throw new ProjectStoreError("unsupported_entry", "Only files and empty directories can be deleted.");
			}
			if (entry.info.isDirectory && (await directoryHasEntry(entry.canonicalPath))) {
				throw new ProjectStoreError("directory_not_empty", "The project directory is no longer empty.");
			}

			try {
				await Deno.remove(entry.canonicalPath);
			} catch (error) {
				throw mapFilesystemError(error, "filesystem_error", "The project entry could not be deleted.");
			}
			project.revision += 1;
			return {
				projectId: project.id,
				path: [...challenge.target],
				revision: project.revision,
			};
		});
	}

	async #createEntry(request: CreateEntryRequest, kind: "file" | "directory"): Promise<ProjectMutationResult> {
		const project = this.#requireProject(request.projectId);
		return await this.#executorFor(project.id).run(async () => {
			const parent = validateProjectPath(request.parent, true);
			const name = validateEntryName(request.name);
			const path = validateProjectPath([...parent, name], false);
			const parentEntry = await this.#resolveProjectEntry(project, parent);
			if (!parentEntry.info.isDirectory) {
				throw new ProjectStoreError("not_directory", "The new project entry requires a directory parent.");
			}
			const target = join(parentEntry.canonicalPath, name);
			assertContained(project.canonicalRoot, target);

			try {
				if (kind === "file") {
					const file = await Deno.open(target, { write: true, createNew: true });
					file.close();
				} else {
					await Deno.mkdir(target);
				}
			} catch (error) {
				throw mapFilesystemError(error, "filesystem_error", `The project ${kind} could not be created.`);
			}

			project.revision += 1;
			const created = await this.#resolveProjectEntry(project, path);
			return {
				projectId: project.id,
				path: [...path],
				revision: project.revision,
				entry: await this.#entryDto(project, path, created.info),
			};
		});
	}

	async #registerResolvedProject(input: {
		displayName: string;
		relativeRoot: string[];
		requestedId?: ProjectId;
	}): Promise<ProjectSummary> {
		await this.#assertSandboxRoot();
		const resolved = await this.#resolveFromRoot(this.#canonicalSandboxRoot, input.relativeRoot);
		if (!resolved.info.isDirectory) {
			throw new ProjectStoreError("not_directory", "A registered project must be a directory.");
		}

		for (const existing of this.#projects.values()) {
			if (sameCanonicalPath(existing.canonicalRoot, resolved.canonicalPath)) {
				return toProjectSummary(existing);
			}
			if (
				isCanonicalAncestor(existing.canonicalRoot, resolved.canonicalPath) ||
				isCanonicalAncestor(resolved.canonicalPath, existing.canonicalRoot)
			) {
				throw new ProjectStoreError(
					"project_overlap",
					"Registered project roots cannot contain one another in the controlled sandbox.",
				);
			}
		}

		const id = input.requestedId ?? this.#nextOpaqueId("project");
		validateOpaqueId(id);
		if (this.#projects.has(id)) {
			throw new ProjectStoreError("invalid_project_id", "The requested project identifier is already registered.");
		}
		const now = new Date(this.#now()).toISOString();
		const project: StoredProject = {
			id,
			displayName: input.displayName,
			identity: {
				kind: "local-sandbox",
				sandboxId: this.#sandboxId,
				relativeRoot: [...input.relativeRoot],
			},
			createdAt: now,
			lastOpenedAt: now,
			revision: 0,
			canonicalRoot: resolved.canonicalPath,
			rootIdentity: rootIdentity(resolved.info),
		};
		this.#projects.set(id, project);
		this.#projectExecutors.set(id, new SerialExecutor());
		return toProjectSummary(project);
	}

	async #resolveProjectEntry(project: StoredProject, path: string[]): Promise<ResolvedEntry> {
		await this.#assertProjectRoot(project);
		return await this.#resolveFromRoot(project.canonicalRoot, path);
	}

	async #resolveFromRoot(root: string, path: string[]): Promise<ResolvedEntry> {
		let current = root;
		let info = await safeLstat(current, "The project entry does not exist.");
		for (let index = 0; index < path.length; index += 1) {
			const segment = path[index] as string;
			const candidate = join(current, segment);
			assertContained(root, candidate);
			info = await safeLstat(candidate, "The project entry does not exist.");
			if (info.isSymlink) {
				throw new ProjectStoreError("symlink_blocked", "Symbolic links are not operable project paths.");
			}
			if (index < path.length - 1 && !info.isDirectory) {
				throw new ProjectStoreError("not_directory", "A project path component is not a directory.");
			}
			const firstCanonicalPath = await safeRealPath(candidate, "The project entry does not exist.");
			assertContained(root, firstCanonicalPath);
			const recheckedInfo = await safeLstat(candidate, "The project entry does not exist.");
			if (recheckedInfo.isSymlink) {
				throw new ProjectStoreError("symlink_blocked", "Symbolic links are not operable project paths.");
			}
			const recheckedCanonicalPath = await safeRealPath(candidate, "The project entry does not exist.");
			assertContained(root, recheckedCanonicalPath);
			if (!sameCanonicalPath(firstCanonicalPath, recheckedCanonicalPath)) {
				throw new ProjectStoreError("stale_entry", "The project path changed while it was being validated.");
			}
			info = recheckedInfo;
			current = recheckedCanonicalPath;
		}

		return {
			canonicalPath: current,
			info,
			fingerprint: nodeFingerprint(info),
		};
	}

	async #assertSandboxRoot(): Promise<void> {
		const info = await safeLstat(this.#canonicalSandboxRoot, "The project sandbox changed or disappeared.");
		if (info.isSymlink || !info.isDirectory || !rootIdentitiesEqual(this.#sandboxRootIdentity, rootIdentity(info))) {
			throw new ProjectStoreError("root_changed", "The project sandbox changed or disappeared.");
		}
		const canonical = await safeRealPath(this.#canonicalSandboxRoot, "The project sandbox changed or disappeared.");
		if (!sameCanonicalPath(canonical, this.#canonicalSandboxRoot)) {
			throw new ProjectStoreError("root_changed", "The project sandbox changed or disappeared.");
		}
	}

	async #assertProjectRoot(project: StoredProject): Promise<void> {
		await this.#assertSandboxRoot();
		const info = await safeLstat(project.canonicalRoot, "The registered project changed or disappeared.");
		if (info.isSymlink || !info.isDirectory || !rootIdentitiesEqual(project.rootIdentity, rootIdentity(info))) {
			throw new ProjectStoreError("root_changed", "The registered project changed or disappeared.");
		}
		const canonical = await safeRealPath(project.canonicalRoot, "The registered project changed or disappeared.");
		if (!sameCanonicalPath(canonical, project.canonicalRoot)) {
			throw new ProjectStoreError("root_changed", "The registered project changed or disappeared.");
		}
		assertContained(this.#canonicalSandboxRoot, canonical);
	}

	#requireProject(projectId: ProjectId): StoredProject {
		validateOpaqueId(projectId);
		const project = this.#projects.get(projectId);
		if (!project) throw new ProjectStoreError("project_not_found", "The requested project is not registered.");
		return project;
	}

	#executorFor(projectId: ProjectId): SerialExecutor {
		const executor = this.#projectExecutors.get(projectId);
		if (!executor) throw new ProjectStoreError("project_not_found", "The requested project is not registered.");
		return executor;
	}

	#nextOpaqueId(kind: "project" | "confirmation"): string {
		for (let attempt = 0; attempt < 16; attempt += 1) {
			const id = this.#idFactory();
			validateOpaqueId(id);
			if (!this.#projects.has(id) && !this.#deleteChallenges.has(id)) return id;
		}
		throw new ProjectStoreError("filesystem_error", `A unique ${kind} identifier could not be allocated.`);
	}

	#pruneDeleteChallenges(): void {
		const now = this.#now();
		for (const [id, challenge] of this.#deleteChallenges) {
			if (challenge.expiresAtMs <= now) this.#deleteChallenges.delete(id);
		}
		while (this.#deleteChallenges.size >= MAX_DELETE_CHALLENGES) {
			const oldestId = this.#deleteChallenges.keys().next().value;
			if (oldestId === undefined) break;
			this.#deleteChallenges.delete(oldestId);
		}
	}

	async #nodeVersion(projectId: ProjectId, path: ProjectPath, fingerprint: NodeFingerprint): Promise<string> {
		const material = JSON.stringify([this.#versionSecret, projectId, path, fingerprint]);
		const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", textEncoder.encode(material)));
		return [...digest.subarray(0, 16)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
	}

	async #entryDto(project: StoredProject, path: ProjectPath, info: Deno.FileInfo): Promise<ProjectTreeNode> {
		const fingerprint = nodeFingerprint(info);
		return {
			name: path.at(-1) ?? project.displayName,
			path: [...path],
			kind: fingerprint.kind,
			operable: info.isFile || info.isDirectory,
			nodeVersion: await this.#nodeVersion(project.id, path, fingerprint),
			...(info.isFile ? { size: info.size } : {}),
			...(info.mtime ? { modifiedAt: info.mtime.toISOString() } : {}),
		};
	}
}

export function validateProjectPath(path: ProjectPath, allowRoot = true): string[] {
	if (!Array.isArray(path)) {
		throw new ProjectStoreError("invalid_path", "A project path must be an array of filename segments.");
	}
	if (!allowRoot && path.length === 0) {
		throw new ProjectStoreError("invalid_path", "The project root cannot be used for this operation.");
	}
	if (path.length > MAX_PATH_SEGMENTS) {
		throw new ProjectStoreError("invalid_path", "The project path has too many segments.");
	}

	let totalBytes = 0;
	const validated: string[] = [];
	for (let index = 0; index < path.length; index += 1) {
		const value: unknown = path[index];
		if (typeof value !== "string" || !isValidExistingEntryName(value)) {
			throw new ProjectStoreError("invalid_path", "A project path contains an invalid filename segment.");
		}
		if (index === 0 && DRIVE_QUALIFIED.test(value)) {
			throw new ProjectStoreError("invalid_path", "Absolute and drive-qualified project paths are not accepted.");
		}
		const bytes = textEncoder.encode(value).byteLength;
		if (bytes > MAX_SEGMENT_BYTES) {
			throw new ProjectStoreError("invalid_path", "A project path segment is too long.");
		}
		totalBytes += bytes + (index === 0 ? 0 : 1);
		if (totalBytes > MAX_PATH_BYTES) {
			throw new ProjectStoreError("invalid_path", "The project path is too long.");
		}
		validated.push(value);
	}
	return validated;
}

function validateEntryName(name: string): string {
	return validateProjectPath([name], false)[0] as string;
}

function isValidExistingEntryName(name: string): boolean {
	return name.length > 0 && name !== "." && name !== ".." && !name.includes("/") && !name.includes("\\") &&
		!DRIVE_QUALIFIED.test(name) && !hasControlCharacter(name) &&
		textEncoder.encode(name).byteLength <= MAX_SEGMENT_BYTES;
}

function validateDisplayName(displayName: string): string {
	if (typeof displayName !== "string") {
		throw new ProjectStoreError("invalid_display_name", "The project display name must be text.");
	}
	const normalized = displayName.trim();
	if (
		normalized.length === 0 || normalized.length > MAX_DISPLAY_NAME_LENGTH || hasControlCharacter(normalized)
	) {
		throw new ProjectStoreError("invalid_display_name", "The project display name is invalid.");
	}
	return normalized;
}

function validateOpaqueId(id: string): void {
	if (
		typeof id !== "string" || id.length < 8 || id.length > 128 || hasControlCharacter(id) || id.includes("/") ||
		id.includes("\\") || !OPAQUE_ID.test(id)
	) {
		throw new ProjectStoreError("invalid_project_id", "The project identifier is invalid.");
	}
}

function hasControlCharacter(value: string): boolean {
	for (const character of value) {
		const codePoint = character.codePointAt(0) as number;
		if (codePoint <= 0x1f || codePoint === 0x7f) return true;
	}
	return false;
}

function toProjectSummary(project: StoredProject): ProjectSummary {
	return {
		id: project.id,
		displayName: project.displayName,
		identity: {
			kind: "local-sandbox",
			sandboxId: project.identity.sandboxId,
			relativeRoot: [...project.identity.relativeRoot],
		},
		createdAt: project.createdAt,
		lastOpenedAt: project.lastOpenedAt,
		revision: project.revision,
	};
}

function nodeFingerprint(info: Deno.FileInfo): NodeFingerprint {
	return {
		kind: kindOf(info),
		dev: info.dev,
		ino: info.ino,
		size: info.size,
		mtimeMs: info.mtime?.getTime() ?? null,
		ctimeMs: info.ctime?.getTime() ?? null,
	};
}

function kindOf(info: Deno.FileInfo): ProjectTreeNodeKind {
	if (info.isDirectory) return "directory";
	if (info.isFile) return "file";
	if (info.isSymlink) return "symlink";
	return "other";
}

function rootIdentity(info: Deno.FileInfo): RootIdentity {
	return { dev: info.dev, ino: info.ino };
}

function rootIdentitiesEqual(left: RootIdentity, right: RootIdentity): boolean {
	if (left.ino !== null && right.ino !== null) return left.dev === right.dev && left.ino === right.ino;
	return left.dev === right.dev;
}

function fingerprintsEqual(left: NodeFingerprint, right: NodeFingerprint): boolean {
	return left.kind === right.kind && left.dev === right.dev && left.ino === right.ino && left.size === right.size &&
		left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

function assertContained(root: string, candidate: string): void {
	const relativePath = relative(root, candidate);
	if (
		relativePath !== "" &&
		(isAbsolute(relativePath) || relativePath === ".." || relativePath.startsWith(`..${sep}`))
	) {
		throw new ProjectStoreError("outside_project", "The requested path is outside the registered project.");
	}
}

function sameCanonicalPath(left: string, right: string): boolean {
	return relative(left, right) === "" && relative(right, left) === "";
}

function isCanonicalAncestor(parent: string, candidate: string): boolean {
	const relativePath = relative(parent, candidate);
	return relativePath !== "" && !isAbsolute(relativePath) && relativePath !== ".." &&
		!relativePath.startsWith(`..${sep}`);
}

function pathsEqual(left: ProjectPath, right: ProjectPath): boolean {
	return left.length === right.length && left.every((segment, index) => segment === right[index]);
}

function isPathPrefix(parent: ProjectPath, candidate: ProjectPath): boolean {
	return parent.length < candidate.length && parent.every((segment, index) => segment === candidate[index]);
}

async function assertDoesNotExist(path: string): Promise<void> {
	try {
		await Deno.lstat(path);
		throw new ProjectStoreError("already_exists", "The move destination already exists.");
	} catch (error) {
		if (error instanceof Deno.errors.NotFound) return;
		if (error instanceof ProjectStoreError) throw error;
		throw mapFilesystemError(error, "filesystem_error", "The move destination could not be checked.");
	}
}

async function directoryHasEntry(path: string): Promise<boolean> {
	try {
		for await (const _entry of Deno.readDir(path)) return true;
		return false;
	} catch (error) {
		throw mapFilesystemError(error, "filesystem_error", "The project directory could not be inspected.");
	}
}

async function safeLstat(path: string, message: string): Promise<Deno.FileInfo> {
	try {
		return await Deno.lstat(path);
	} catch (error) {
		throw mapFilesystemError(error, "filesystem_error", message);
	}
}

async function safeRealPath(path: string, message: string): Promise<string> {
	try {
		return await Deno.realPath(path);
	} catch (error) {
		throw mapFilesystemError(error, "filesystem_error", message);
	}
}

function mapFilesystemError(
	error: unknown,
	fallbackCode: ProjectStoreErrorCode,
	message: string,
): ProjectStoreError {
	if (error instanceof ProjectStoreError) return error;
	if (error instanceof Deno.errors.NotFound) return new ProjectStoreError("not_found", message);
	if (error instanceof Deno.errors.AlreadyExists) return new ProjectStoreError("already_exists", message);
	if (error instanceof Deno.errors.NotADirectory) return new ProjectStoreError("not_directory", message);
	if (error instanceof Deno.errors.PermissionDenied || error instanceof Deno.errors.NotCapable) {
		return new ProjectStoreError("permission_denied", message);
	}
	return new ProjectStoreError(fallbackCode, message);
}

function boundedInteger(value: number | undefined, fallback: number, minimum: number, hardMaximum: number): number {
	if (value === undefined) return fallback;
	if (!Number.isSafeInteger(value) || value < minimum) {
		throw new ProjectStoreError("invalid_path", "A tree limit is invalid.");
	}
	return Math.min(value, hardMaximum);
}

function codePointCompare(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}
