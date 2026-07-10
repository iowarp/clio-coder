import { deepStrictEqual, match, ok } from "node:assert/strict";
import { mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { canonicalMemoryRepositoryIdentity, selectApprovedMemory } from "../../src/domains/memory/operations.js";
import { buildMemoryPromptSection, renderMemoryPromptSection } from "../../src/domains/memory/prompt-section.js";
import type { MemoryRecord, MemoryRepositoryIdentity } from "../../src/domains/memory/types.js";
import { validateMemoryRecord, validateMemoryStore } from "../../src/domains/memory/validate.js";

const REPO_A: MemoryRepositoryIdentity = { kind: "canonical-path", key: "/memory-contract/repo-a" };
const REPO_B: MemoryRepositoryIdentity = { kind: "canonical-path", key: "/memory-contract/repo-b" };

interface RecordInput {
	id: string;
	scope?: MemoryRecord["scope"];
	appliesWhen?: string[];
	repository?: MemoryRepositoryIdentity;
}

function memoryRecord(input: RecordInput): MemoryRecord {
	const record: MemoryRecord = {
		id: input.id,
		scope: input.scope ?? "repo",
		key: `key:${input.id}`,
		lesson: `Lesson for ${input.id}.`,
		evidenceRefs: [`evidence:${input.id}`],
		appliesWhen: input.appliesWhen ?? [],
		avoidWhen: [],
		confidence: 0.9,
		createdAt: "2026-01-01T00:00:00.000Z",
		approved: true,
	};
	if (input.repository !== undefined) record.repository = input.repository;
	return record;
}

function selectedIds(
	records: ReadonlyArray<MemoryRecord>,
	activeRepository: MemoryRepositoryIdentity | null,
): string[] {
	return selectApprovedMemory(records, {
		scopes: ["global", "repo"],
		tokenBudget: 10_000,
		activeRepository,
	})
		.map((record) => record.id)
		.sort();
}

describe("contracts/memory repository scope", () => {
	it("selects only the active repository plus global memory", () => {
		const records = [
			memoryRecord({ id: "mem-0000000000000001", scope: "global" }),
			memoryRecord({ id: "mem-0000000000000002", repository: REPO_A }),
			memoryRecord({ id: "mem-0000000000000003", repository: REPO_B }),
			memoryRecord({ id: "mem-0000000000000004" }),
		];

		deepStrictEqual(selectedIds(records, REPO_A), ["mem-0000000000000001", "mem-0000000000000002"]);
		deepStrictEqual(selectedIds(records, REPO_B), ["mem-0000000000000001", "mem-0000000000000003"]);
		deepStrictEqual(selectedIds(records, null), ["mem-0000000000000001"]);
	});

	it("ignores appliesWhen tokens for repository applicability and fails closed without the structured field", () => {
		const records = [
			memoryRecord({ id: "mem-0000000000000010", appliesWhen: [`repository:canonical-path:${REPO_A.key}`] }),
			memoryRecord({ id: "mem-0000000000000011", appliesWhen: [`cwd:${REPO_A.key}`] }),
			memoryRecord({
				id: "mem-0000000000000012",
				repository: REPO_A,
				appliesWhen: [`cwd:${REPO_B.key}`],
			}),
		];

		// Tokens grant nothing; the structured field alone decides, and stray
		// tokens on a structured record cannot broaden it to another repository.
		deepStrictEqual(selectedIds(records, REPO_A), ["mem-0000000000000012"]);
		deepStrictEqual(selectedIds(records, REPO_B), []);
	});

	it("normalizes symlink aliases but keeps worktrees and moved paths distinct", () => {
		const scratch = mkdtempSync(join(tmpdir(), "clio-memory-repository-"));
		try {
			const original = join(scratch, "repository");
			const alias = join(scratch, "repository-link");
			const worktree = join(scratch, "worktree");
			const moved = join(scratch, "repository-moved");
			mkdirSync(original);
			mkdirSync(worktree);
			symlinkSync(original, alias, "dir");

			const originalIdentity = canonicalMemoryRepositoryIdentity(original);
			const aliasIdentity = canonicalMemoryRepositoryIdentity(alias);
			const worktreeIdentity = canonicalMemoryRepositoryIdentity(worktree);
			ok(originalIdentity !== null);
			ok(aliasIdentity !== null);
			ok(worktreeIdentity !== null);
			deepStrictEqual(aliasIdentity, originalIdentity);
			ok(worktreeIdentity.key !== originalIdentity.key);

			const records = [
				memoryRecord({ id: "mem-0000000000000020", scope: "global" }),
				memoryRecord({ id: "mem-0000000000000021", repository: originalIdentity }),
			];
			deepStrictEqual(selectedIds(records, aliasIdentity), ["mem-0000000000000020", "mem-0000000000000021"]);
			deepStrictEqual(selectedIds(records, worktreeIdentity), ["mem-0000000000000020"]);

			renameSync(original, moved);
			const movedIdentity = canonicalMemoryRepositoryIdentity(moved);
			ok(movedIdentity !== null);
			ok(movedIdentity.key !== originalIdentity.key);
			deepStrictEqual(selectedIds(records, movedIdentity), ["mem-0000000000000020"]);
		} finally {
			rmSync(scratch, { recursive: true, force: true });
		}
	});

	it("requires the structured key on repo records and preserves it through validation", () => {
		const record = memoryRecord({ id: "mem-0000000000000030", repository: REPO_A });
		const validated = validateMemoryRecord(record);
		ok(validated.valid);
		deepStrictEqual(validated.record.repository, REPO_A);

		const store = validateMemoryStore({ version: 1, records: [record] });
		ok(store.valid);
		deepStrictEqual(store.store.records[0]?.repository, REPO_A);

		const invalidGlobal = validateMemoryRecord({ ...record, scope: "global" });
		ok(!invalidGlobal.valid);
		ok(invalidGlobal.issues.some((issue) => issue.path === "$.repository"));
		const missingRepository = validateMemoryRecord(memoryRecord({ id: "mem-0000000000000031" }));
		ok(!missingRepository.valid);
		ok(missingRepository.issues.some((issue) => issue.path === "$.repository"));
		const invalidRelative = validateMemoryRecord({
			...record,
			repository: { kind: "canonical-path", key: "relative/repo" },
		});
		ok(!invalidRelative.valid);
		ok(invalidRelative.issues.some((issue) => issue.path === "$.repository.key"));
	});

	it("threads repository identity into prompt selection and renders applicability", () => {
		const global = memoryRecord({ id: "mem-0000000000000040", scope: "global" });
		const structured = memoryRecord({ id: "mem-0000000000000041", repository: REPO_A });
		const other = memoryRecord({ id: "mem-0000000000000042", repository: REPO_B });

		const built = buildMemoryPromptSection([global, structured, other], {
			activeRepository: REPO_A,
			tokenBudget: 10_000,
			maxItems: 10,
		});
		deepStrictEqual(built.records.map((record) => record.id).sort(), [global.id, structured.id].sort());
		match(built.section, /repository="canonical-path:\/memory-contract\/repo-a"/u);
		ok(!built.section.includes(other.id));

		const direct = renderMemoryPromptSection([structured]);
		ok(direct.includes(`canonical-path:${REPO_A.key}`));
	});
});
