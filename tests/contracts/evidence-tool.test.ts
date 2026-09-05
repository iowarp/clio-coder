import { deepStrictEqual, match, ok, strictEqual } from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { clioDataDir, clioStateDir } from "../../src/core/xdg.js";
import { materializePendingGateDecision, stagePendingGateDecision } from "../../src/domains/dispatch/gate-decisions.js";
import { withReceiptIntegrity } from "../../src/domains/dispatch/receipt-integrity.js";
import { evidenceDetailSnapshot } from "../../src/domains/evidence/detail.js";
import { buildEvidence, inspectEvidence, TRUST_STATUS_AXES } from "../../src/domains/evidence/index.js";
import { EVIDENCE_INVENTORY_MAX_ARTIFACTS } from "../../src/domains/evidence/inventory.js";
import { classify } from "../../src/domains/safety/action-classifier.js";
import { EVIDENCE_TOOL_MAX_BYTES, evidenceTool } from "../../src/tools/evidence.js";
import type { ToolResult } from "../../src/tools/registry.js";
import { fixtureEnvelope, fixtureReceiptDraft } from "../harness/receipt.js";
import { isolateClioEnv } from "../harness/scratch-env.js";

type EvidenceOutput = Awaited<ReturnType<typeof inspectEvidence>> &
	Awaited<ReturnType<typeof evidenceDetailSnapshot>> & {
		artifacts: { evidenceId: string }[];
		truncated: boolean;
		gateDecisions: unknown[];
	};

function output(result: ToolResult): EvidenceOutput {
	strictEqual(result.kind, "ok");
	return JSON.parse(result.output);
}

async function fixture(tampered = false, retired = false) {
	const envelope = fixtureEnvelope("fixture");
	const receipt = withReceiptIntegrity(
		{
			...fixtureReceiptDraft(envelope),
			validationGrounding: { claimed: 12, grounded: 1, ungrounded: ["typecheck"], basis: "no-command-executed" },
		},
		envelope,
	);
	if (tampered) receipt.tokenCount = 999999;
	if (retired) receipt.integrity.version = 1 as typeof receipt.integrity.version;
	await mkdir(join(clioStateDir(), "receipts"), { recursive: true });
	await writeFile(join(clioStateDir(), "runs.json"), JSON.stringify([envelope]));
	await writeFile(join(clioStateDir(), "receipts", "fixture.json"), JSON.stringify(receipt));
	return envelope;
}

