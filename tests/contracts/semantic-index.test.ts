import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { CODEWIKI_VERSION, writeCodewiki } from "../../src/domains/context/index.js";
import type { EvidenceInspectable } from "../../src/domains/evidence/index.js";
import type { MemoryRecord } from "../../src/domains/memory/index.js";
import { canonicalMemoryRepositoryIdentity } from "../../src/domains/memory/index.js";
import type { SemanticEmbed, SemanticProfile, SemanticRecord } from "../../src/domains/semantic/index.js";
import {
	embeddingProfileToSemanticProfile,
	extractInbox,
	extractProjectSources,
	extractRecording,
	previewInbox,
	SemanticIndex,
	semanticProfileKey,
	sourceHash,
} from "../../src/domains/semantic/index.js";
import { isolateClioEnv } from "../harness/scratch-env.js";

let isolated: Awaited<ReturnType<typeof isolateClioEnv>>;
beforeEach(async () => {
	isolated = await isolateClioEnv("semantic-index-");
});
afterEach(() => isolated.restore());
const profile: SemanticProfile = {
	id: "fixture",
	dimensions: 2,
	profileIdentity: sourceHash("fixture-profile"),
	identity: { checkpoint: "fixture-sha", canary: "fixture-canary", recipe: "unit-text-v1" },
};
function record(id: string, text = id): SemanticRecord {
	return {
		id,
		sourceId: id,
		kind: "code",
		projectId: "project-a",
		scope: "project",
		visibility: "project",
		path: `${id}.ts`,
		contentHash: sourceHash(text),
		extractionVersion: "v1",
		text,
		input: { kind: "text", text },
		location: { line: 1 },
		mediaType: "text/plain",
	};
}
function fixtureEmbed(calls: string[][]): SemanticEmbed {
	return async (inputs, options) => {
		calls.push(inputs.map((input) => (input.kind === "text" ? input.text : input.path)));
		return { profileKey: semanticProfileKey(options.profile), vectors: inputs.map(() => [1, 0]) };
	};
}

test("generations reload unchanged vectors, refresh changed/deleted records and isolate recipes", async () => {
	const calls: string[][] = [];
	const options = { projectId: "project-a", profile, embed: fixtureEmbed(calls), cacheDir: isolated.dir };
	const index = new SemanticIndex(options);
	assert.equal((await index.refresh([record("a"), record("b")])).embedded, 2);
	const reopened = new SemanticIndex(options);
	assert.equal((await reopened.refresh([record("a"), record("b")])).embedded, 0);
	assert.equal(calls.length, 1);
	assert.equal(
		(await reopened.refresh([{ ...record("a"), updatedAt: "2026-10-07T01:00:00Z" }, record("b")])).embedded,
		0,
	);
	assert.equal((await reopened.refresh([record("a", "changed checkpoint retry")])).embedded, 1);
	assert.equal(reopened.searchVector("b", undefined, { projectId: "project-a" }).hits.length, 0);
	const manifest = JSON.parse(readFileSync(join(reopened.storage.directory, "manifest.json"), "utf8"));
	const generation = JSON.parse(
		readFileSync(join(reopened.storage.directory, `generation-${manifest.generation}.json`), "utf8"),
	);
	assert.deepEqual(generation.tombstones, ["b"]);
	const otherProfile = new SemanticIndex({
		...options,
		profile: {
			...profile,
			profileIdentity: sourceHash("other-profile"),
			identity: { ...profile.identity, checkpoint: "new-model" },
		},
	});
	assert.equal(otherProfile.status().generation, null);
	assert.notEqual(otherProfile.profileKey, reopened.profileKey);
	assert.equal((await otherProfile.reembed(reopened.canonicalRecords())).embedded, 1);
	assert.throws(
		() => reopened.searchVector("a", { profileKey: reopened.profileKey, vector: [1, 0] }, { projectId: "project-b" }),
		/ownership/,
	);
});

