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
const PRESERVED_CONTEXT_PATHS = ["CLIO.md", ".clio/agents", ".clio/skills"] as const;

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
		out(input.io, "clio context-clear cancelled; no files removed.\n");
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
			`clio context-clear removed ${removed.length === 0 ? "nothing" : removed.join(", ")}`,
			`  preserved ${preserved.join(", ")}`,
			"",
		].join("\n"),
	);
	return { action: "cleared", removed, preserved };
}
