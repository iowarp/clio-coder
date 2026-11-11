import { match, ok, strictEqual } from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { newProcessId } from "../../src/core/telemetry/ids.js";
import { settingsFingerprintCommitment } from "../../src/core/telemetry/schemas.js";
import { scanTelemetrySegment } from "../../src/core/telemetry/segment.js";
import { openCallJournal } from "../../src/domains/telemetry/call-journal.js";
import { telemetryCommitment } from "../../src/domains/telemetry/objects.js";
import { telemetryProcessDirectory } from "../../src/domains/telemetry/paths.js";
import {
	packShare,
	planShare,
	resolveShareScopes,
	telemetryShareSource,
	verifyShareArchive,
} from "../../src/domains/telemetry/share.js";

const writer = { clioCoderVersion: "0.0.0-test", piVersion: "test" };

test("two shares from one install carry no common settings fingerprint, process id or clock epoch", async () => {
	const root = await mkdtemp(join(tmpdir(), "telemetry-share-linkable-"));
	try {
		const stateDir = join(root, "operator");
		const processId = newProcessId();
		const directory = telemetryProcessDirectory(stateDir, processId);
		const context = { sessionId: null, processId, agent: { role: "main" as const, id: processId } };
		const local = "7".repeat(64);
		const journal = await openCallJournal({ directory, context, writer });
		journal.enqueue({
			kind: "config.changed",
			data: {
				source: "file",
				paths: { hotReload: [], nextTurn: [], restartRequired: [] },
				before: telemetryCommitment("config", { before: true }),
				after: telemetryCommitment("config", { after: true }),
				settingsFingerprint: settingsFingerprintCommitment(local),
			},
			ctx: context,
			wallMs: Date.now(),
			mono: performance.now(),
		} as Parameters<typeof journal.enqueue>[0]);
		await journal.flush();
		await journal.close();
		const path = join(directory, "journal.jsonl");
		const before = await readFile(path, "utf8");
		const { scopes, skipped } = resolveShareScopes(stateDir, {
			sessions: [],
			runs: [],
			processes: [processId],
			repo: null,
			since: null,
			until: null,
			live: "snapshot",
		});
		const source = telemetryShareSource(stateDir);
		const fingerprint = (profile: "structural" | "research") => {
			const plan = planShare({ scopes, skipped, profile, source, writer });
			const found: string[] = [];
			for (const scope of plan.scopes)
				for (const row of scanTelemetrySegment(scope.journal).rows) {
					if (row.kind === "header") {
						strictEqual(row.header.clockOrigin.pid, 1);
						strictEqual(row.header.clockOrigin.monoEpochWallMs, 0);
					} else if (row.kind === "record" && row.record.k === "config.changed")
						found.push((row.record.data as { settingsFingerprint: { hash: string } }).settingsFingerprint.hash);
				}
			strictEqual(found.length, 1);
			strictEqual(verifyShareArchive(packShare(plan)).failure, null);
			return found[0] ?? "";
		};
		const first = fingerprint("structural");
		const second = fingerprint("structural");
		match(first, /^[0-9a-f]{64}$/u);
		ok(first !== local && second !== local && first !== second);
		strictEqual(await readFile(path, "utf8"), before, "the local journal changed");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
