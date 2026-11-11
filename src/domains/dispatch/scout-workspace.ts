import { type Dirent, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { canonicalizeExistingPath } from "../../core/path-canonical.js";
import { repositoryIdentity, repositoryRoot } from "../../core/project-root.js";
import { HOME_SECRET_RELATIVE_PATHS, workerSecretPaths } from "../safety/secret-paths.js";

function record(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

const SYSTEM_TREES = ["/proc", "/sys", "/dev", "/run", "/etc"];
/** Names of credential stores a directory tree may hold anywhere (`.ssh`, `.gnupg`, `.aws`, ...). */
const CREDENTIAL_NAMES = new Set(HOME_SECRET_RELATIVE_PATHS.map((entry) => entry.split("/")[0] ?? entry));
const CREDENTIAL_SCAN_DEPTH = 4;
const CREDENTIAL_SCAN_ENTRIES = 20_000;

function within(child: string, parent: string): boolean {
	const rel = path.relative(parent, child);
	return rel === "" || !(rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel));
}

function physicalOrSelf(target: string): string {
	try {
		return realpathSync(target);
	} catch {
		return path.resolve(target);
	}
}

/**
 * Whether `root` holds a credential store within a few levels. A tree too large
 * to scan counts as holding one, so the grant fails closed.
 */
function holdsCredentialStore(root: string): boolean {
	let budget = CREDENTIAL_SCAN_ENTRIES;
	const queue: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];
	for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
		let entries: Dirent[];
		try {
			entries = readdirSync(next.dir, { withFileTypes: true });
		} catch {
			continue;
		}
		budget -= entries.length;
		if (budget < 0) return true;
		for (const entry of entries) {
			if (CREDENTIAL_NAMES.has(entry.name)) return true;
			if (
				entry.isDirectory() &&
				next.depth + 1 < CREDENTIAL_SCAN_DEPTH &&
				entry.name !== "node_modules" &&
				entry.name !== ".git"
			)
				queue.push({ dir: path.join(next.dir, entry.name), depth: next.depth + 1 });
		}
	}
	return false;
}

/** Why a granted read root would expose the host or the operator's secrets, or null when it is fine. */
function sensitiveReadRoot(physical: string, workspace: string): string | null {
	if (SYSTEM_TREES.some((tree) => within(physical, physicalOrSelf(tree)) || within(physical, tree)))
		return "names a system tree (/proc, /sys, /dev, /run, /etc)";
	const home = physicalOrSelf(process.env.HOME ?? homedir());
	if (physical === home) return "names the home directory";
	if (within(workspace, physical)) return "contains the workspace";
	for (const secret of workerSecretPaths(home)) {
		const target = physicalOrSelf(secret);
		if (within(physical, target) || within(target, physical)) return "is or contains a credential store";
	}
	if (holdsCredentialStore(physical)) return "is or contains a credential store";
	return null;
}

/**
 * Absolute `intent.read_roots` the coordinator names for a worker that works in
 * its own workspace: each must be an existing directory outside that
 * workspace, and the worker may read it but never write it. They leave the
 * typed intent, whose paths stay repository-relative.
 */
function grantedReadRoots(
	raw: Record<string, unknown>,
	absolute: ReadonlyArray<string>,
	cwd: string,
	workspace: string,
	refuse: (reason: string, message: string) => { ok: false; reason: string; message: string },
):
	| { ok: true; cwd: string; intent: unknown; extraReadRoots: string[] }
	| { ok: false; reason: string; message: string } {
	const roots: string[] = [];
	for (const entry of absolute) {
		const trimmed = entry.trim();
		if (Buffer.byteLength(trimmed, "utf8") > 512 || trimmed.includes("\\")) {
			return refuse("intent_path_malformed", "Read roots must be POSIX directory paths within the 512-byte cap.");
		}
		let physical: string;
		try {
			physical = realpathSync(trimmed);
			if (!statSync(physical).isDirectory()) throw new Error("not a directory");
		} catch {
			return refuse("external_read_root_invalid", `intent.read_roots entry ${trimmed} must be an existing directory.`);
		}
		if (physical === path.parse(physical).root) {
			return refuse("external_read_root_invalid", "intent.read_roots cannot name the filesystem root.");
		}
		const rel = path.relative(workspace, physical);
		if (rel === "" || !(rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel))) {
			return refuse(
				"intent_path_absolute",
				`intent.read_roots entry ${trimmed} lies inside the workspace; name it repository-relative.`,
			);
		}
		const sensitive = sensitiveReadRoot(physical, workspace);
		if (sensitive !== null) {
			return refuse("external_read_root_invalid", `intent.read_roots entry ${trimmed} ${sensitive}.`);
		}
		roots.push(physical);
	}
	const readRoots = Array.isArray(raw.read_roots)
		? raw.read_roots.filter((entry: unknown) => !(typeof entry === "string" && path.isAbsolute(entry.trim())))
		: raw.read_roots;
	return { ok: true, cwd, intent: { ...raw, read_roots: readRoots }, extraReadRoots: [...new Set(roots)] };
}

