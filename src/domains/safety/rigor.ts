/**
 * Rigor is a single attribute, orthogonal to the autonomy permission levels.
 * Permission (`read-only` / `suggest` / `auto-edit` / `full-auto`) says what an
 * agent may touch; rigor says what evidence "done" requires. It has two values:
 *
 * - `normal`: the finish-contract advisory stays a soft `warn` reminder.
 * - `high`: an unvalidated completion claim re-prompts the model to run
 *   validation or record a limitation before the turn settles.
 *
 * Rigor resolves from a per-session / per-dispatch override (the `CLIO_CODER_RIGOR`
 * env var today) layered over a repo-derived default. The repo-derived default
 * is `high` only when the workspace's scientific-validation contract parses
 * under the version-1 schema in `validation-contract.ts`. A contract that
 * fails to parse is diagnosed and leaves rigor at `normal`, and a Markdown
 * `VALIDATION.md` is advisory prose that never raises rigor on its own. This
 * keeps the evidence bar derived from what the repo actually declares rather
 * than from a filename or a global toggle.
 */

import { describeValidationContract, loadValidationContract } from "./validation-contract.js";

export type Rigor = "normal" | "high";

/** Why rigor settled where it did, so a caller can print the reason. */
export type RigorSource = "override" | "validation-contract" | "invalid-contract" | "markdown-advisory" | "none";

export interface RigorResolution {
	rigor: Rigor;
	source: RigorSource;
	/** Present when a contract was found but could not raise rigor: the parse fault or the Markdown advisory note. */
	diagnostic?: string;
	/** The repository-relative contract path, when one was found. */
	contractPath?: string;
}

export interface RigorOptions {
	cwd?: string;
	override?: Rigor | null;
}

/**
 * Resolve the effective rigor and the reason for it. An explicit override
 * (`"high"` | `"normal"`) always wins; otherwise the repo-derived default keys
 * off the parsed validation contract at the workspace root.
 */
export function rigorResolution(options: RigorOptions): RigorResolution {
	if (options.override === "high" || options.override === "normal") {
		return { rigor: options.override, source: "override" };
	}
	const cwd = options.cwd ?? process.cwd();
	const loaded = loadValidationContract(cwd);
	if (!loaded.ok) {
		const resolution: RigorResolution = { rigor: "normal", source: "invalid-contract", contractPath: loaded.path };
		const diagnostic = describeValidationContract(loaded);
		if (diagnostic !== null) resolution.diagnostic = diagnostic;
		return resolution;
	}
	if (loaded.contract !== null) {
		return { rigor: "high", source: "validation-contract", contractPath: loaded.path };
	}
	if ("advisory" in loaded) {
		const resolution: RigorResolution = { rigor: "normal", source: "markdown-advisory", contractPath: loaded.path };
		const diagnostic = describeValidationContract(loaded);
		if (diagnostic !== null) resolution.diagnostic = diagnostic;
		return resolution;
	}
	return { rigor: "normal", source: "none" };
}

/** The effective rigor alone; see {@link rigorResolution} for the reason. */
export function resolveRigor(options: RigorOptions): Rigor {
	return rigorResolution(options).rigor;
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
