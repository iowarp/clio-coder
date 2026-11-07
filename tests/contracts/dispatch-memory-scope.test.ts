import { ok } from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import { buildDispatchMemorySection } from "../../src/domains/memory/dispatch-section.js";
import { memoryStorePath } from "../../src/domains/memory/store.js";
import type { MemoryRecord } from "../../src/domains/memory/types.js";

function repoRecord(id: string, repo: string, lesson: string): MemoryRecord {
	return {
		id,
		scope: "repo",
		key: `lesson-${id}`,
		lesson,
		evidenceRefs: ["run:synthetic"],
		appliesWhen: [],
		avoidWhen: [],
		confidence: 0.9,
		createdAt: "2026-09-21T00:00:00.000Z",
		approved: true,
		repository: { kind: "canonical-path", key: repo },
	};
}

test("a worker dispatched into another checkout carries that checkout's memory, not the host's", (t) => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "clio-coder-dispatch-scope-")));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const host = join(root, "host");
	const other = join(root, "other");
	mkdirSync(host);
	mkdirSync(other);
	mkdirSync(join(root, "memory"));
	writeFileSync(
		memoryStorePath(root),
		JSON.stringify({
			version: 1,
			records: [
				repoRecord("mem-00000000000000b1", host, "HOST-ONLY lesson about the host checkout."),
				repoRecord("mem-00000000000000b2", other, "OTHER-ONLY lesson about the other checkout."),
			],
		}),
	);
	const build = (workerCwd?: string) =>
		buildDispatchMemorySection({
			dataDir: root,
			cwd: host,
			...(workerCwd !== undefined ? { workerCwd } : {}),
			settings: DEFAULT_SETTINGS,
			route: { agentId: "worker" },
		});
	const local = build();
	ok(local.includes("HOST-ONLY") && !local.includes("OTHER-ONLY"), local);
	for (const workerCwd of [other, "../other"]) {
		const remote = build(workerCwd);
		ok(remote.includes("OTHER-ONLY"), remote);
		ok(!remote.includes("HOST-ONLY"), `host memory leaked into a worker in ${workerCwd}`);
	}
});
