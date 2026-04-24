import { ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import type { SessionMeta } from "../../src/domains/session/index.js";
import { buildSessionItems } from "../../src/interactive/overlays/session-selector.js";
import { filterSessions } from "../../src/interactive/overlays/session-selector-search.js";

function meta(id: string, overrides: Partial<SessionMeta> = {}): SessionMeta {
	return {
		id,
		cwd: "/repo",
		cwdHash: "hash",
		createdAt: "2026-04-23T01:02:03.000Z",
		endedAt: null,
		model: "model-a",
		endpoint: "target-a",
		compiledPromptHash: null,
		staticCompositionHash: null,
		clioVersion: "0.1.0-test",
		piMonoVersion: "0.0.0",
		platform: "linux",
		nodeVersion: "v20.0.0",
		...overrides,
	};
}

describe("session selector metadata", () => {
	it("searches timestamps, names, and labels", () => {
		const sessions = [
			meta("s1", { name: "release replay", labels: ["checkpointed branch"] }),
			meta("s2", { createdAt: "2026-04-22T00:00:00.000Z", name: "other" }),
		];

		strictEqual(filterSessions(sessions, "2026-04-23")[0]?.id, "s1");
		strictEqual(filterSessions(sessions, "release replay")[0]?.id, "s1");
		strictEqual(filterSessions(sessions, "checkpointed")[0]?.id, "s1");
	});

	it("renders available names and labels in rows", () => {
		const items = buildSessionItems([meta("session-abcdef", { name: "named session", labels: ["fork point"] })]);
		const first = items[0];
		ok(first, "expected a row");
		ok(first.label.includes("named session"), first.label);
		ok((first.description ?? "").includes("fork point"), first.description);
	});
});
