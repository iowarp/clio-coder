import { sanitizeCallTargetText } from "../domains/safety/call-target.js";
import type { SessionContract, SessionEntry } from "../domains/session/index.js";
import { suggestSessionName } from "../domains/session/names.js";
import { filterEntriesToActivePath } from "../domains/session/tree/active-path.js";
import type { AskUserHandler } from "../tools/ask-user.js";

export interface SessionRenameDeps {
	session: Pick<SessionContract, "current" | "setName">;
	entries(): ReadonlyArray<SessionEntry>;
	leaf(): string | undefined;
	confirm?: AskUserHandler;
	notice(level: "error" | "info" | "success" | "warn", text: string): void;
	refresh(): void;
}

export async function renameCurrentSession(deps: SessionRenameDeps, explicitName?: string): Promise<void> {
	try {
		const current = deps.session.current();
		if (!current) {
			deps.notice("error", "[/rename] no current session; start one with /new or /resume first");
			return;
		}
		let name = explicitName?.trim();
		if (name === "") {
			deps.notice("error", "[/rename] session name must not be empty or whitespace-only");
			return;
		}
		if (name === undefined) {
			const suggestion = suggestSessionName(filterEntriesToActivePath(deps.entries(), deps.leaf()));
			if (!suggestion) {
				deps.notice("info", "[/rename] no conversation to name yet; use /rename <name>");
				return;
			}
			if (!deps.confirm) {
				deps.notice("error", "[/rename] confirmation is unavailable; use /rename <name>");
				return;
			}
			const result = await deps.confirm([
				{
					question: `Name this session “${suggestion}”?`,
					header: "Rename",
					options: [{ label: "Confirm" }, { label: "Cancel" }],
				},
			]);
			const answer = result.answers[0];
			if (result.cancelled || result.timedOut || answer?.auto || answer?.answer !== "Confirm") return;
			// A late confirmation cannot rename a resumed or newly forked session (#443).
			if (deps.session.current()?.id !== current.id) {
				deps.notice("warn", "[/rename] session changed; run /rename again");
				return;
			}
			name = suggestion;
		}
		deps.session.setName(name);
		deps.notice("success", `[/rename] session named ${sanitizeCallTargetText(name)}`);
		deps.refresh();
	} catch (error) {
		deps.notice("error", `[/rename] ${error instanceof Error ? error.message : String(error)}`);
	}
}
