import { doesNotMatch, match, ok } from "node:assert/strict";
import { describe, it } from "node:test";
import { SESSION_START_FACTS_MAX_CHARS, sessionStartFacts } from "../../src/domains/prompts/extension.js";
import { emptyWorkspaceSnapshot } from "../../src/domains/session/workspace/index.js";
import { isolateClioEnv } from "../harness/scratch-env.js";

describe("session-start facts", () => {
	it("states the exact fresh-conversation fact within the 400-character addition", async () => {
		const env = await isolateClioEnv("clio-session-facts-");
		try {
			const workspace = {
				...emptyWorkspaceSnapshot(env.dir),
				isGit: true,
				branch: "long-branch-name-".repeat(15),
				dirty: true,
				ahead: 10,
				behind: 20,
				recentCommits: [{ sha: "a".repeat(40), subject: "long commit subject ".repeat(20) }],
			};
			const fresh = sessionStartFacts(env.dir, "", Date.now(), workspace).slice(1).join("\n");
			ok(fresh.length <= SESSION_START_FACTS_MAX_CHARS, `${fresh.length} characters`);
			match(fresh, /Before this request, this new conversation contained no assistant messages\./);
			match(fresh, /Git: branch/, "a long commit subject must not evict the branch fact");
			const resumed = sessionStartFacts(env.dir, "existing-session", Date.now(), workspace).slice(1).join("\n");
			doesNotMatch(resumed, /this new conversation contained no assistant messages/);
		} finally {
			env.restore();
		}
	});
});
