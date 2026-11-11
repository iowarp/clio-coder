import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import {
	canonicalMemoryRepositoryIdentity,
	primeMemoryRepositoryFingerprint,
} from "../../src/domains/memory/operations.js";
import { memoryRecordFromPromotion } from "../../src/domains/memory/promotion.js";
import { selectMemoryForPrompt } from "../../src/domains/memory/prompt-section.js";
import { TaskMemoryBank } from "../../src/domains/memory/task-bank.js";
import {
	parseTaskMemoryHandoffSnapshot,
	renderTaskMemoryHandoffSnapshot,
	seedTaskMemoryBank,
	taskMemoryHandoffSnapshot,
} from "../../src/domains/memory/task-memory-handoff.js";
import type { MemoryRecord, MemoryRepositoryIdentity } from "../../src/domains/memory/types.js";

const roots: string[] = [];

function record(id: string, scope: "global" | "repo", repository?: MemoryRepositoryIdentity): MemoryRecord {
	return {
		id,
		scope,
		key: `key:${id}`,
		lesson: `lesson ${id}`,
		evidenceRefs: [`evidence:${id}`],
		appliesWhen: [],
		avoidWhen: [],
		confidence: 0.9,
		createdAt: "2026-08-23T00:00:00.000Z",
		approved: true,
		...(repository === undefined ? {} : { repository }),
	};
}

