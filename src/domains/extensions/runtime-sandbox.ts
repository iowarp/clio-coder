import { lstatSync, mkdirSync } from "node:fs";
import path from "node:path";
import { canonicalizeExistingPath } from "../../core/path-canonical.js";
import { sandboxAvailability } from "../../core/sandbox/availability.js";
import {
	type SandboxAvailability,
	type SandboxBackend,
	WORKER_SANDBOX_SPEC_VERSION,
} from "../../core/sandbox/types.js";
import { composeWorkerSandboxInvocation } from "../../core/sandbox/worker-process.js";
import { workspaceTrustDirectory } from "../../core/workspace-trust.js";
import { clioConfigDir } from "../../core/xdg.js";
import type { ExtensionRuntimeDeclarationV2 } from "./manifest-v2.js";

/**
 * What confines one runtime beyond its Node permission flags, said the way
 * `/extensions` shows it. The flags are a seat belt against mistakes; the OS
 * sandbox is what actually refuses a socket or a write outside the roots.
 */
export interface ExtensionSandboxReport {
	/** The OS backend wrapping the child, or null when only the Node flags apply. */
	backend: SandboxBackend | null;
	/** `blocked` and `allowed` follow the declaration; `unenforced` is a declared `net: false` nothing enforces. */
	network: "blocked" | "allowed" | "unenforced";
	/** Why no OS sandbox wrapped the child, when none did. */
	reason?: string;
}

export interface ExtensionLaunchRoots {
	workspace: string;
	/** The private package copy; its parent is the per-runtime temporary directory. */
	packageCopy: string;
	storeDir: string;
	bootstrap: string;
}

export interface ExtensionLaunch {
	file: string;
	args: string[];
	report: ExtensionSandboxReport;
}

function contained(root: string, candidate: string): boolean {
	const relative = path.relative(root, candidate);
	return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

/** Paths a runtime tool or a subprocess it starts must never write: project and user installed trees, state, trust and policy. */
function managedPaths(workspace: string): string[] {
	return [path.join(workspace, ".clio-coder"), clioConfigDir(), workspaceTrustDirectory()].map((entry) =>
		canonicalizeExistingPath(entry),
	);
}

/**
 * Refuse a declared write root that reaches Clio's own installed resources,
 * state, trust, policy or Git metadata, by name, as a broad ancestor or through an alias.
 * Roots resolve physically here, so a link inside the workspace cannot name
 * `.clio-coder` under another spelling, and a root that lands outside the
 * workspace is refused too.
 */
function assertDeclaredWriteRoots(declaration: ExtensionRuntimeDeclarationV2, workspace: string): void {
	const home = canonicalizeExistingPath(workspace);
	const managed = managedPaths(home);
	for (const entry of declaration.permissions.fs.write) {
		if (entry === "store") continue;
		const root = canonicalizeExistingPath(path.join(home, entry));
		if (!contained(home, root)) throw new Error(`declared write root ${entry} resolves outside the workspace`);
		const hit = managed.find((protectedPath) => contained(protectedPath, root) || contained(root, protectedPath));
		if (hit) throw new Error(`declared write root ${entry} overlaps Clio-managed path ${hit}`);
		// The sandbox keeps Git metadata read-only, and creating the root would plant a .git in a non-repository.
		if (contained(path.join(home, ".git"), root)) throw new Error(`declared write root ${entry} is inside Git metadata`);
	}
}

/**
 * Create the declared write roots that do not exist yet, so the OS sandbox binds
 * exactly each declared directory and never a parent. This runs after
 * `assertDeclaredWriteRoots`, one component at a time from the physical
 * workspace, and refuses any component that is not a plain directory: a root
 * never exists through a link, and a link cannot be swapped in underneath it.
 */
export function prepareDeclaredWriteRoots(declaration: ExtensionRuntimeDeclarationV2, workspace: string): void {
	assertDeclaredWriteRoots(declaration, workspace);
	const home = canonicalizeExistingPath(workspace);
	for (const entry of declaration.permissions.fs.write) {
		if (entry === "store") continue;
		let current = home;
		for (const segment of entry.split("/")) {
			if (segment === ".") continue;
			current = path.join(current, segment);
			try {
				mkdirSync(current);
			} catch (error) {
				// An existing component is checked below; any other failure leaves the root unusable.
				if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			}
			if (!lstatSync(current).isDirectory())
				throw new Error(`declared write root ${entry} passes through ${current}, which is not a plain directory`);
		}
	}
}

/**
 * Compose the child's launch. With an OS sandbox the child runs read-only
 * outside its declared write roots, with secrets masked, Clio-managed paths
 * re-bound read-only, and an empty network namespace unless `net` is declared.
 * Without one the child runs under the Node flags alone and the report says so,
 * so a declared `net: false` is never presented as enforced.
 */
export function planExtensionLaunch(input: {
	declaration: ExtensionRuntimeDeclarationV2;
	roots: ExtensionLaunchRoots;
	argv: ReadonlyArray<string>;
	availability?: SandboxAvailability;
}): ExtensionLaunch {
	const { declaration, roots, argv } = input;
	const net = declaration.permissions.net;
	const availability = input.availability ?? sandboxAvailability();
	const [file, ...args] = argv;
	if (file === undefined) throw new Error("extension launch has no command");
	const unenforced: ExtensionLaunch = {
		file,
		args,
		report: {
			backend: null,
			network: net ? "allowed" : "unenforced",
			reason: availability.reason ?? "no OS sandbox backend",
		},
	};
	if (!availability.available) return unenforced;
	const workspace = canonicalizeExistingPath(roots.workspace);
	const writable = new Set<string>();
	if (declaration.permissions.fs.write.includes("store")) writable.add(roots.storeDir);
	for (const entry of declaration.permissions.fs.write) if (entry !== "store") writable.add(path.join(workspace, entry));
	let invocation: ReturnType<typeof composeWorkerSandboxInvocation>;
	try {
		invocation = composeWorkerSandboxInvocation(
			{
				version: WORKER_SANDBOX_SPEC_VERSION,
				mode: "auto",
				writableRoots: [...writable],
				// Re-bound read-only after the writable roots, so a root that is a parent of the
				// project cannot rewrite Git metadata, installed resources, state or policy.
				readOnlyPaths: [path.join(workspace, ".git"), ...managedPaths(workspace)],
				gitWritablePaths: [],
				readableRoots: [workspace, path.dirname(roots.packageCopy), path.dirname(roots.bootstrap)],
				network: net,
			},
			{ argv },
			workspace,
			availability,
		);
	} catch (error) {
		return {
			...unenforced,
			report: { ...unenforced.report, reason: error instanceof Error ? error.message : String(error) },
		};
	}
	if (invocation === null) return unenforced;
	return {
		file: invocation.file,
		args: invocation.args,
		report: { backend: availability.backend, network: net ? "allowed" : "blocked" },
	};
}
