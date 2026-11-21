/**
 * The operator's user handbook: `<config>/CLIO-CODER.md`, standing
 * instructions CLIO Coder loads ahead of every project handbook. The context
 * domain reads it into the prompt; interop adoption writes the instruction
 * files other agents load for every session (~/.claude/CLAUDE.md,
 * ~/.codex/AGENTS.md) into it after review. Both go through this path and cap.
 */
import path from "node:path";
import { clioConfigDir } from "./xdg.js";

export const USER_HANDBOOK_FILENAME = "CLIO-CODER.md";

/** Larger is refused, not cut: the file rides in every session's prompt. */
export const USER_HANDBOOK_MAX_BYTES = 32 * 1024;

export function clioUserHandbookPath(): string {
	return path.join(clioConfigDir(), USER_HANDBOOK_FILENAME);
}
