import { deepStrictEqual, match, ok, rejects, strictEqual } from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { gunzipSync } from "node:zlib";
import type { TelemetryContext } from "../../src/core/telemetry/context.js";
import type { SegmentHeader } from "../../src/core/telemetry/envelope.js";
import { makeTelemetryRecord } from "../../src/core/telemetry/envelope.js";
import type { EventPayload } from "../../src/core/telemetry/events.js";
import type { ObjectRef } from "../../src/core/telemetry/schemas.js";
import { settingsFingerprintCommitment } from "../../src/core/telemetry/schemas.js";
import { encodeTelemetryLine, scanTelemetrySegment } from "../../src/core/telemetry/segment.js";
import { canonicalJson } from "../../src/domains/prompts/hash.js";
import { openCallJournal } from "../../src/domains/telemetry/call-journal.js";
import { storeTelemetryObject, telemetryCommitment } from "../../src/domains/telemetry/objects.js";
import {
	telemetryImportedStateDir,
	telemetryObjectsDirectory,
	telemetrySessionDirectory,
} from "../../src/domains/telemetry/paths.js";
import { readTelemetryScopeFiles, verifyTelemetryScope } from "../../src/domains/telemetry/seal.js";
import {
	importShareArchive,
	planShare,
	resolveShareScopes,
	sealSharedScope,
	telemetryShareSource,
	verifyShareArchive,
	writeShare,
} from "../../src/domains/telemetry/share.js";

