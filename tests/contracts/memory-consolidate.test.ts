import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { validateSettings } from "../../src/core/config.js";
import {
	commandSegment,
	parseSourceEvidenceRef,
	sourceEvidenceRef,
} from "../../src/domains/memory/command-evidence.js";
import { consolidateMemory } from "../../src/domains/memory/consolidate.js";
import { createMemoryGuardian } from "../../src/domains/memory/guardian.js";
import { claimCommand, claimNote, memoryRecordFromPromotion } from "../../src/domains/memory/promotion.js";
import { loadMemoryRecordsSync, memoryStorePath } from "../../src/domains/memory/store.js";
import type { MemoryRecord, MemoryRepositoryIdentity } from "../../src/domains/memory/types.js";

const BEFORE = "2026-06-01T00:00:00.000Z";
const AFTER = "2026-06-03T00:00:00.000Z";
const DELIVERED_AT = "2026-06-04T00:00:00.000Z";

const scratchRoot = mkdtempSync(join(tmpdir(), "memory-consolidate-repos-"));
after(() => rmSync(scratchRoot, { recursive: true, force: true }));
const CLEAN_REPO = realpathSync(mkdtempSync(join(scratchRoot, "clean-")));

/** A record shaped the way filing writes one, named here so an assertion can say which case it reads. */
const names = new Map<string, string>();
function record(name: string, fields: Partial<MemoryRecord> & { source?: string; repo?: string }): MemoryRecord {
	const { source, repo = CLEAN_REPO, ...rest } = fields;
	const filed = memoryRecordFromPromotion(
		{
			kind: "task-bank-entry",
			sessionId: source ?? "unrecorded",
			evidenceRefs: ["session:any"],
			entry: {
				id: `k-${name}`,
				kind: "knowledge",
				content: `Lesson ${name}.`,
				createdAt: BEFORE,
				lastTouchedAt: BEFORE,
				injectionCount: 0,
			},
		},
		{ scope: "repo", repository: { kind: "canonical-path", key: repo } },
		new Date(AFTER),
	);
	names.set(filed.id, name);
	const shaped: MemoryRecord = { ...filed, approved: true, ...rest };
	if (source === undefined) Reflect.deleteProperty(shaped, "provenance");
	return shaped;
}

function home(records: MemoryRecord[] | string) {
	const root = mkdtempSync(join(tmpdir(), "memory-consolidate-"));
	const dataDir = join(root, "data");
	const stateDir = join(root, "state");
	mkdirSync(join(dataDir, "memory"), { recursive: true });
	writeFileSync(
		memoryStorePath(dataDir),
		typeof records === "string" ? records : JSON.stringify({ version: 2, records }),
	);
	return { root, dataDir, stateDir };
}

