import { existsSync, rmSync } from "node:fs";

import type { BootstrapIo } from "./bootstrap.js";
import { coordinateCodewikiExclusive } from "./codewiki/coordinator.js";
import { ACCUMULATED_CONTEXT_PATHS, contextPathIn, PRESERVED_CONTEXT_PATHS } from "./reset-paths.js";

export interface RunContextClearInput {
	signal?: AbortSignal;
	cwd?: string;
	io?: BootstrapIo;
	all?: boolean;
	confirmContext?: () => boolean | Promise<boolean>;
	confirmAll?: () => boolean | Promise<boolean>;
}

export interface RunContextClearResult {
	action: "cleared" | "cancelled";
	removed: string[];
	preserved: string[];
	/** Existing protected paths, measured after the operation. */
	preservedExisting?: string[];
}

function out(io: BootstrapIo | undefined, message: string): void {
	io?.stdout(message);
}

const relativeContextPath = contextPathIn;

function removeIfPresent(cwd: string, relPath: string, removed: string[]): void {
	const absPath = relativeContextPath(cwd, relPath);
	if (!existsSync(absPath)) return;
	rmSync(absPath, { recursive: true, force: true });
	removed.push(relPath);
}

export async function runContextClear(input: RunContextClearInput = {}): Promise<RunContextClearResult> {
	input.signal?.throwIfAborted();
	const cwd = input.cwd ?? process.cwd();
	const confirmed = await input.confirmContext?.();
	input.signal?.throwIfAborted();
	if (confirmed !== true) {
		out(input.io, "clio-coder context reset cancelled; no files removed.\n");
		return {
			action: "cancelled",
			removed: [],
			preserved: [...PRESERVED_CONTEXT_PATHS],
			preservedExisting: PRESERVED_CONTEXT_PATHS.filter((path) => existsSync(relativeContextPath(cwd, path))),
		};
	}

	// Operator input must not hold the index lease or follow a partial deletion.
	const removeHandbook = input.all === true && (await input.confirmAll?.()) === true;
	const { removed, preserved } = await coordinateCodewikiExclusive(
		cwd,
		(workspace) => {
			const removed: string[] = [];
			for (const relPath of ACCUMULATED_CONTEXT_PATHS) removeIfPresent(workspace, relPath, removed);

			const preserved = [...PRESERVED_CONTEXT_PATHS];
			if (removeHandbook) {
				removeIfPresent(workspace, "CLIO-CODER.md", removed);
				const index = preserved.indexOf("CLIO-CODER.md");
				if (index !== -1) preserved.splice(index, 1);
			}
			return { removed, preserved };
		},
		input.signal,
	);

	out(
		input.io,
		[
			`clio-coder context reset removed ${removed.length === 0 ? "nothing" : removed.join(", ")}`,
			`  protected locations: ${preserved.join(", ")}`,
			"",
		].join("\n"),
	);
	return {
		action: "cleared",
		removed,
		preserved,
		preservedExisting: preserved.filter((path) => existsSync(relativeContextPath(cwd, path))),
	};
}
