import { existsSync } from "node:fs";
import { join } from "node:path";

/** What `/context reset` removes: context Clio generated for this project. */
export const ACCUMULATED_CONTEXT_PATHS = [
	".clio-coder/codemap.json",
	".clio-coder/codewiki.json",
	".clio-coder/state.json",
	".clio-coder/handoffs",
	".clio-coder/proposals",
] as const;

/**
 * Kept, and said to be kept. `.clio-coder/wiki` is Clio-written rather than
 * operator-authored, so it does not belong with the handbooks and the overlay
 * directories on merit; it is listed because the reset reports exactly two
 * categories and a reader takes anything absent from both to be gone. It is the
 * most expensive artifact in `.clio-coder` (one model dispatch per page), and leaving
 * it unnamed made a reset look like it had discarded a wiki it had not touched.
 */
export const PRESERVED_CONTEXT_PATHS = [
	"CLIO-CODER.md",
	"CLIO-CODER.override.md",
	".clio-coder/agents",
	".clio-coder/skills",
	".clio-coder/wiki",
] as const;

export function contextPathIn(cwd: string, relPath: string): string {
	return join(cwd, ...relPath.split("/"));
}

/** What a reset in `cwd` would touch right now, measured on disk, for the chooser that asks first. */
export function contextResetPreview(cwd: string): { removes: string[]; keeps: string[]; handbook: boolean } {
	const present = (relPath: string): boolean => existsSync(contextPathIn(cwd, relPath));
	return {
		removes: ACCUMULATED_CONTEXT_PATHS.filter(present),
		keeps: PRESERVED_CONTEXT_PATHS.filter((relPath) => relPath !== "CLIO-CODER.md" && present(relPath)),
		handbook: present("CLIO-CODER.md"),
	};
}
