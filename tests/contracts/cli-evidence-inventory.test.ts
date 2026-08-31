/**
 * `clio-coder evidence inventory --json`, the fixed read a GUI host may run.
 *
 * An evidence overview carries the working directories its runs executed in,
 * the task text the operator typed, and the file names inside the bundle. None
 * of it belongs in a GUI projection. What does is the shape of the artifact and
 * how far it can be trusted, and a bundle covering several runs is only as
 * trustworthy as its weakest one.
 */

import { deepStrictEqual, match, ok, strictEqual } from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { EVIDENCE_DETAIL_MAX_RUNS, evidenceDetailSnapshot } from "../../src/cli/evidence-detail.js";
import {
	EVIDENCE_INVENTORY_MAX_ARTIFACTS,
	EVIDENCE_INVENTORY_MAX_IDS,
	evidenceInventorySnapshot,
} from "../../src/cli/evidence-inventory.js";
import { makeScratchHome, runCli } from "../harness/spawn.js";

const AT = "2026-08-31T12:00:00.000Z";
const now = () => Date.parse(AT);

const AXES = [
	"artifactIntegrity",
	"validationGrounding",
	"independentReview",
	"contextProvenance",
	"autonomyEnforcement",
	"completionEvidence",
] as const;

const DIGEST = { algorithm: "sha256", value: "a".repeat(64) };

/**
 * One attributed axis in the canonical vocabulary.
 *
 * A non-absent axis must carry an exact source, authority, and artifact list;
 * the normalizer rejects anything else, and a rejected trust file would degrade
 * silently to "unknown" here, so the fixture uses the real shape.
 */
function axis(state: string, sourceKind: string, authorityKind: string, authorityId: string): Record<string, unknown> {
	return {
		state,
		source: { kind: sourceKind, id: "run-one" },
		authority: { kind: authorityKind, id: authorityId },
		artifacts: [{ kind: "run_receipt", id: "run-one", digest: DIGEST }],
	};
}

/** A canonical trust status with every axis absent except the ones named. */
function trustStatus(overrides: Partial<Record<(typeof AXES)[number], unknown>>): Record<string, unknown> {
	const status: Record<string, unknown> = { version: 1 };
	for (const named of AXES) {
		status[named] = overrides[named] ?? { state: "absent", reason: "not_recorded" };
	}
	return status;
}

interface SeedOptions {
	readonly generatedAt: string;
	readonly runIds?: ReadonlyArray<string>;
	readonly trust?: ReadonlyArray<{ runId: string; status: Record<string, unknown> }> | "missing";
}

/**
 * Write one bundle's `overview.json` and `trust-status.json` directly.
 *
 * Building real evidence would exercise the builder rather than the projection
 * under test, and the projection reads exactly these two files.
 */
function seedArtifact(dataDir: string, evidenceId: string, options: SeedOptions): void {
	const directory = join(dataDir, "evidence", evidenceId);
	mkdirSync(directory, { recursive: true });
	const runIds = options.runIds ?? ["run-one"];
	writeFileSync(
		join(directory, "overview.json"),
		JSON.stringify({
			version: 1,
			evidenceId,
			source: { kind: "run", runId: runIds[0] },
			generatedAt: options.generatedAt,
			runIds,
			sessionId: null,
			statuses: ["completed"],
			startedAt: "2026-08-31T11:00:00.000Z",
			endedAt: "2026-08-31T11:00:30.000Z",
			// The three fields a GUI projection must never echo.
			tasks: ["rewrite the credential loader at /private/secrets.yaml"],
			cwds: ["/private/researcher/code/secret-project"],
			agentIds: ["coder"],
			targetIds: ["blade-gateway"],
			runtimeIds: ["litellm"],
			modelIds: ["code"],
			totals: {
				runs: runIds.length,
				receipts: 1,
				toolCalls: 4,
				toolErrors: 1,
				blockedToolCalls: 2,
				sessionEntries: 9,
				auditRows: 3,
				toolEvents: 4,
				linkedToolEvents: 4,
				protectedArtifacts: 1,
				tokens: 12_615,
				costUsd: 0.5,
				wallTimeMs: 13_368,
			},
			tags: ["audit-linked", "blocked-tool"],
			files: ["overview.json", "transcript.md", "trust-status.json"],
			redactionCount: 2,
		}),
	);
	// Every real bundle carries findings.json, and `inspectEvidence` treats its
	// absence as an incomplete bundle rather than an empty one.
	writeFileSync(
		join(directory, "findings.json"),
		JSON.stringify({
			version: 1,
			findings: [
				{
					id: `${evidenceId}-finding-0`,
					tag: "blocked-tool",
					severity: "warn",
					runId: runIds[0],
					message: "a tool call was blocked while writing /private/secrets.yaml",
				},
			],
		}),
	);
	if (options.trust === "missing") return;
	writeFileSync(
		join(directory, "trust-status.json"),
		JSON.stringify({
			version: 1,
			evidenceId,
			projection: "canonical",
			runs: options.trust ?? [{ runId: runIds[0], status: trustStatus({}) }],
		}),
	);
}