test("interrupted jobs retain complete generation and resume checkpoint without redundant calls", async () => {
	const calls: string[][] = [];
	const options = {
		projectId: "project-a",
		profile,
		embed: fixtureEmbed(calls),
		cacheDir: isolated.dir,
		limits: { batchSize: 1 },
	};
	const index = new SemanticIndex(options);
	await index.refresh([record("old")]);
	const oldGeneration = index.status().generation;
	const partial = await index.refresh([record("new-a"), record("new-b")], { maxEmbeddings: 1 });
	assert.equal(partial.complete, false);
	assert.equal(partial.generation, oldGeneration);
	assert.deepEqual(partial.pending, ["new-b"]);
	assert.equal(new SemanticIndex(options).searchVector("old", undefined, { projectId: "project-a" }).hits[0]?.id, "old");
	assert.equal((await new SemanticIndex(options).refresh([record("new-a"), record("new-b")])).embedded, 1);
	assert.deepEqual(calls, [["old"], ["new-a"], ["new-b"]]);
	const cancelled = new AbortController();
	cancelled.abort();
	await assert.rejects(index.refresh([record("cancel")], { signal: cancelled.signal }), /abort/i);
});

test("scope, visibility and current memory eligibility precede scoring; fallback is bounded", async () => {
	const index = new SemanticIndex({ projectId: "project-a", profile, embed: fixtureEmbed([]), cacheDir: isolated.dir });
	await index.refresh([
		record("local", "checkpoint retry"),
		{ ...record("global", "checkpoint retry"), scope: "global", visibility: "global" },
		{ ...record("private", "checkpoint retry"), visibility: "private" },
		{ ...record("memory", "checkpoint retry"), kind: "memory", memoryId: "memory-1" },
	]);
	const offline = new SemanticIndex({ projectId: "project-a", profile, cacheDir: isolated.dir });
	assert.deepEqual(
		(await offline.search("checkpoint", { projectId: "project-a" })).hits.map((h) => h.id),
		["local"],
	);
	assert.equal(
		(
			await offline.search("checkpoint", {
				projectId: "project-a",
				includeGlobal: true,
				includePrivate: true,
				eligibleMemoryIds: ["memory-1"],
			})
		).hits.length,
		4,
	);
	assert.equal(
		offline.searchVector("checkpoint", undefined, { projectId: "project-a", kinds: ["memory"] }).hits.length,
		0,
	);
	assert.equal(offline.searchVector("checkpoint", undefined, { projectId: "project-a", limit: 1 }).hits.length, 1);
	assert.deepEqual(
		(
			await offline.search("checkpoint", {
				projectId: "project-a",
				allowsRecord: (candidate) => candidate.id === "local",
			})
		).hits.map((hit) => hit.id),
		["local"],
	);
	await assert.rejects(index.refresh([{ ...record("foreign"), projectId: "foreign" }]), /foreign/);
});

test("malformed embeddings cannot switch a generation and unavailable queries fall back", async () => {
	for (const vector of [[0, 0], [Number.NaN, 0], [Infinity, 0], [1], [2, 0]]) {
		const index = new SemanticIndex({
			projectId: "project-a",
			profile,
			cacheDir: isolated.dir,
			embed: async () => ({ profileKey: semanticProfileKey(profile), vectors: [vector] }),
		});
		assert.equal((await index.refresh([record("bad")])).complete, false);
		assert.equal(index.status().generation, null);
		assert.match(Object.values(index.status().failed)[0] ?? "", /vector/i);
	}
	const index = new SemanticIndex({
		projectId: "project-a",
		profile,
		cacheDir: isolated.dir,
		embed: async () => ({ profileKey: "wrong-profile", vectors: [[1, 0]] }),
	});
	assert.equal((await index.refresh([record("bad")])).complete, false);
	assert.match(Object.values(index.status().failed)[0] ?? "", /profile/);
	const good = new SemanticIndex({ projectId: "project-a", profile, cacheDir: isolated.dir, embed: fixtureEmbed([]) });
	await good.refresh([record("checkpoint")]);
	const unavailable = new SemanticIndex({
		projectId: "project-a",
		profile,
		cacheDir: isolated.dir,
		embed: async () => {
			throw new Error("offline");
		},
	});
	const result = await unavailable.search("checkpoint", { projectId: "project-a" });
	assert.equal(result.hits[0]?.id, "checkpoint");
	assert.equal(result.fallbackReason, "offline");
});