test("memory consolidate merges one claim's records, demotes dead evidence by rule, and leaves operator decisions and other repositories alone; history mining is off unless asked", async () => {
	// A repository whose working tree changed since its lessons were kept: the README's port moved, and the release
	// script exists only on another branch.
	const repo = realpathSync(mkdtempSync(join(scratchRoot, "consolidate-")));
	mkdirSync(join(repo, ".git"));
	mkdirSync(join(repo, "scripts"));
	writeFileSync(join(repo, "scripts", "check.sh"), "#!/bin/sh\n");
	chmodSync(join(repo, "scripts", "check.sh"), 0o755);
	writeFileSync(join(repo, "README.md"), "Local notes.\nthe port is 9090\n");
	const repository = { kind: "canonical-path" as const, key: repo };
	const command = (text: string, root = repo) => {
		const claimed = claimCommand(commandSegment(text, root) ?? ({} as never));
		if (claimed === null) throw new Error(`no claim for ${text}`);
		return { kind: "command" as const, command: claimed };
	};
	const source = (quote: string) => {
		const parsed = parseSourceEvidenceRef(sourceEvidenceRef("README.md", quote));
		if (parsed === null) throw new Error("no source ref");
		return { kind: "source" as const, ...parsed };
	};
	const guardian = { approved: true, approval: { by: "guardian" as const, at: AFTER } };
	const note = (
		id: string,
		lesson: string,
		claim: Parameters<typeof claimNote>[0]["claim"],
		at: string,
		in_: MemoryRepositoryIdentity = repository,
	) => ({
		...claimNote({ sessionId: `author-${id}`, lesson, claim, repository: in_, at }),
		id: `mem-${id.padEnd(16, "0")}`,
	});
	const kept = note(
		"a1",
		"Run `./scripts/check.sh --fast` before committing.",
		command("./scripts/check.sh --fast"),
		BEFORE,
	);
	const records: MemoryRecord[] = [
		{
			...kept,
			...guardian,
			observations: [{ at: AFTER, sessionId: "s2", kind: "held", revision: "0".repeat(16) }],
			deliveredCount: 1,
			lastDeliveredAt: DELIVERED_AT,
		},
		{
			...note("a2", "Use `./scripts/check.sh --fast` to check quickly.", command("./scripts/check.sh --fast"), AFTER),
			observations: [{ at: AFTER, sessionId: "s3", kind: "held", revision: "0".repeat(16) }],
			deliveredCount: 2,
			lastDeliveredAt: AFTER,
		},
		{
			...note("a3", "Never `./scripts/check.sh --fast` here.", command("./scripts/check.sh --fast"), AFTER),
			rejectedAt: AFTER,
		},
		note("b1", "Run `./scripts/check.sh --full` before a release.", command("./scripts/check.sh --full"), AFTER),
		{ ...note("c1", "README.md says the port is 8080 here.", source("the port is 8080"), AFTER), ...guardian },
		{
			...note("d1", "Run `./scripts/release.sh --dry-run` first.", command("./scripts/release.sh --dry-run"), AFTER),
			...guardian,
		},
		{
			...note("e1", "README.md says the host is local here.", source("the host is local"), AFTER),
			approved: true,
			approval: { by: "operator" as const, at: AFTER },
		},
		{ ...record("bare-note", { source: "clean", repo }), approved: false },
	];
	const h = home(records);
	try {
		const raw = (id: string) => records.find((item) => item.id === id);
		const [first, second] = await Promise.all([
			consolidateMemory(h.dataDir, { cwd: repo }),
			consolidateMemory(h.dataDir, { cwd: repo }),
		]);
		// Two passes started together: one does the work under the store lock, the other finds nothing left to do.
		const done = first?.changed ? first : second;
		const idle = first?.changed ? second : first;
		deepStrictEqual(
			{ merged: done?.merged, demoted: done?.demoted, withheld: done?.withheld, dropped: done?.dropped },
			{ merged: 1, demoted: 2, withheld: 1, dropped: 1 },
		);
		strictEqual(done?.scanned, 8);
		deepStrictEqual(
			{ changed: idle?.changed, merged: idle?.merged, demoted: idle?.demoted, dropped: idle?.dropped },
			{ changed: false, merged: 0, demoted: 0, dropped: 0 },
		);
		const after = new Map(loadMemoryRecordsSync(h.dataDir).map((item) => [item.id, item]));
		strictEqual(after.size, 6, "the merged duplicate and the bare note are gone, nothing else");
		const survivor = after.get("mem-a100000000000000");
		strictEqual(survivor?.approved, true, "the kept lesson stays a lesson");
		strictEqual(survivor?.lesson, kept.lesson, "its current wording stays current");
		deepStrictEqual(
			survivor?.revisions?.map((item) => item.lesson),
			["Use `./scripts/check.sh --fast` to check quickly.", kept.lesson],
			"the other wording is kept as a revision",
		);
		deepStrictEqual(survivor?.observations?.map((item) => item.sessionId).sort(), ["s2", "s3"]);
		strictEqual(survivor?.deliveredCount, 3, "the survivor's delivery is counted with the other's two");
		strictEqual(survivor?.lastDeliveredAt, DELIVERED_AT, "the earlier delivery's time survives the merge");
		ok(after.has("mem-b100000000000000"), "a distinct claim on the same subject survives");
		for (const id of ["mem-c100000000000000", "mem-d100000000000000"]) {
			strictEqual(after.get(id)?.approved, false, `${id} is demoted on dead evidence`);
			ok(after.get(id)?.regressions?.[0]?.includes("memory consolidate"));
		}
		deepStrictEqual(after.get("mem-e100000000000000"), raw("mem-e100000000000000"), "operator approval untouched");
		deepStrictEqual(after.get("mem-a300000000000000"), raw("mem-a300000000000000"), "operator rejection untouched");
		// A clean store and checkout change nothing: the bytes stay as they are.
		const bytes = readFileSync(memoryStorePath(h.dataDir), "utf8");
		const again = await consolidateMemory(h.dataDir, { cwd: repo });
		deepStrictEqual([again.changed, again.merged, again.demoted, again.dropped, again.withheld], [false, 0, 0, 0, 1]);
		strictEqual(readFileSync(memoryStorePath(h.dataDir), "utf8"), bytes);
	} finally {
		rmSync(h.root, { recursive: true, force: true });
	}

	// A Git repository at a path an earlier repository used: that one's records carry its root commit as their
	// fingerprint. Retrieval keeps them out of this checkout, and so does consolidate: its dead lesson is not demoted
	// here, and this repository's record of the same claim is not merged into it.
	const reused = realpathSync(mkdtempSync(join(scratchRoot, "reused-")));
	const git = (...args: string[]) =>
		execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...args], {
			cwd: reused,
			stdio: "ignore",
			env: {
				...process.env,
				GIT_AUTHOR_NAME: "t",
				GIT_AUTHOR_EMAIL: "t@t",
				GIT_COMMITTER_NAME: "t",
				GIT_COMMITTER_EMAIL: "t@t",
			},
		});
	git("init", "-q");
	git("commit", "-q", "--allow-empty", "-m", "root");
	const here = { kind: "canonical-path" as const, key: reused };
	const gone = command("./scripts/gone.sh", reused);
	const foreign: MemoryRecord[] = [
		{
			...note("f1", "Run `./scripts/gone.sh` first.", gone, BEFORE, { ...here, fingerprint: "f".repeat(40) }),
			...guardian,
		},
		note("f2", "Run `./scripts/gone.sh` before anything.", gone, AFTER, here),
	];
	const h2 = home(foreign);
	try {
		const pass = await consolidateMemory(h2.dataDir, { cwd: reused });
		deepStrictEqual([pass.changed, pass.merged, pass.demoted], [false, 0, 0]);
		deepStrictEqual(loadMemoryRecordsSync(h2.dataDir), foreign, "the earlier repository's lesson is untouched");
	} finally {
		rmSync(h2.root, { recursive: true, force: true });
	}

	// `surfaces.history` reads `off` by default and parses `on`, `off` and nothing else.
	const history = (value?: unknown) =>
		validateSettings({
			version: 2,
			...(value === undefined ? {} : { context: { memory: { surfaces: { history: value } } } }),
		});
	strictEqual(history().settings.context.memory.surfaces.history, "off");
	for (const value of ["on", "off"] as const) {
		const parsed = history(value);
		deepStrictEqual([parsed.settings.context.memory.surfaces.history, parsed.issues], [value, []]);
	}
	const invalid = history("sometimes");
	strictEqual(invalid.settings.context.memory.surfaces.history, "off");
	deepStrictEqual(
		invalid.issues.map((issue) => issue.path),
		["context.memory.surfaces.history"],
	);

	// With mining off the guardian parks after live work: no history source opens, so no `memory.history` call can be
	// made. Turning it on is all the next wake needs to open one.
	let mining = false;
	let sources = 0;
	let modelClients = 0;
	let looked!: () => void;
	let opened!: () => void;
	const stepped = new Promise<void>((resolve) => {
		looked = resolve;
	});
	const sourceOpened = new Promise<void>((resolve) => {
		opened = resolve;
	});
	const guardianUnderTest = createMemoryGuardian({
		enabled: () => true,
		isForegroundActive: () => false,
		live: {
			pendingWork: () => {
				looked();
				return false;
			},
			stepInFlight: () => false,
			runIdleStep: async () => "none",
		},
		historyMining: () => mining,
		historySource: () => {
			sources += 1;
			opened();
			return null;
		},
		client: {
			getModelClient: () => {
				modelClients += 1;
				return null;
			},
			getFallbackModelClient: () => null,
			getModelMaxTokens: (max) => max,
			backgroundEndpointBusy: () => false,
		},
		settings: () => ({ maxTokens: 2_000, timeoutMs: 1_000 }),
		workspaceRoot: () => repo,
		getKeptLessons: () => [],
		onHistoryLessons() {},
		onStateChange() {},
		scopeKey: () => "md7-session",
	});
	try {
		guardianUnderTest.wake("ready");
		await stepped;
		await new Promise((resolve) => setImmediate(resolve));
		deepStrictEqual([sources, modelClients, guardianUnderTest.state()], [0, 0, "idle"]);
		mining = true;
		guardianUnderTest.wake("settings");
		await sourceOpened;
		deepStrictEqual([sources, modelClients], [1, 0]);
	} finally {
		guardianUnderTest.dispose();
	}
});
