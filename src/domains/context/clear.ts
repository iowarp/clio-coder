import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";

import type { BootstrapIo } from "./bootstrap.js";

export interface RunContextClearInput {
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
}

const ACCUMULATED_CONTEXT_PATHS = [
	".clio/codewiki.json",
	".clio/state.json",
	".clio/handoffs",
	".clio/proposals",
] as const;
/**
 * Kept, and said to be kept. `.clio/wiki` is Clio-written rather than
 * operator-authored, so it does not belong with the handbook and the overlay
 * directories on merit; it is listed because the reset reports exactly two
 * categories and a reader takes anything absent from both to be gone. It is the
 * most expensive artifact in `.clio` (one model dispatch per page), and leaving
 * it unnamed made a reset look like it had discarded a wiki it had not touched.
 */
const PRESERVED_CONTEXT_PATHS = ["CLIO.md", ".clio/agents", ".clio/skills", ".clio/wiki"] as const;

function out(io: BootstrapIo | undefined, message: string): void {
	io?.stdout(message);
}

function relativeContextPath(cwd: string, relPath: string): string {
	return join(cwd, ...relPath.split("/"));
}

function removeIfPresent(cwd: string, relPath: string, removed: string[]): void {
	const absPath = relativeContextPath(cwd, relPath);
	if (!existsSync(absPath)) return;
	rmSync(absPath, { recursive: true, force: true });
	removed.push(relPath);
}

export async function runContextClear(input: RunContextClearInput = {}): Promise<RunContextClearResult> {
	const cwd = input.cwd ?? process.cwd();
	const confirmed = await input.confirmContext?.();
	if (confirmed !== true) {
		out(input.io, "clio context reset cancelled; no files removed.\n");
		return { action: "cancelled", removed: [], preserved: [...PRESERVED_CONTEXT_PATHS] };
	}

	const removed: string[] = [];
	for (const relPath of ACCUMULATED_CONTEXT_PATHS) removeIfPresent(cwd, relPath, removed);

	const preserved = [...PRESERVED_CONTEXT_PATHS];
	if (input.all === true) {
		const confirmedAll = await input.confirmAll?.();
		if (confirmedAll === true) {
			removeIfPresent(cwd, "CLIO.md", removed);
			const index = preserved.indexOf("CLIO.md");
			if (index !== -1) preserved.splice(index, 1);
		}
	}

	out(
		input.io,
		[
			`clio context reset removed ${removed.length === 0 ? "nothing" : removed.join(", ")}`,
			`  preserved ${preserved.join(", ")}`,
			"",
		].join("\n"),
	);
	return { action: "cleared", removed, preserved };
}