describe("evidence tool", () => {
	let env: Awaited<ReturnType<typeof isolateClioEnv>>;
	beforeEach(async () => {
		env = await isolateClioEnv("evidence-tool-");
	});
	afterEach(() => env.restore());

	it("lists an empty inventory and bounds the newest fixture bundles", async () => {
		deepStrictEqual(output(await evidenceTool.run({ mode: "list" })).artifacts, []);
		await fixture();
		const built = await buildEvidence({ dataDir: clioDataDir(), stateDir: clioStateDir(), runId: "fixture" });
		for (let i = 0; i < EVIDENCE_INVENTORY_MAX_ARTIFACTS + 2; i += 1) {
			const id = `copy-${i}`;
			const dir = join(clioDataDir(), "evidence", id);
			await mkdir(dir, { recursive: true });
			await writeFile(
				join(dir, "overview.json"),
				JSON.stringify({ ...built.overview, evidenceId: id, generatedAt: new Date(2000000000000 + i).toISOString() }),
			);
		}
		const listed = output(await evidenceTool.run({ mode: "list" }));
		strictEqual(listed.artifacts.length, EVIDENCE_INVENTORY_MAX_ARTIFACTS);
		strictEqual(listed.truncated, true);
		strictEqual(listed.artifacts[0]?.evidenceId, `copy-${EVIDENCE_INVENTORY_MAX_ARTIFACTS + 1}`);
	});

	it("inspects the fixture using the CLI trust projection and canonical findings", async () => {
		await fixture();
		const built = await buildEvidence({ dataDir: clioDataDir(), stateDir: clioStateDir(), runId: "fixture" });
		strictEqual(built.ungroundedClaims, 11);
		const inspected = output(await evidenceTool.run({ mode: "inspect", id: built.evidenceId }));
		deepStrictEqual(inspected.overview, built.overview);
		deepStrictEqual(inspected.findings, built.findings);
		deepStrictEqual(inspected.trustStatus, built.trustStatus);
		deepStrictEqual(inspected.runs, (await evidenceDetailSnapshot(built.evidenceId)).runs);
		deepStrictEqual(Object.keys(inspected.runs[0]?.axes ?? {}), [...TRUST_STATUS_AXES]);
		strictEqual(inspected.runs[0]?.verdict, (await evidenceDetailSnapshot(built.evidenceId)).runs[0]?.verdict);
		deepStrictEqual(inspected.gateDecisions, []);
	});

	it("returns only integrity-verified gate decisions", async () => {
		await fixture();
		const built = await buildEvidence({ dataDir: clioDataDir(), stateDir: clioStateDir(), runId: "fixture" });
		const pending = stagePendingGateDecision(
			{
				group: "evidence-tool",
				topology: "review",
				cycle: 1,
				outcome: "pass",
				subjects: [{ runId: "fixture", digest: "a".repeat(64) }],
				createdAt: "2026-09-05T00:00:00.000Z",
			},
			{ stateDir: clioStateDir() },
		);
		const valid = materializePendingGateDecision(pending).artifact;
		await writeFile(
			join(built.directory, "gate-decisions.json"),
			JSON.stringify({ version: 1, evidenceId: built.evidenceId, decisions: [valid, { ...valid, outcome: "fail" }] }),
		);
		deepStrictEqual(output(await evidenceTool.run({ mode: "inspect", id: built.evidenceId })).gateDecisions, [valid]);
	});

	it("builds a missing run bundle and reuses an existing bundle", async () => {
		await fixture();
		strictEqual(output(await evidenceTool.run({ mode: "run", runId: "fixture" })).evidenceId, "run-fixture");
		const file = join(clioDataDir(), "evidence", "run-fixture", "overview.json");
		const before = await readFile(file, "utf8");
		await evidenceTool.run({ mode: "run", runId: "fixture" });
		strictEqual(await readFile(file, "utf8"), before);
		strictEqual(classify({ tool: "evidence", args: { mode: "run", runId: "fixture" } }).actionClass, "read");
	});

	it("reports absent artifacts distinctly from invalid ids and incomplete bundles", async () => {
		for (const args of [
			{ mode: "inspect", id: "missing" },
			{ mode: "run", runId: "missing" },
		]) {
			const result = await evidenceTool.run(args);
			strictEqual(result.kind, "error");
			deepStrictEqual(result.details, { code: "artifact_absent", artifactAbsent: true });
			if (result.kind === "error") match(result.message, /evidence artifact not found/);
		}
		const invalid = await evidenceTool.run({ mode: "inspect", id: "../escape" });
		strictEqual(invalid.kind, "error");
		strictEqual(invalid.details?.artifactAbsent, false);
		await fixture();
		const built = await buildEvidence({ dataDir: clioDataDir(), stateDir: clioStateDir(), runId: "fixture" });
		await writeFile(join(built.directory, "findings.json"), "broken");
		const broken = await evidenceTool.run({ mode: "inspect", id: built.evidenceId });
		strictEqual(broken.kind, "error");
		strictEqual(broken.details?.artifactAbsent, false);
	});

	it("bounds UTF-8 output while keeping the truncation envelope valid JSON", async () => {
		await fixture();
		const built = await buildEvidence({ dataDir: clioDataDir(), stateDir: clioStateDir(), runId: "fixture" });
		await writeFile(
			join(built.directory, "findings.json"),
			JSON.stringify({
				version: 1,
				evidenceId: built.evidenceId,
				findings: [
					{
						id: "large",
						severity: "warn",
						tag: "no-validation",
						runId: "fixture",
						message: '大"\n'.repeat(EVIDENCE_TOOL_MAX_BYTES),
					},
				],
			}),
		);
		const result = await evidenceTool.run({ mode: "inspect", id: built.evidenceId });
		strictEqual(output(result).truncated, true);
		if (result.kind !== "ok") return;
		ok(Buffer.byteLength(result.output, "utf8") <= EVIDENCE_TOOL_MAX_BYTES);
		deepStrictEqual(result.details, { truncated: true });
		ok(!result.output.includes("\uFFFD"));
	});

	it("withholds tampered receipt facts and ungrounded counts", async () => {
		await fixture(true);
		const built = await buildEvidence({ dataDir: clioDataDir(), stateDir: clioStateDir(), runId: "fixture" });
		strictEqual(built.ungroundedClaims, 0);
		const inspected = output(await evidenceTool.run({ mode: "inspect", id: built.evidenceId }));
		strictEqual(inspected.overview.totals.receipts, 0);
		strictEqual(inspected.overview.totals.tokens, 0);
		strictEqual(inspected.runs[0]?.verdict, "compromised");
		ok(inspected.findings.some((finding: { tag: string }) => finding.tag === "receipt-integrity"));
	});

	it("does not count claims from retired receipts", async () => {
		await fixture(false, true);
		const built = await buildEvidence({ dataDir: clioDataDir(), stateDir: clioStateDir(), runId: "fixture" });
		strictEqual(built.ungroundedClaims, 0);
		strictEqual((await inspectEvidence(clioDataDir(), built.evidenceId)).overview.totals.receipts, 0);
	});
});