test("inboxes require explicit roots, honor ignores/protection, preserve notebook/PDF/media locations", async () => {
	const root = join(isolated.dir, "inbox");
	mkdirSync(root);
	writeFileSync(join(root, "science.py"), "delayed oscillation simulation");
	writeFileSync(join(root, ".gitignore"), "ignored.txt\n");
	writeFileSync(join(root, "ignored.txt"), "ignored");
	writeFileSync(join(root, ".env"), "API_KEY=supersecret");
	writeFileSync(join(root, "credentials.json"), '{"password":"secret"}');
	writeFileSync(join(root, "secret.txt"), "api_key=supersecretvalue123");
	writeFileSync(join(root, "plot.png"), "image-fixture");
	writeFileSync(join(root, "movie.mp4"), "video-fixture");
	writeFileSync(join(root, "note.pdf"), "pdf-fixture");
	writeFileSync(
		join(root, "experiment.ipynb"),
		JSON.stringify({
			cells: [
				{
					source: ["simulation()"],
					outputs: [{ data: { "text/plain": ["delayed oscillation"], "image/png": "aW1hZ2U=" } }],
				},
			],
		}),
	);
	symlinkSync(join(isolated.dir, "config"), join(root, "escape"));
	const registration = { id: "science", root, projectId: "project-a", scope: "project" as const, runId: "run-7" };
	const preview = await previewInbox(registration);
	assert(!preview.files.some((file) => /ignored|credentials|\.env|escape/.test(file.path)));
	const extracted = await extractInbox(registration, {
		modalities: ["image"],
		pdfPages: async () => [{ page: 3, text: "oscillation laboratory note" }],
	});
	assert(extracted.records.some((r) => r.location.page === 3));
	assert(extracted.records.some((r) => r.location.cell === 0 && r.location.output === 0 && r.input.kind === "image"));
	assert(extracted.records.every((r) => r.runId === "run-7"));
	assert(!extracted.records.some((r) => r.path.endsWith("secret.txt")));
	assert.equal(extracted.sources.find((s) => s.path.endsWith("movie.mp4"))?.state, "unsupported");
	const sampled = await extractInbox(registration, {
		modalities: ["image"],
		pdfPages: async () => [],
		mediaSampler: async () => [
			{
				input: { kind: "image", path: join(root, "plot.png"), mimeType: "image/png" },
				location: { frame: 2, startSeconds: 1.5 },
			},
		],
	});
	assert(sampled.records.some((r) => r.location.frame === 2 && r.location.startSeconds === 1.5));
	await assert.rejects(previewInbox({ ...registration, root: "." }), /absolute root/);
});

