import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { clioProjectRoot } from "../../core/project-root.js";

/** Where `context init` records each handbook rule's verdict; `--verify` refreshes it against the tree. */
export function handbookLedgerPath(cwd: string): string {
	return join(cwd, ".clio-coder", "state", "handbook-ledger.json");
}

/**
 * The repository root above `cwd`, or `cwd` outside Git. `--verify` judges the
 * effective handbook from there and records it in that root's ledger, so every
 * reader of the verify record resolves the same directory.
 */
export function handbookRoot(cwd: string): string {
	return clioProjectRoot(cwd);
}

interface LedgerFileShape {
	commit?: unknown;
	verifiedCommit?: unknown;
	/** The rules `--verify` judged; `entries` holds what `context init` judged while adopting. */
	verification?: unknown;
}

/** What the ledger says about the effective handbook: the commit it was verified at and the rules needing attention. */
export interface HandbookFreshness {
	verifiedCommit: string | null;
	attention: number;
}

export function readHandbookFreshness(cwd: string): HandbookFreshness {
	let parsed: LedgerFileShape;
	try {
		parsed = JSON.parse(readFileSync(handbookLedgerPath(handbookRoot(cwd)), "utf8")) as LedgerFileShape;
	} catch {
		return { verifiedCommit: null, attention: 0 };
	}
	const verifiedCommit = typeof parsed.verifiedCommit === "string" ? parsed.verifiedCommit : null;
	if (verifiedCommit === null) return { verifiedCommit, attention: 0 };
	const entries = Array.isArray(parsed.verification) ? parsed.verification : [];
	const attention = entries.filter((entry: unknown) => {
		const verdict = (entry as { verdict?: unknown } | null)?.verdict;
		return verdict === "stale" || verdict === "contradicted";
	}).length;
	return { verifiedCommit, attention };
}

/** Commits on HEAD since `commit`, or null when Git cannot say. */
function commitsBehind(cwd: string, commit: string): number | null {
	try {
		const out = execFileSync("git", ["rev-list", "--count", `${commit}..HEAD`], {
			cwd,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
			timeout: 2000,
		});
		const count = Number(out.trim());
		return Number.isFinite(count) ? count : null;
	} catch {
		return null;
	}
}

/** The handbook freshness line `clio-coder context` prints. */
export function describeHandbookFreshness(cwd: string): string {
	const { verifiedCommit, attention } = readHandbookFreshness(cwd);
	if (verifiedCommit === null) return "never verified";
	const behind = commitsBehind(cwd, verifiedCommit);
	const distance = behind === null ? "unknown commits behind" : `${behind} commit${behind === 1 ? "" : "s"} behind`;
	return `verified at ${verifiedCommit.slice(0, 12)}, ${distance}; ${attention} rule${attention === 1 ? "" : "s"} need${attention === 1 ? "s" : ""} attention`;
}
