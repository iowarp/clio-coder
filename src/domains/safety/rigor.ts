/**
 * Rigor is a single attribute, orthogonal to the autonomy permission levels.
 * Permission (`read-only` / `suggest` / `auto-edit` / `full-auto`) says what an
 * agent may touch; rigor says what evidence "done" requires. It has two values:
 *
 * - `normal`: the finish-contract advisory stays a soft `warn` reminder.
 * - `high`: an unvalidated completion claim re-prompts the model to run
 *   validation or state a limitation before the turn settles.
 *
 * Rigor resolves from a per-session / per-dispatch override (the `CLIO_CODER_RIGOR`
 * env var today) layered over a repo-derived default. The repo-derived default
 * is `high` when the workspace declares a scientific-validation contract by the
 * documented path convention below, and `normal` otherwise. This keeps the
 * evidence bar derived from what the repo actually is rather than from a global
 * toggle.
 */

import { existsSync } from "node:fs";
import path from "node:path";

export type Rigor = "normal" | "high";

/**
 * Workspace-root files that declare a scientific-validation contract. Presence
 * of any one of these raises the repo-derived rigor default to `high`. The
 * convention is intentionally small and explicit: a project opts into a higher
 * evidence bar by committing a validation contract at its root.
 */
const VALIDATION_CONTRACT_FILES: ReadonlyArray<string> = [
	path.join(".clio-coder", "validation.yaml"),
	path.join(".clio-coder", "validation.yml"),
	"validation.yaml",
	"validation.yml",
	"VALIDATION.md",
];

/**
 * Resolve the effective rigor. An explicit override (`"high"` | `"normal"`)
 * always wins; otherwise the repo-derived default keys off the presence of a
 * validation contract at the workspace root.
 */
export function resolveRigor(options: { cwd?: string; override?: Rigor | null }): Rigor {
	if (options.override === "high" || options.override === "normal") return options.override;
	const cwd = options.cwd ?? process.cwd();
	return hasValidationContract(cwd) ? "high" : "normal";
}

/**
 * Parse a rigor override string (e.g. from the `CLIO_CODER_RIGOR` env var). Accepts
 * `"high"` or `"normal"` case-insensitively after trimming; anything else
 * yields `null` (no override).
 */
export function parseRigorOverride(value: string | null | undefined): Rigor | null {
	if (typeof value !== "string") return null;
	const normalized = value.trim().toLowerCase();
	if (normalized === "high") return "high";
	if (normalized === "normal") return "normal";
	return null;
}

/**
 * True when the workspace declares a scientific-validation contract by the
 * documented path convention. Pure and resilient: any filesystem error is
 * swallowed and treated as "no contract".
 */
function hasValidationContract(cwd: string): boolean {
	try {
		return VALIDATION_CONTRACT_FILES.some((relative) => existsSync(path.join(cwd, relative)));
	} catch {
		return false;
	}
}
