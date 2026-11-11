import { realpathSync, statSync } from "node:fs";
import path from "node:path";
import { canonicalizeExistingPath } from "../../core/path-canonical.js";

function record(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
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
