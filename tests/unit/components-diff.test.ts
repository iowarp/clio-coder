import { deepStrictEqual, throws } from "node:assert/strict";
import { describe, it } from "node:test";
import type { ComponentSnapshot, HarnessComponent } from "../../src/domains/components/index.js";
import { diffComponentSnapshots, parseComponentSnapshot } from "../../src/domains/components/index.js";

describe("components snapshot diff", () => {
	it("reports added, removed, changed, and unchanged components deterministically", () => {
		const shared = component("context-file:CLIO.md", "context-file", "CLIO.md", "a");
		const removed = component("doc-spec:docs/specs/old.md", "doc-spec", "docs/specs/old.md", "b");
		const changedBefore = component(
			"tool-implementation:src/tools/bash.ts",
			"tool-implementation",
			"src/tools/bash.ts",
			"c",
		);
		const changedAfter = component(
			"tool-implementation:src/tools/bash.ts",
			"tool-implementation",
			"src/tools/bash.ts",
			"d",
		);
		const added = component("prompt-fragment:src/domains/prompts/fragments/new.md", "prompt-fragment", "new.md", "e");

		const diff = diffComponentSnapshots(
			snapshot([changedBefore, removed, shared], "2026-04-29T00:00:00.000Z"),
			snapshot([added, changedAfter, shared], "2026-04-29T00:01:00.000Z"),
		);

		deepStrictEqual(diff.summary, { added: 1, removed: 1, changed: 1, unchanged: 1 });
		deepStrictEqual(
			diff.added.map((item) => item.id),
			["prompt-fragment:src/domains/prompts/fragments/new.md"],
		);
		deepStrictEqual(
			diff.removed.map((item) => item.id),
			["doc-spec:docs/specs/old.md"],
		);
		deepStrictEqual(
			diff.changed.map((item) => ({ id: item.id, fields: item.changedFields })),
			[{ id: "tool-implementation:src/tools/bash.ts", fields: ["contentHash"] }],
		);
		deepStrictEqual(diff.from, {
			root: "/repo",
			generatedAt: "2026-04-29T00:00:00.000Z",
			componentCount: 3,
		});
		deepStrictEqual(diff.to, {
			root: "/repo",
			generatedAt: "2026-04-29T00:01:00.000Z",
			componentCount: 3,
		});
	});

	it("throws on duplicate ids to avoid ambiguous diffs", () => {
		const duplicate = component("context-file:CLIO.md", "context-file", "CLIO.md", "a");
		throws(
			() => diffComponentSnapshots(snapshot([duplicate, duplicate]), snapshot([])),
			/duplicate id: context-file:CLIO\.md/,
		);
	});

	it("validates snapshot JSON before diffing", () => {
		throws(() => parseComponentSnapshot({ version: 2 }, "bad.json"), /expected version 1/);
		throws(
			() =>
				parseComponentSnapshot(
					{
						version: 1,
						generatedAt: "2026-04-29T00:00:00.000Z",
						root: "/repo",
						components: [{ id: "x" }],
					},
					"bad.json",
				),
			/expected kind/,
		);
	});
});

function snapshot(
	components: ReadonlyArray<HarnessComponent>,
	generatedAt = "2026-04-29T00:00:00.000Z",
): ComponentSnapshot {
	return {
		version: 1,
		generatedAt,
		root: "/repo",
		components: [...components],
	};
}

function component(id: string, kind: HarnessComponent["kind"], path: string, hashSeed: string): HarnessComponent {
	const authority = kind === "doc-spec" ? "descriptive" : kind === "context-file" ? "advisory" : "enforcing";
	const reloadClass = kind === "doc-spec" ? "static" : kind === "context-file" ? "hot" : "hot";
	return {
		id,
		kind,
		path,
		ownerDomain: "test",
		mutable: true,
		authority,
		reloadClass,
		contentHash: hashSeed.repeat(64),
	};
}
