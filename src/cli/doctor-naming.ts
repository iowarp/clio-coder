import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { resolveClioDirs } from "../core/xdg.js";
import type { DoctorFinding } from "../domains/lifecycle/doctor.js";
import { inspectNamingHistory } from "../domains/lifecycle/naming-history.js";

// Released `clio` names survive only in history Clio reads but never rewrites:
// identifiers in sessions, receipts, traces and evidence, `clio/task/*` and
// `clio/compete/*` refs, and 0.4 worktree ownership markers. Settings, skills
// and runtime ids have no such aliases, so nothing here repairs anything and
// every check is read-only, including under `doctor --fix`.

function immutableHistoryNamingFinding(): DoctorFinding {
	const dirs = resolveClioDirs();
	const counts = inspectNamingHistory({ stateDir: dirs.state, dataDir: dirs.data });
	const errors = counts.filter((entry) => entry.error !== null);
	if (errors.length > 0) {
		return {
			ok: false,
			name: "naming immutable history",
			detail: errors.map((entry) => `${entry.area}: ${entry.error}`).join("; "),
		};
	}
	const legacy = counts.reduce((sum, entry) => sum + entry.legacyIdentifiers, 0);
	return {
		ok: true,
		...(legacy > 0 ? { level: "warn" as const } : {}),
		name: "naming immutable history",
		detail: `${counts.map((entry) => `${entry.area}=${entry.legacyIdentifiers}`).join("; ")} legacy identifiers; read-only retention, no rewrite`,
	};
}

function legacyGitRefsFinding(cwd: string): DoctorFinding {
	let refs: string[];
	try {
		refs = execFileSync(
			"git",
			["-C", cwd, "for-each-ref", "--format=%(refname:short)", "refs/heads/clio/task", "refs/heads/clio/compete"],
			{ encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5_000 },
		)
			.split("\n")
			.map((entry) => entry.trim())
			.filter((entry) => /^clio\/(?:task|compete)\//u.test(entry))
			.sort();
	} catch {
		refs = [];
	}
	if (refs.length === 0) {
		return { ok: true, name: "naming git refs", detail: "no legacy Clio Coder task or compete refs found" };
	}
	const shown = refs.slice(0, 20);
	return {
		ok: true,
		level: "warn",
		name: "naming git refs",
		detail: `${refs.length} legacy refs retained (never auto-renamed): ${shown.join(", ")}${refs.length > shown.length ? ", …" : ""}`,
	};
}

function legacyWorktreeMarkerFinding(cwd: string): DoctorFinding {
	const root = join(cwd, ".clio-coder", "worktrees");
	let legacy = 0;
	try {
		for (const entry of readdirSync(root, { withFileTypes: true })) {
			const candidates = entry.isFile()
				? entry.name.endsWith(".task-owner.json")
					? [join(root, entry.name)]
					: []
				: entry.isDirectory()
					? [join(root, entry.name, ".clio-coder-compete-owner.json")]
					: [];
			for (const path of candidates) {
				if (!existsSync(path)) continue;
				const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
				if (parsed.kind === "clio-task-worktree" || parsed.kind === "clio-compete-group") legacy += 1;
			}
		}
	} catch {
		// An absent or partially unreadable project-local worktree root is not a
		// repair target. Proven markers remain the lifecycle readers' authority.
	}
	return {
		ok: true,
		...(legacy > 0 ? { level: "warn" as const } : {}),
		name: "naming worktree markers",
		detail:
			legacy === 0
				? "active worktree markers use canonical identifiers"
				: `${legacy} active legacy worktree markers retained for cleanup compatibility; no automatic rewrite`,
	};
}

/** Read-only report of released names retained in immutable history. */
export function namingHistoryFindings(options: { cwd?: string } = {}): DoctorFinding[] {
	const cwd = options.cwd ?? process.cwd();
	return [immutableHistoryNamingFinding(), legacyGitRefsFinding(cwd), legacyWorktreeMarkerFinding(cwd)];
}