describe("contracts/cli-evidence-inventory", () => {
	const scratch = makeScratchHome("clio-evidence-inventory-");
	after(() => scratch.cleanup());

	it("reports an installation with no bundles as an empty, untruncated inventory", async () => {
		const snapshot = await evidenceInventorySnapshot(now, join(scratch.dir, "empty-data"));
		strictEqual(snapshot.version, 1);
		strictEqual(snapshot.generatedAt, AT);
		deepStrictEqual(snapshot.artifacts, []);
		strictEqual(snapshot.truncated, false);
	});

	it("projects provenance, tags, and totals without task text, working directories, or file names", async () => {
		const dataDir = join(scratch.dir, "one-data");
		seedArtifact(dataDir, "run-alpha", { generatedAt: "2026-08-31T11:00:30.000Z" });

		const snapshot = await evidenceInventorySnapshot(now, dataDir);
		strictEqual(snapshot.artifacts.length, 1);
		const artifact = snapshot.artifacts[0];
		ok(artifact !== undefined);
		strictEqual(artifact.evidenceId, "run-alpha");
		strictEqual(artifact.sourceKind, "run");
		deepStrictEqual(artifact.runIds, ["run-one"]);
		strictEqual(artifact.runIdsTruncated, false);
		deepStrictEqual(artifact.agentIds, ["coder"]);
		deepStrictEqual(artifact.tags, ["audit-linked", "blocked-tool"]);
		strictEqual(artifact.totals.blockedToolCalls, 2);
		strictEqual(artifact.totals.tokens, 12_615);
		strictEqual(artifact.totals.costUsd, 0.5);
		strictEqual(artifact.redactionCount, 2);

		const framed = JSON.stringify(snapshot);
		for (const forbidden of [
			"/private/",
			"credential loader",
			"secret-project",
			"transcript.md",
			"sessionEntries",
			"auditRows",
		])
			ok(!framed.includes(forbidden), `evidence inventory leaked ${forbidden}`);
	});

	it("folds a multi-run bundle to its weakest run and names a bundle with no trust file", async () => {
		const dataDir = join(scratch.dir, "trust-data");
		// One clean run and one whose validation failed: the bundle is compromised.
		seedArtifact(dataDir, "run-mixed", {
			generatedAt: "2026-08-31T11:30:00.000Z",
			runIds: ["run-clean", "run-broken"],
			trust: [
				{
					runId: "run-clean",
					status: trustStatus({
						artifactIntegrity: axis("verified", "receipt_integrity_verification", "clio", "receipt-integrity"),
					}),
				},
				{
					runId: "run-broken",
					status: trustStatus({
						artifactIntegrity: axis("verified", "receipt_integrity_verification", "clio", "receipt-integrity"),
						validationGrounding: axis("failed", "run_receipt", "validator", "receipt-quality"),
					}),
				},
			],
		});
		// A bundle written before the canonical projection existed.
		seedArtifact(dataDir, "run-historical", {
			generatedAt: "2026-08-31T11:00:00.000Z",
			trust: "missing",
		});

		const snapshot = await evidenceInventorySnapshot(now, dataDir);
		deepStrictEqual(
			snapshot.artifacts.map((artifact) => [artifact.evidenceId, artifact.trust.verdict, artifact.trust.historical]),
			[
				["run-mixed", "compromised", false],
				["run-historical", "unknown", true],
			],
		);
		strictEqual(snapshot.artifacts[0]?.trust.runsCovered, 2);
		strictEqual(snapshot.artifacts[1]?.trust.runsCovered, 0);
	});

	it("orders bundles newest first and bounds both the window and each id list", async () => {
		const dataDir = join(scratch.dir, "many-data");
		for (let index = 0; index < EVIDENCE_INVENTORY_MAX_ARTIFACTS + 2; index += 1) {
			seedArtifact(dataDir, `run-${index}`, {
				// Written oldest first, so the ordering under test is not the write order.
				generatedAt: `2026-08-31T11:${String(index).padStart(2, "0")}:00.000Z`,
				runIds: Array.from({ length: EVIDENCE_INVENTORY_MAX_IDS + 3 }, (_, slot) => `run-${index}-${slot}`),
			});
		}

		const snapshot = await evidenceInventorySnapshot(now, dataDir);
		strictEqual(snapshot.artifacts.length, EVIDENCE_INVENTORY_MAX_ARTIFACTS);
		strictEqual(snapshot.truncated, true);
		strictEqual(snapshot.artifacts[0]?.evidenceId, "run-13");
		strictEqual(snapshot.artifacts.at(-1)?.evidenceId, "run-2");
		strictEqual(snapshot.artifacts[0]?.runIds.length, EVIDENCE_INVENTORY_MAX_IDS);
		strictEqual(snapshot.artifacts[0]?.runIdsTruncated, true);
	});

	it("refuses every argv but the fixed one, and answers the fixed one on a fresh install", async () => {
		for (const args of [
			["evidence", "inventory"],
			["evidence", "inventory", "--json", "--json"],
			["evidence", "inventory", "run-alpha"],
			["evidence", "inventory", "--run", "run-alpha"],
		]) {
			const result = await runCli(args, { env: scratch.env });
			strictEqual(result.code, 2, `stdout=${result.stdout} stderr=${result.stderr}`);
			strictEqual(result.stdout, "", `unexpected stdout: ${result.stdout}`);
			match(result.stderr, /inventory/);
		}

		const fixed = await runCli(["evidence", "inventory", "--json"], { env: scratch.env });
		strictEqual(fixed.code, 0, `stderr=${fixed.stderr}`);
		const payload = JSON.parse(fixed.stdout) as { version: number; artifacts: unknown[]; truncated: boolean };
		strictEqual(payload.version, 1);
		deepStrictEqual(payload.artifacts, []);
		strictEqual(payload.truncated, false);
	});

	it("reads one bundle down to closed vocabularies and nothing else", async () => {
		const dataDir = join(scratch.dir, "detail-data");
		seedArtifact(dataDir, "run-detail", {
			generatedAt: "2026-08-31T11:30:00.000Z",
			runIds: ["run-one"],
			trust: [
				{
					runId: "run-one",
					status: trustStatus({
						artifactIntegrity: axis("verified", "receipt_integrity_verification", "clio", "receipt-integrity"),
						validationGrounding: axis("failed", "run_receipt", "validator", "receipt-quality"),
					}),
				},
			],
		});

		const detail = await evidenceDetailSnapshot("run-detail", now, dataDir);
		strictEqual(detail.version, 1);
		strictEqual(detail.evidenceId, "run-detail");
		strictEqual(detail.sourceKind, "run");
		strictEqual(detail.canonical, true);
		strictEqual(detail.runsTruncated, false);
		strictEqual(detail.runs.length, 1);
		// The inventory says the bundle is compromised; the detail says which axis
		// made it so, which is the whole reason this read exists.
		strictEqual(detail.runs[0]?.verdict, "compromised");
		deepStrictEqual(detail.runs[0]?.axes, {
			artifactIntegrity: "verified",
			validationGrounding: "failed",
			// Every axis is always present, so an unrecorded one is stated rather
			// than missing from the record.
			independentReview: "absent",
			contextProvenance: "absent",
			autonomyEnforcement: "absent",
			completionEvidence: "absent",
		});

		// The bundle's prose surfaces are exactly what this read must not carry.
		const framed = JSON.stringify(detail);
		for (const forbidden of ["/private/", "credential loader", "transcript.md", "receipt-quality", "sha256"]) {
			ok(!framed.includes(forbidden), `evidence detail leaked ${forbidden}`);
		}
	});

	it("reports a historical bundle as non-canonical instead of inventing axes", async () => {
		const dataDir = join(scratch.dir, "detail-historical");
		seedArtifact(dataDir, "run-old", { generatedAt: "2026-08-31T11:00:00.000Z", trust: "missing" });

		const detail = await evidenceDetailSnapshot("run-old", now, dataDir);
		strictEqual(detail.canonical, false);
		deepStrictEqual(detail.runs, []);
		strictEqual(detail.runsTruncated, false);
		strictEqual(detail.runs.length <= EVIDENCE_DETAIL_MAX_RUNS, true);
	});

	it("emits the same record through the CLI and refuses an unknown bundle", async () => {
		const known = await runCli(["evidence", "inspect", "run-alpha", "--json"], {
			env: { ...scratch.env, XDG_DATA_HOME: join(scratch.dir, "one-data-home") },
		});
		// The scratch data home has no bundles, so the id is genuinely unknown and
		// the command must fail rather than print an empty record.
		strictEqual(known.code === 0, false, `stdout=${known.stdout}`);
		strictEqual(known.stdout, "", `unexpected stdout: ${known.stdout}`);
		match(known.stderr, /run-alpha/);
	});
});
