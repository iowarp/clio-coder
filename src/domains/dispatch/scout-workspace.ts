import { realpathSync, statSync } from "node:fs";
import path from "node:path";
import { canonicalizeExistingPath } from "../../core/path-canonical.js";

function record(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Keep external inspection in one read-only worker workspace pending consent (#433). */
export function scoutReadWorkspace(input: {
	agentId: string;
	readOnlyScout: boolean;
	cwd?: string;
	intent: unknown;
	worktree: boolean;
	writeRoots: unknown;
}):
	| { ok: true; cwd?: string; intent: unknown; externalReadRoot?: string }
	| { ok: false; reason: string; message: string } {
	const raw = input.intent;
	const roots = record(raw) && Array.isArray(raw.read_roots) ? raw.read_roots : [];
	const absolute = roots.filter((root): root is string => typeof root === "string" && path.isAbsolute(root.trim()));
	const requested = input.cwd === undefined ? process.cwd() : path.resolve(input.cwd);
	const workspace = canonicalizeExistingPath(process.cwd());
	const relative = path.relative(workspace, canonicalizeExistingPath(requested));
	const outsideCwd = relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
	if (absolute.length === 0 && !outsideCwd) return { ok: true, ...(input.cwd ? { cwd: input.cwd } : {}), intent: raw };
	const refuse = (reason: string, message: string) => ({ ok: false as const, reason, message: `${reason}: ${message}` });
	if (!input.readOnlyScout || input.agentId !== "scout") {
		return refuse(
			"intent_path_absolute",
			"External read roots require the read-only Scout recipe and one approval per run. Write roots and outputs must remain repository-relative.",
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