test("project extraction uses typed codemap/wiki and excludes unapproved or foreign memories/evidence", async () => {
	const root = join(isolated.dir, "project");
	mkdirSync(join(root, ".clio-coder", "wiki"), { recursive: true });
	writeFileSync(join(root, "retry.ts"), "// retry after durable checkpoint\nexport function recover() { return 1; }\n");
	writeCodewiki(root, {
		version: CODEWIKI_VERSION,
		language: "typescript",
		files: [
			{
				id: "f1",
				path: "retry.ts",
				lang: "typescript",
				loc: 2,
				role: "module",
				hash: "0123456789abcdef",
				imports: [],
				summary: "Durable recovery",
			},
		],
		symbols: [{ name: "recover", kind: "func", fileId: "f1", line: 2 }],
		edges: [],
	});
	writeFileSync(join(root, ".clio-coder", "wiki", "recovery.md"), "# Recovery\nRetry after checkpoint");
	const repository = canonicalMemoryRepositoryIdentity(root);
	assert(repository);
	const memory: MemoryRecord = {
		id: "m1",
		scope: "repo",
		repository,
		key: "retry",
		lesson: "retain the checkpoint",
		evidenceRefs: ["e1"],
		appliesWhen: [],
		avoidWhen: [],
		confidence: 1,
		createdAt: "2026-10-07T00:00:00Z",
		approved: true,
	};
	const options = {
		projectRoot: root,
		projectId: "project-a",
		memoryEligibility: { scopes: ["repo"] as const, activeRepository: repository },
		memoryRecords: [
			memory,
			{ ...memory, id: "unapproved", approved: false },
			{ ...memory, id: "foreign", repository: { kind: "canonical-path" as const, key: "/foreign" } },
		],
	};
	const bundle: EvidenceInspectable = {
		overview: {
			version: 1,
			evidenceId: "e1",
			source: { kind: "run", runId: "run-7" },
			generatedAt: "2026-10-07T00:00:00Z",
			runIds: ["run-7"],
			sessionId: null,
			statuses: [],
			startedAt: null,
			endedAt: null,
			tasks: ["previous checkpoint failure"],
			cwds: [root],
			agentIds: [],
			targetIds: [],
			runtimeIds: [],
			modelIds: [],
			totals: {
				runs: 1,
				receipts: 0,
				toolCalls: 0,
				toolErrors: 0,
				blockedToolCalls: 0,
				sessionEntries: 0,
				auditRows: 0,
				toolEvents: 0,
				linkedToolEvents: 0,
				protectedArtifacts: 0,
				tokens: 0,
				costUsd: 0,
				wallTimeMs: 0,
			},
			tags: [],
			files: [],
		},
		findings: [{ id: "f1", severity: "warn", tag: "unknown", runId: "run-7", message: "checkpoint corrected" }],
		trustStatus: { version: 1, evidenceId: "e1", projection: "historical_format", runs: [] },
	};
	const result = await extractProjectSources({
		...options,
		evidence: [
			{ bundle, directory: root, redactedTranscript: "redacted warning segment" },
			{
				bundle: { ...bundle, overview: { ...bundle.overview, evidenceId: "foreign-evidence", cwds: [isolated.dir] } },
				directory: isolated.dir,
			},
		],
	});
	assert(result.records.some((r) => r.path.endsWith("findings.json") && r.runId === "run-7"));
	assert(result.records.some((r) => r.path.endsWith("transcript.md")));
	assert(!result.records.some((r) => r.sourceId.includes("foreign-evidence")));
	assert(
		result.records.some((r) => r.kind === "code" && r.location.line === 2 && r.text.includes("recover")),
		JSON.stringify(result),
	);
	assert(result.records.some((r) => r.kind === "wiki"));
	assert.deepEqual(
		result.records.filter((r) => r.kind === "memory").map((r) => r.memoryId),
		["m1"],
	);
	const prior = result.records.find((r) => r.kind === "code")?.contentHash;
	writeFileSync(join(root, "retry.ts"), "export function recover() { return 2; }");
	assert.notEqual((await extractProjectSources(options)).records.find((r) => r.kind === "code")?.contentHash, prior);
	rmSync(join(root, "retry.ts"));
	assert(!(await extractProjectSources(options)).records.some((r) => r.kind === "code"));
});

