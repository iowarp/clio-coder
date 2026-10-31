import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { gunzipSync } from "node:zlib";
import type { TelemetryContext } from "../../src/core/telemetry/context.js";
import type { SegmentHeader } from "../../src/core/telemetry/envelope.js";
import { makeTelemetryRecord } from "../../src/core/telemetry/envelope.js";
import { settingsFingerprintCommitment } from "../../src/core/telemetry/schemas.js";
import { encodeTelemetryLine } from "../../src/core/telemetry/segment.js";
import { openCallJournal } from "../../src/domains/telemetry/call-journal.js";
import { telemetryCommitment } from "../../src/domains/telemetry/objects.js";
import { telemetryImportedStateDir, telemetrySessionDirectory } from "../../src/domains/telemetry/paths.js";
import { readTelemetryScopeFiles, verifyTelemetryScope } from "../../src/domains/telemetry/seal.js";
import {
	importShareArchive,
	planShare,
	resolveShareScopes,
	telemetryShareSource,
	verifyShareArchive,
	writeShare,
} from "../../src/domains/telemetry/share.js";

const SECRET = "sk-proj-0123456789abcdefghijklmnop";
const HOST = "operator-laptop.example";
const writer = { clioCoderVersion: "0.0.0-test", piVersion: "test" };

test("a content-free share drops a planted secret, verifies as an archive, and imports verified (#434)", async () => {
	const root = await mkdtemp(join(tmpdir(), "telemetry-share-"));
	try {
		const stateDir = join(root, "operator");
		const sessionId = "ses_share";
		const directory = telemetrySessionDirectory(stateDir, sessionId);
		const context: TelemetryContext = { sessionId, agent: { role: "main", id: sessionId } };
		const header: SegmentHeader = {
			v: 1,
			k: "segment.open",
			schemaSet: "clio-telemetry/1",
			mode: "standard",
			capture: { content: false, deltas: false, providerHeaders: false, systemOneDataset: false, busTrace: false },
			clockOrigin: { host: HOST, pid: 1, birthToken: null, monoEpochWallMs: Date.now() },
			writer,
		};
		// A secret the writer's redaction missed is already in the journal; the share must not carry it out.
		const planted = makeTelemetryRecord(
			"config.changed",
			{
				source: "file",
				paths: { hotReload: [`providers.key=${SECRET}`], nextTurn: [], restartRequired: [] },
				before: telemetryCommitment("config", { before: true }),
				after: telemetryCommitment("config", { after: true }),
				settingsFingerprint: settingsFingerprintCommitment("0".repeat(64)),
			},
			context,
			{ t: new Date().toISOString(), mono: 1 },
		);
		await mkdir(directory, { recursive: true });
		await writeFile(join(directory, "journal.jsonl"), Buffer.concat([header, planted].map(encodeTelemetryLine)));
		const journal = await openCallJournal({ directory, context, writer });
		journal.enqueue({
			kind: "session.closed",
			data: { reason: "shutdown" },
			ctx: context,
			wallMs: Date.now(),
			mono: performance.now(),
		} as Parameters<typeof journal.enqueue>[0]);
		await journal.flush();
		ok(await journal.seal());
		await journal.close();
		ok((await readFile(join(directory, "journal.jsonl"), "utf8")).includes(SECRET));

		const selection = { sessions: [sessionId], runs: [], repo: null, since: null, until: null };
		const { scopes, skipped } = resolveShareScopes(stateDir, selection);
		deepStrictEqual(skipped, []);
		const source = telemetryShareSource(stateDir);
		const installId = source.installId;
		const plan = planShare({ scopes, skipped, profile: "content-free", source, writer });
		strictEqual(plan.scopes.length, 1);
		ok((plan.scopes[0]?.redactions ?? 0) > 0);
		const archivePath = join(root, "share.tar.gz");
		await writeShare(plan, archivePath);
		const archive = await readFile(archivePath);
		const unpacked = gunzipSync(archive).toString("utf8");
		ok(!unpacked.includes(SECRET), "the planted secret left in the archive");
		ok(!unpacked.includes(HOST), "the source hostname left in the archive");
		ok(unpacked.includes("config.changed"));
		const check = verifyShareArchive(archive);
		strictEqual(check.failure, null);
		strictEqual(check.manifest?.installId, installId);
		strictEqual(check.manifest?.profile, "content-free");

		const maintainer = join(root, "maintainer");
		const imported = await importShareArchive(maintainer, archive);
		deepStrictEqual(
			imported.placed.map(({ kind, id }) => ({ kind, id })),
			[{ kind: "session", id: sessionId }],
		);
		const placed = telemetrySessionDirectory(telemetryImportedStateDir(maintainer, installId), sessionId);
		strictEqual(verifyTelemetryScope(await readTelemetryScopeFiles(placed)).status, "verified");
		const again = await importShareArchive(maintainer, archive);
		deepStrictEqual(
			again.existing.map(({ id, identical }) => ({ id, identical })),
			[{ id: sessionId, identical: true }],
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