describe("memory scope boundary", () => {
	afterEach(() => {
		for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
	});

	it("selects approved global memory plus only the active repository", () => {
		const repoA = { kind: "canonical-path", key: "/memory/repo-a" } as const;
		const repoB = { kind: "canonical-path", key: "/memory/repo-b" } as const;
		const records = [record("global", "global"), record("a", "repo", repoA), record("b", "repo", repoB)];
		const selected = selectMemoryForPrompt(records, {
			scopes: ["global", "repo"],
			tokenBudget: 10_000,
			activeRepository: repoA,
		});
		deepStrictEqual(selected.map(({ id }) => id).sort(), ["a", "global"]);
		deepStrictEqual(
			selectMemoryForPrompt(records, { scopes: ["global", "repo"], tokenBudget: 10_000, activeRepository: null }).map(
				({ id }) => id,
			),
			["global"],
		);
	});

	it("applies a subdirectory's record only when that directory resolves to the active repository", (t) => {
		const root = realpathSync(mkdtempSync(join(tmpdir(), "clio-memory-subdir-")));
		roots.push(root);
		const repo = join(root, "repo");
		mkdirSync(join(repo, ".git"), { recursive: true });
		mkdirSync(join(repo, "notebooks"), { recursive: true });
		mkdirSync(join(repo, "vendor", "lib", ".git"), { recursive: true });
		mkdirSync(join(repo, "vendor", "lib", "src"), { recursive: true });
		const plain = join(root, "plain");
		mkdirSync(join(plain, "scratch"), { recursive: true });
		const keyed = (id: string, key: string) => record(id, "repo", { kind: "canonical-path", key });
		const selected = (active: string) =>
			selectMemoryForPrompt(
				[
					keyed("repo-sub", join(repo, "notebooks")),
					keyed("nested-sub", join(repo, "vendor", "lib", "src")),
					keyed("plain-sub", join(plain, "scratch")),
				],
				{ scopes: ["repo"], tokenBudget: 10_000, activeRepository: canonicalMemoryRepositoryIdentity(active) },
			)
				.map(({ id }) => id)
				.sort();
		deepStrictEqual(selected(repo), ["repo-sub"], "a nested repository's subdirectory stays its own");
		const plainIdentity = canonicalMemoryRepositoryIdentity(plain);
		if (plainIdentity?.key !== plain) {
			t.skip("the temp directory sits inside a repository on this host, so no directory outside Git exists here");
			return;
		}
		deepStrictEqual(selected(plain), [], "a directory outside Git does not collect its subdirectories' records");
	});

	it("keeps a repository's records across a branch whose history starts at another root commit", () => {
		const root = realpathSync(mkdtempSync(join(tmpdir(), "clio-memory-orphan-")));
		roots.push(root);
		const git = (...args: string[]) =>
			execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args], {
				cwd: root,
				encoding: "utf8",
				stdio: ["ignore", "pipe", "ignore"],
			}).trim();
		git("init", "-q", "-b", "main");
		git("commit", "-q", "--allow-empty", "-m", "main root");
		const mainRoot = git("rev-parse", "HEAD");
		git("checkout", "-q", "--orphan", "pages");
		git("commit", "-q", "--allow-empty", "-m", "pages root");
		primeMemoryRepositoryFingerprint(root);
		const active = canonicalMemoryRepositoryIdentity(root);
		ok(active?.fingerprint !== undefined && active.fingerprint !== mainRoot);
		const keyed = (id: string, fingerprint: string) =>
			record(id, "repo", { kind: "canonical-path", key: root, fingerprint });
		// Every ref is walked when a record first needs it, not at session start: a root made after priming counts.
		git("checkout", "-q", "--orphan", "docs");
		git("commit", "-q", "--allow-empty", "-m", "docs root");
		const docsRoot = git("rev-parse", "HEAD");
		const selected = selectMemoryForPrompt(
			[keyed("main", mainRoot), keyed("docs", docsRoot), keyed("other", "c".repeat(40))],
			{ scopes: ["repo"], tokenBudget: 10_000, activeRepository: active },
		);
		deepStrictEqual(selected.map(({ id }) => id).sort(), ["docs", "main"]);
	});

	it("creates a redacted, review-required promotion with source provenance", () => {
		const root = mkdtempSync(join(tmpdir(), "clio-coder-memory-scope-"));
		roots.push(root);
		const repository = canonicalMemoryRepositoryIdentity(root);
		ok(repository);
		const bank = new TaskMemoryBank({ now: () => new Date("2026-08-23T09:00:00.000Z") });
		const entry = bank.saveKnowledge("Use API_KEY=super-secret-value in the fixture.");
		const promoted = memoryRecordFromPromotion(
			{
				kind: "task-bank-entry",
				sessionId: "session-origin",
				evidenceRefs: ["run-origin"],
				entry,
			},
			{ scope: "repo", repository },
			new Date("2026-08-23T10:00:00.000Z"),
		);
		strictEqual(promoted.approved, false);
		deepStrictEqual(promoted.repository, repository);
		ok(promoted.lesson.includes("[redacted:assignment]"));
		ok(!promoted.lesson.includes("super-secret-value"));
		strictEqual(promoted.provenance?.sourceSessionId, "session-origin");
		strictEqual(promoted.provenance?.sourceEntryId, entry.id);
	});

	it("hands off only redacted knowledge and procedure, never private status", () => {
		const source = new TaskMemoryBank({ now: () => new Date("2026-08-23T09:00:00.000Z") });
		source.updateStatus("private working state");
		source.saveKnowledge("Token API_KEY=super-secret-value");
		source.saveProcedural("Run npm test before handoff");
		const rendered = renderTaskMemoryHandoffSnapshot(
			taskMemoryHandoffSnapshot(source.snapshot(), {
				sessionId: "session-origin",
				evidenceRefs: ["run-origin"],
				runtimeIds: ["openai"],
				agentIds: ["coder"],
			}),
		);
		ok(!rendered.includes("private working state"));
		ok(!rendered.includes("super-secret-value"));
		ok(rendered.startsWith("```clio-coder-task-memory\n"));
		ok(!rendered.includes("```clio-task-memory\n"));
		const parsed = parseTaskMemoryHandoffSnapshot(rendered);
		ok(parsed);
		ok(parseTaskMemoryHandoffSnapshot(rendered.replace("clio-coder-task-memory", "clio-task-memory")));
		const target = new TaskMemoryBank();
		deepStrictEqual(seedTaskMemoryBank(target, parsed), { seeded: 2, skipped: 0 });
		strictEqual(target.snapshot().status, null);
		strictEqual(target.snapshot().knowledge.length, 1);
		strictEqual(target.snapshot().procedural.length, 1);
		deepStrictEqual(seedTaskMemoryBank(target, parsed), { seeded: 0, skipped: 2 });
	});
});