test("recording ingestion verifies hashes, strips controls and locates redacted output timestamps", async () => {
	const root = join(isolated.dir, "evidence");
	mkdirSync(root);
	const path = join(root, "run-7.cast");
	const text = `${[
		JSON.stringify({ version: 2, width: 80, height: 24 }),
		JSON.stringify([0.5, "i", "keyboard secret"]),
		JSON.stringify([1.5, "o", "\u001b[31mwarning at checkpoint; password=[redacted:assignment]\u001b[0m"]),
		JSON.stringify([4.2, "o", "corrected retry; passing command"]),
	].join("\n")}\n`;
	writeFileSync(path, text);
	const source = {
		root,
		path,
		projectId: "project-a",
		runId: "run-7",
		sha256: sourceHash(text),
		redacted: true as const,
	};
	const result = extractRecording(source);
	assert.equal(result.records.length, 2);
	assert.equal(result.records[0]?.location.startSeconds, 1.5);
	assert.equal(result.records[0]?.text, "warning at checkpoint; password=[redacted:assignment]");
	assert(result.records.every((r) => r.runId === "run-7" && !r.text.includes("keyboard")));
	assert.throws(() => extractRecording({ ...source, sha256: "wrong" }), /checksum/);
	assert.throws(() => extractRecording({ ...source, path: join(isolated.dir, "outside.cast") }), /unredacted|protected/);
	const index = new SemanticIndex({ projectId: "project-a", profile, embed: fixtureEmbed([]), cacheDir: isolated.dir });
	await index.refreshExtracted(result);
	assert.equal(
		index.searchVector("warning", undefined, { projectId: "project-a", runId: "run-7" }).hits[0]?.location.startSeconds,
		1.5,
	);
});

test("failed or truncated extraction cannot delete old records; query profiles remain isolated", async () => {
	const index = new SemanticIndex({ projectId: "project-a", profile, embed: fixtureEmbed([]), cacheDir: isolated.dir });
	await index.refresh([record("keep")]);
	await assert.rejects(index.refreshExtracted({ records: [], sources: [], truncated: true }), /Incomplete/);
	await assert.rejects(
		index.refreshExtracted({ records: [], sources: [{ path: "unreadable", state: "failed" }], truncated: false }),
		/Incomplete/,
	);
	assert.equal(index.searchVector("keep", undefined, { projectId: "project-a" }).hits[0]?.id, "keep");
	assert.throws(
		() => index.searchVector("keep", { profileKey: "another-768-space", vector: [1, 0] }, { projectId: "project-a" }),
		/profile/,
	);
});

test("persisted daily work budget and foreground yield survive reopening", async () => {
	const calls: string[][] = [];
	const options = {
		projectId: "project-a",
		profile,
		embed: fixtureEmbed(calls),
		cacheDir: isolated.dir,
		limits: { maxEmbeddingsPerDay: 1 },
	};
	const index = new SemanticIndex(options);
	assert.equal((await index.refresh([record("a")], { shouldYield: () => true })).embedded, 0);
	assert.equal(calls.length, 0);
	assert.equal((await index.refresh([record("a")])).complete, true);
	assert.equal((await new SemanticIndex(options).refresh([record("a"), record("b")])).embedded, 0);
	assert.equal(calls.length, 1);
	assert.deepEqual(new SemanticIndex(options).status().pending, ["b"]);
});

test("generation corruption is detected before records or vectors can be disclosed", async () => {
	const options = { projectId: "project-a", profile, embed: fixtureEmbed([]), cacheDir: isolated.dir };
	const index = new SemanticIndex(options);
	await index.refresh([record("original")]);
	const manifest = JSON.parse(readFileSync(join(index.storage.directory, "manifest.json"), "utf8"));
	const path = join(index.storage.directory, `generation-${manifest.generation}.json`);
	const generation = JSON.parse(readFileSync(path, "utf8"));
	generation.records[0].text = "tampered";
	writeFileSync(path, JSON.stringify(generation));
	assert.throws(() => new SemanticIndex(options), /checksum/);
});

