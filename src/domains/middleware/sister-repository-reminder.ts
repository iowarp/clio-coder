import { isAbsolute, resolve } from "node:path";
import { repositoryIdentity } from "../../core/project-root.js";
import { ToolNames } from "../../core/tool-names.js";
import { sisterRepositoryReminder, sisterRepositoryRoot, sisterRepositoryRules } from "../context/sister-repository.js";
import type { MiddlewareHookRegistration } from "./runtime.js";
import type { MiddlewareEffect } from "./types.js";

export const SISTER_REPOSITORY_REMINDER_REGISTRATION_ID = "observer.sister-repository-rules";

const NONE: ReadonlyArray<MiddlewareEffect> = [];

/**
 * When the main agent reads, lists, searches or edits files in a repository
 * the session did not start in, appends that repository's invariants to the
 * tool result as one labeled reminder: once per repository in each session,
 * and again only when its compile changes. It reads the cached compile and
 * never compiles: until the first compile lands nothing is appended, and a
 * later tool result there carries it. The session's own handbook is untouched,
 * and the reminder lands in the next request without recompiling the system
 * prompt.
 */
export function createSisterRepositoryReminderRegistration(
	deps: { getCwd?: () => string } = {},
): MiddlewareHookRegistration {
	const getCwd = deps.getCwd ?? (() => process.cwd());
	const delivered = new Map<string, string>();
	return {
		id: SISTER_REPOSITORY_REMINDER_REGISTRATION_ID,
		description: "names another repository's invariants once when the session first touches its files",
		hooks: ["after_tool"],
		evidence: "path:sister-repository@session",
		toolNames: [ToolNames.Read, ToolNames.Write, ToolNames.Edit, ToolNames.Ls, ToolNames.Find, ToolNames.Grep],
		evaluate(input): ReadonlyArray<MiddlewareEffect> {
			const path = input.toolArgs?.path;
			if (typeof path !== "string" || path.length === 0) return NONE;
			const cwd = getCwd();
			const root = sisterRepositoryRoot(isAbsolute(path) ? path : resolve(cwd, path), cwd);
			if (root === null) return NONE;
			const rules = sisterRepositoryRules(root)?.rules ?? null;
			if (rules === null) return NONE;
			const key = `${input.sessionId ?? ""}\0${repositoryIdentity(root)}`;
			if (delivered.get(key) === rules.hash) return NONE;
			delivered.set(key, rules.hash);
			const message = sisterRepositoryReminder(rules);
			return message === null ? NONE : [{ kind: "annotate_tool_result", severity: "info", message }];
		},
	};
}