const SECRET = "sk-proj-0123456789abcdefghijklmnop";
const HOST = "operator-laptop.example";
// What a run said about itself, a private handbook path and its username, and a passphrase that matches no value
// pattern: none may leave below research, in a record or in an object (#434).
const CLAIM = "Validated confidential Project Nightingale acquisition customer migration";
const USER = "private-operator";
const PRIVATE_PATH = `/home/${USER}/customer-acquisition/CLIO-CODER.md`;
const PASSWORD = "correct horse battery staple";
// A local server's model file as its model id, a path and prose in a tool schema's literals, and a model file as a
// settings dictionary key: identities, literals and keys carry operator data too (#434).
const MODEL_PATH = "/srv/models/ledger-forecast-q4.gguf";
const ENUM_PATH = "/srv/vault/ledger-root";
const CONST_PROSE = "Quarterly Nightingale churn forecast";
const CONFIG_KEY = "/srv/lmstudio/ledger-private.gguf";
// Expanded flow recipients name an endpoint URL and an MCP server's command, directory and environment, and a tool
// schema's property name can be any string, a path included: each is an identity or a key, never kept (#434).
const PRIVATE_HOST = "private-operator.corp.internal";
const RECIPIENTS = [
	`target:ledger@openai-compat=https://${PRIVATE_HOST}/customer-acquisition`,
	`mcp:ledger={"command":"/home/${USER}/customer-acquisition/bin/ledger","cwd":"/home/${USER}/customer-acquisition","env":{"PASSWORD":"${PASSWORD}"}}`,
];
const PROPERTY_PATH = "/home/confidential-operator/acquisition/customer-ledger.csv";
const GOLDEN_RUN = new URL(
	"../fixtures/telemetry/golden/vccap2ywu7n8/runs/21ee9qwrugeq/journal.jsonl",
	import.meta.url,
);
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
				paths: {
					hotReload: [`providers.key=${SECRET}`],
					nextTurn: [`targets.0.lmstudio.models.${CONFIG_KEY}.load`],
					restartRequired: [],
				},
				before: telemetryCommitment("config", { before: true }),
				after: telemetryCommitment("config", { after: true }),
				settingsFingerprint: settingsFingerprintCommitment("0".repeat(64)),
			},
			context,
			{ t: new Date().toISOString(), mono: 1 },
		);
		const objects = telemetryObjectsDirectory(directory);
		await mkdir(objects, { recursive: true });
		// Objects as an older store left them, before credential-named properties were redacted whole.
		const plantObject = async (subject: ObjectRef["subject"], value: unknown): Promise<ObjectRef> => {
			const bytes = canonicalJson(value);
			const id = `obj_${createHash("sha256").update(bytes).digest("hex")}`;
			await writeFile(join(objects, `${id}.json`), bytes);
			return { label: "resolvable", function: "sha256", canonicalization: "json-sorted-v1", subject, id };
		};
		const hash = "a".repeat(64);
		const structure = await plantObject("prompt-structure", {
			sections: [{ id: "identity", tokenEstimate: 10 }],
			fragments: [{ id: "identity.core", relPath: "identity/core.md", contentHash: hash, dynamic: false }],
			compile: {
				version: 1,
				at: new Date().toISOString(),
				previousHash: null,
				systemPromptHash: hash,
				tokenEstimate: 10,
				thinkingLevel: null,
				contextWindow: null,
				contextWindowSource: null,
				projectPreload: {
					mode: "full",
					chars: 10,
					lines: 1,
					reason: null,
					nearLimit: false,
					label: PRIVATE_PATH,
					sources: [
						{
							path: PRIVATE_PATH,
							contentHash: hash,
							availableChars: 10,
							availableLines: 1,
							includedChars: 10,
							includedLines: 1,
							includedRange: [1, 1],
							omittedRange: null,
							omissionReason: null,
						},
					],
				},
			},
		});
		const settings = await plantObject("config", {
			providers: { local: { password: PASSWORD } },
			workspace: PRIVATE_PATH,
			targets: [{ id: "local", lmstudio: { models: { [CONFIG_KEY]: { load: { contextLength: 4096 } } } } }],
		});
		const toolSchemas = await plantObject("tool-schemas", [
			{
				name: "ledger",
				description: "Reads the ledger",
				parameters: {
					type: "object",
					properties: {
						root: { type: "string", enum: [ENUM_PATH] },
						mode: { const: { note: CONST_PROSE } },
						[PROPERTY_PATH]: { type: "string" },
					},
					required: ["root", PROPERTY_PATH],
				},
			},
		]);
		const goldenCall = scanTelemetrySegment(
			await readFile(new URL("../fixtures/telemetry/golden/p0/journal.jsonl", import.meta.url)),
		).rows.find((row) => row.kind === "record" && row.record.k === "call.started");
		const golden = scanTelemetrySegment(await readFile(GOLDEN_RUN)).rows.find(
			(row) => row.kind === "record" && row.record.k === "run.settled",
		);
		ok(golden?.kind === "record");
		ok(goldenCall?.kind === "record");
		const at = { t: new Date().toISOString(), mono: 2 };
		const call = goldenCall.record.data as EventPayload<"call.started">;
		const records = [
			makeTelemetryRecord(
				"run.settled",
				{
					...(golden.record.data as EventPayload<"run.settled">),
					identity: { host: HOST, user: USER },
					route: { ...(golden.record.data as EventPayload<"run.settled">).route, wireModelId: MODEL_PATH },
					outcomeDetail: `could not read ${PRIVATE_PATH}`,
					validationGrounding: { claimed: 1, grounded: 0, ungrounded: [CLAIM], basis: "unmatched-command" },
					flowRestrictions: {
						version: 1,
						restrictions: [{ ruleId: "ledger", policyHash: hash, sourceRef: "policy.yaml", recipients: RECIPIENTS }],
					},
				},
				context,
				at,
			),
			makeTelemetryRecord("prompt.compiled", { structure, layoutVersion: 1, tokenEstimate: 10, sections: 1 }, context, at),
			makeTelemetryRecord(
				"call.started",
				{ ...call, objects: { toolSchemas }, target: { ...call.target, requestedModel: MODEL_PATH } },
				{ ...context, callId: call.callId, attemptId: call.attemptId },
				at,
			),
			makeTelemetryRecord(
				"config.snapshotted",
				{ settings, settingsFingerprint: settingsFingerprintCommitment("0".repeat(64)) },
				context,
				at,
			),
		];
		await writeFile(
			join(directory, "journal.jsonl"),
			Buffer.concat([header, planted, ...records].map(encodeTelemetryLine)),
		);
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
		ok(unpacked.includes("run.settled"));
		for (const leak of [CLAIM, USER, PRIVATE_PATH, MODEL_PATH, "ledger-private", PRIVATE_HOST, PASSWORD, "horse"])
			ok(!unpacked.includes(leak), `${leak} left in the archive`);
		// A provider's plain model id is no path and stays readable.
		ok(unpacked.includes((golden.record.data as EventPayload<"run.settled">).route.targetId));
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

		// A structural share carries the prompt structure and settings, projected before their ids are computed.
		const structural = planShare({ scopes, skipped, profile: "structural", source, writer });
		strictEqual(structural.scopes[0]?.objects.length, 3);
		const structuralPath = join(root, "structural.tar.gz");
		await writeShare(structural, structuralPath);
		const structuralArchive = await readFile(structuralPath);
		const structuralBytes = gunzipSync(structuralArchive).toString("utf8");
		for (const leak of [
			SECRET,
			HOST,
			CLAIM,
			USER,
			PRIVATE_PATH,
			PASSWORD,
			"horse",
			MODEL_PATH,
			ENUM_PATH,
			CONST_PROSE,
			"ledger-private",
			PRIVATE_HOST,
			PROPERTY_PATH,
			"confidential-operator",
		])
			ok(!structuralBytes.includes(leak), `${leak} left in the structural archive`);
		strictEqual(verifyShareArchive(structuralArchive).failure, null);
		await importShareArchive(join(root, "structural-maintainer"), structuralArchive);

		// The object store redacts a credential-named property whole, whatever its shape.
		const store = join(root, "store");
		const stored = await storeTelemetryObject(store, "config", { password: PASSWORD });
		ok(!(await readFile(join(telemetryObjectsDirectory(store), `${stored.id}.json`), "utf8")).includes("horse"));

		// A sealed archive holding what its profile's projection withholds, in a record or an object, fails verify and import.
		const tamper = async (
			shared: typeof plan,
			edit: (line: Parameters<typeof sealSharedScope>[0]["lines"][number]) => unknown,
			objectsOf: (objects: Array<{ id: string; bytes: Buffer }>) => Array<{ id: string; bytes: Buffer }>,
		): Promise<Buffer> => {
			const scope = shared.scopes[0];
			ok(scope);
			const rows = scanTelemetrySegment(scope.journal).rows;
			const closing = rows.at(-2);
			const seal = rows.at(-1);
			ok(closing?.kind === "header" && seal?.kind === "record");
			const lines = rows.slice(0, -2).map((row) => {
				ok(row.kind !== "skipped");
				return edit(row.kind === "header" ? row.header : row.record);
			});
			const carried = objectsOf(scope.objects);
			const resealed = sealSharedScope({
				scope: { kind: scope.kind, id: scope.id },
				lines: lines as Parameters<typeof sealSharedScope>[0]["lines"],
				objects: carried,
				profile: scope.profile,
				installId,
				writer,
				header: closing.header,
				ctx: seal.record.ctx,
				now: new Date(),
			});
			const path = join(root, `tampered-${scope.profile}.tar.gz`);
			await writeShare({ ...shared, scopes: [{ ...scope, ...resealed, objects: carried }] }, path);
			return readFile(path);
		};
		const claimed = await tamper(
			plan,
			(line) => {
				if (line.k !== "run.settled") return line;
				const data = line.data as EventPayload<"run.settled">;
				return { ...line, data: { ...data, validationGrounding: { ...data.validationGrounding, ungrounded: [CLAIM] } } };
			},
			(objects) => objects,
		);
		match(verifyShareArchive(claimed).failure ?? "", /run\.settled with fields beyond the content-free projection/);
		await rejects(importShareArchive(join(root, "rejecting"), claimed), /beyond the content-free projection/);
		const raw = await readFile(join(objects, `${structure.id}.json`));
		const rawId = `obj_${createHash("sha256").update(raw).digest("hex")}`;
		let projectedId = "";
		const unprojected = await tamper(
			structural,
			(line) => {
				if (line.k !== "prompt.compiled") return line;
				const data = line.data as EventPayload<"prompt.compiled">;
				projectedId = data.structure.id;
				return { ...line, data: { ...data, structure: { ...data.structure, id: rawId } } };
			},
			(objects) => objects.map((object) => (object.id === projectedId ? { id: rawId, bytes: raw } : object)),
		);
		match(verifyShareArchive(unprojected).failure ?? "", /prompt-structure object .* beyond the structural projection/);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