test("provider bridge preserves the exact provider-owned profile identity without re-hashing", async () => {
	const providerProfile = {
		id: "embeddinggemma-2-q8-768",
		dimensions: 2,
		model: "fixture-model",
		assetIdentity: "fixture-checkpoint",
		canaryFingerprint: "fixture-canary",
		documentPrefix: "title: none | text: ",
	};
	const responseProfileIdentity = sourceHash("provider-owned-canonical-profile-recipe");
	const converted = embeddingProfileToSemanticProfile(providerProfile, responseProfileIdentity);
	assert.equal(semanticProfileKey(converted), responseProfileIdentity);
	assert.deepEqual(converted.identity, providerProfile);
	const index = new SemanticIndex({
		projectId: "project-a",
		profile: converted,
		cacheDir: isolated.dir,
		embed: async () => ({ profileKey: responseProfileIdentity, vectors: [[1, 0]] }),
	});
	assert.equal(index.profileKey, responseProfileIdentity);
	assert.equal((await index.refresh([record("bridge")])).complete, true);
	assert.equal(
		new SemanticIndex({ projectId: "project-a", profile: converted, cacheDir: isolated.dir }).status().vectors,
		1,
	);
});

test("cross-source results retain implementation and precedent when evidence bundles repeat", async () => {
	const index = new SemanticIndex({ projectId: "project-a", profile, embed: fixtureEmbed([]), cacheDir: isolated.dir });
	const evidence = Array.from({ length: 8 }, (_, i) => ({
		...record(`evidence-${i}`, "checkpoint retry"),
		kind: "evidence" as const,
	}));
	await index.refresh([
		...evidence,
		{ ...record("wiki", "checkpoint retry"), kind: "wiki" },
		{ ...record("memory", "checkpoint retry"), kind: "memory", memoryId: "m" },
		{ ...record("code-one", "checkpoint fence"), kind: "code" },
		{ ...record("code-two", "retry batch"), kind: "code" },
	]);
	const result = index.searchVector(
		"checkpoint retry",
		{ profileKey: index.profileKey, vector: [1, 0] },
		{
			projectId: "project-a",
			eligibleMemoryIds: ["m"],
			limit: 5,
		},
	);
	assert.equal(result.hits.length, 5);
	assert.deepEqual(
		result.hits
			.filter((hit) => hit.kind === "code")
			.map((hit) => hit.id)
			.sort(),
		["code-one", "code-two"],
	);
	assert.ok(result.hits.some((hit) => hit.kind === "memory"));
	assert.ok(result.hits.some((hit) => hit.kind === "wiki"));
});

test("broad artifact search follows source links without repeating pages from one file", async () => {
	const index = new SemanticIndex({ projectId: "project-a", profile, embed: fixtureEmbed([]), cacheDir: isolated.dir });
	const artifact = (id: string, path: string, text: string, sourceId = id): SemanticRecord => ({
		...record(id, text),
		sourceId,
		kind: "inbox",
		path,
	});
	await index.refresh([
		artifact("readme", "README.md", "A delayed oscillation occurred in an experiment"),
		artifact(
			"manifest",
			"run-manifest.json",
			"delayed oscillation plot run EXP-17: phase_echo.py exp17.ipynb exp17_delayed.png lab_notes.pdf",
		),
		artifact("note-page-2", "lab_notes.pdf", "delayed oscillation plot: phase_echo.py exp17_delayed.png", "note"),
		artifact("note-page-1", "lab_notes.pdf", "calibration plot", "note"),
		artifact("code", "phase_echo.py", "integrate the echo after the lag"),
		artifact("notebook", "exp17.ipynb", "notebook cell output"),
		artifact("plot", "exp17_delayed.png", "plot image"),
		artifact("decoy", "flat_noise.py", "control run noise"),
	]);
	const result = index.searchVector(
		"find the delayed oscillation plot",
		{ profileKey: index.profileKey, vector: [1, 0] },
		{ projectId: "project-a", limit: 5 },
	);
	assert.deepEqual(
		new Set(result.hits.map((hit) => hit.sourceId)),
		new Set(["manifest", "note", "code", "notebook", "plot"]),
	);
});
