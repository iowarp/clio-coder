/**
 * Evidence bundles stopped writing four files no reader opened:
 * `trace.raw.jsonl`, `trace.cleaned.jsonl`, `audit-linked.jsonl` and
 * `protected-artifacts.json`. A new bundle holds exactly the files its
 * overview lists, and a bundle an earlier build wrote with the retired files
 * still reads through every store accessor.
 */
import { deepStrictEqual, equal, ok } from "node:assert/strict";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, it } from "node:test";
import { clioDataDir, clioStateDir } from "../../src/core/xdg.js";
import { withReceiptIntegrity } from "../../src/domains/dispatch/receipt-integrity.js";
import { buildEvidence } from "../../src/domains/evidence/build.js";
import {
	EVIDENCE_FILES,
	inspectEvidence,
	listEvidenceOverviews,
	loadEvidenceRunProvenance,
	loadEvidenceTrustStatus,
} from "../../src/domains/evidence/store.js";
import { fixtureEnvelope, fixtureReceiptDraft } from "../harness/receipt.js";
import { isolateClioEnv } from "../harness/scratch-env.js";

const RETIRED = ["trace.raw.jsonl", "trace.cleaned.jsonl", "audit-linked.jsonl", "protected-artifacts.json"];

let env: Awaited<ReturnType<typeof isolateClioEnv>>;
beforeEach(async () => {
	env = await isolateClioEnv("clio-coder-evidence-files-");
	const envelope = fixtureEnvelope("fixture");
	const receipt = withReceiptIntegrity(fixtureReceiptDraft(envelope), envelope);
	await mkdir(join(clioStateDir(), "receipts"), { recursive: true });
	await writeFile(join(clioStateDir(), "runs.json"), JSON.stringify([envelope]));
	await writeFile(join(clioStateDir(), "receipts", "fixture.json"), JSON.stringify(receipt));
});
afterEach(() => env.restore());

it("writes exactly the files the overview lists and none of the retired ones", async () => {
	const built = await buildEvidence({ dataDir: clioDataDir(), stateDir: clioStateDir(), runId: "fixture" });
	const written = (await readdir(built.directory)).sort();
	deepStrictEqual(written, [...EVIDENCE_FILES].sort());
	deepStrictEqual([...built.overview.files].sort(), [...EVIDENCE_FILES].sort());
	for (const file of RETIRED) equal((written as string[]).includes(file), false, `${file} must not be written`);
});

it("still reads a bundle an earlier build wrote with the retired files", async () => {
	const built = await buildEvidence({ dataDir: clioDataDir(), stateDir: clioStateDir(), runId: "fixture" });
	await writeFile(
		join(built.directory, "overview.json"),
		JSON.stringify({ ...built.overview, files: [...built.overview.files, ...RETIRED] }),
	);
	for (const file of RETIRED) await writeFile(join(built.directory, file), file.endsWith(".json") ? "{}" : "");
	const inspected = await inspectEvidence(clioDataDir(), built.evidenceId);
	equal(inspected.overview.evidenceId, built.evidenceId);
	ok((inspected.overview.files as readonly string[]).includes("audit-linked.jsonl"));
	equal((await loadEvidenceTrustStatus(clioDataDir(), built.evidenceId)).evidenceId, built.evidenceId);
	// The fixture receipt carries no provenance set, so the read returns none rather than failing.
	deepStrictEqual(await loadEvidenceRunProvenance(clioDataDir(), built.evidenceId), []);
	ok((await listEvidenceOverviews(clioDataDir())).some((overview) => overview.evidenceId === built.evidenceId));
});