/** Keep external inspection in one read-only worker workspace pending consent (#433). */
export function scoutReadWorkspace(input: {
	agentId: string;
	readOnlyScout: boolean;
	workspaceRoot: string;
	cwd?: string;
	intent: unknown;
	worktree: boolean;
	writeRoots: unknown;
}):
	| { ok: true; cwd: string; intent: unknown; externalReadRoot?: string; extraReadRoots?: string[] }
	| { ok: false; reason: string; message: string } {
	const raw = input.intent;
	const roots = record(raw) && Array.isArray(raw.read_roots) ? raw.read_roots : [];
	const absolute = roots.filter((root): root is string => typeof root === "string" && path.isAbsolute(root.trim()));
	const requested = path.resolve(input.workspaceRoot, input.cwd ?? ".");
	const workspace = canonicalizeExistingPath(input.workspaceRoot);
	const relative = path.relative(workspace, canonicalizeExistingPath(requested));
	const outsideCwd = relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
	if (absolute.length === 0 && !outsideCwd) return { ok: true, cwd: requested, intent: raw };
	const refuse = (reason: string, message: string) => ({ ok: false as const, reason, message: `${reason}: ${message}` });
	if (!input.readOnlyScout || input.agentId !== "scout") {
		if (!outsideCwd && record(raw)) return grantedReadRoots(raw, absolute, requested, workspace, refuse);
		return refuse(
			"intent_path_absolute",
			'For an outside checkout, dispatch agent "scout" with one absolute directory in intent.read_roots and no write_roots, expected_outputs or verification; the host asks the operator once per run and headless runs refuse that task. Write roots and outputs must remain repository-relative.',
		);
	}
	if (!record(raw))
		return refuse("intent_path_malformed", "An outside Scout workspace requires typed read-only intent.");
	if (
		input.worktree ||
		[raw.write_roots, raw.expected_outputs, raw.verification, input.writeRoots].some(
			(value) => value !== undefined && (!Array.isArray(value) || value.length > 0),
		)
	) {
		return refuse(
			"external_read_write_scope",
			"An external Scout cannot declare writes, outputs, verification, or a task worktree.",
		);
	}
	if (absolute.some((root) => Buffer.byteLength(root.trim(), "utf8") > 512 || root.includes("\\"))) {
		return refuse("intent_path_malformed", "External read roots must be POSIX directory paths within the 512-byte cap.");
	}
	try {
		const firstAbsolute = absolute[0];
		const root = realpathSync(input.cwd === undefined && firstAbsolute !== undefined ? firstAbsolute.trim() : requested);
		if (!statSync(root).isDirectory())
			return refuse("external_read_root_invalid", "The external read root must be an existing directory.");
		const rebase = (value: unknown): unknown => {
			if (!Array.isArray(value)) return value;
			return value.map((entry: unknown) => {
				if (typeof entry !== "string" || !path.isAbsolute(entry.trim())) return entry;
				const physical = realpathSync(entry.trim());
				const rel = path.relative(root, physical);
				if (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel))
					throw new Error("Use one external checkout per Scout task; all declared paths must stay inside it.");
				return rel === "" ? "." : `${rel.split(path.sep).join("/")}${statSync(physical).isDirectory() ? "/" : ""}`;
			});
		};
		return {
			ok: true,
			cwd: root,
			externalReadRoot: root,
			intent: { ...raw, read_roots: rebase(raw.read_roots), relevant_paths: rebase(raw.relevant_paths) },
		};
	} catch (error) {
		return refuse("external_read_root_invalid", error instanceof Error ? error.message : String(error));
	}
}

const DECLARED_PATH_FIELDS = ["read_roots", "write_roots", "relevant_paths", "expected_outputs"] as const;

/**
 * A task works in one repository: the one owning its cwd and every
 * repository-relative path it declares, which decides the rules its worker
 * receives. Absolute read roots granted to a worker in its own workspace are
 * read-only context and do not count. Returns the refusal, or null.
 */
export function repositorySpanRefusal(input: {
	cwd: string;
	intent: unknown;
	writeRoots: unknown;
}): { ok: false; reason: string; message: string } | null {
	const paths = [input.cwd];
	const add = (value: unknown): void => {
		if (!Array.isArray(value)) return;
		for (const entry of value) {
			const raw = typeof entry === "string" ? entry : record(entry) && typeof entry.path === "string" ? entry.path : null;
			if (raw !== null && raw.trim().length > 0 && !path.isAbsolute(raw.trim()))
				paths.push(path.resolve(input.cwd, raw.trim()));
		}
	};
	if (record(input.intent)) for (const field of DECLARED_PATH_FIELDS) add(input.intent[field]);
	add(input.writeRoots);
	const owners = new Map<string, string>();
	for (const target of paths) {
		const root = repositoryRoot(target);
		if (root === null) continue;
		const identity = repositoryIdentity(root);
		if (!owners.has(identity)) owners.set(identity, root);
	}
	if (owners.size < 2) return null;
	const roots = [...owners.values()];
	return {
		ok: false,
		reason: "task_spans_repositories",
		message: `task_spans_repositories: Use one repository per task; all declared paths must stay inside it. ${roots.join(" and ")} are separate repositories: dispatch one task per repository, with that repository as cwd, so each worker receives its own repository's rules.`,
	};
}
