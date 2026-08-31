import { equal, ok, rejects, throws } from "node:assert/strict";
import {
	ClioCliEvidenceInspector,
	ClioEvidenceInspectError,
	projectEvidenceDetail,
	projectEvidenceInspection,
} from "../clio-evidence-inspector.ts";

const FIXTURE = new URL("./evidence-inspect-child-fixture.ts", import.meta.url).pathname;

Deno.test("the evidence adapter invokes only the fixed inventory projection", async () => {
	const root = await Deno.makeTempDir({ prefix: "clio-coder-gui-evidence-inspect-" });
	try {
		const inspector = new ClioCliEvidenceInspector({
			executable: Deno.execPath(),
			prefixArgs: ["run", "--quiet", "--no-config", FIXTURE, "--"],
			now: () => Date.parse("2026-08-31T14:02:00.000Z"),
		});
		const inspection = await inspector.inspect(root);
		equal(inspection.scope, "installation");
		equal(inspection.inspectedAt, "2026-08-31T14:02:00.000Z");
		equal(inspection.artifacts.length, 2);
		equal(inspection.truncated, true);
		const bundle = inspection.artifacts[0];
		ok(bundle !== undefined);
		equal(bundle.evidenceId, "run-alpha-bundle");
		equal(bundle.trust.verdict, "compromised");
		equal(bundle.redactionCount, 3);
		equal(bundle.runIdsTruncated, true);
		// A bundle written before the canonical projection reports no verdict of
		// its own rather than a flattering default.
		equal(inspection.artifacts[1]?.trust.historical, true);
		equal(inspection.artifacts[1]?.trust.verdict, "unknown");
		const frame = JSON.stringify(inspection);
		for (const forbidden of ["tasks", "cwds", "files", "sessionEntries", "auditRows", "/home/"]) {
			ok(!frame.includes(forbidden), `evidence projection leaked ${forbidden}`);
		}
	} finally {
		await Deno.remove(root, { recursive: true });
	}
});

Deno.test("evidence projection rejects extra fields, duplicates, and contradictory trust", () => {
	const artifact = {
		evidenceId: "run-alpha-bundle",
		sourceKind: "run",
		generatedAt: "2026-08-31T14:00:40.000Z",
		startedAt: null,
		endedAt: null,
		runIds: ["run-alpha"],
		runIdsTruncated: false,
		agentIds: ["builder"],
		statuses: ["completed"],
		tags: ["audit-linked"],
		totals: {
			runs: 1,
			receipts: 1,
			toolCalls: 4,
			toolErrors: 1,
			blockedToolCalls: 1,
			protectedArtifacts: 0,
			tokens: 100,
			costUsd: 0.5,
			wallTimeMs: 1_000,
		},
		redactionCount: 0,
		trust: { verdict: "grounded", runsCovered: 1, historical: false },
	};
	const at = "2026-08-31T14:02:00.000Z";
	const base = { version: 1, generatedAt: at, truncated: false };

	equal(projectEvidenceInspection({ ...base, artifacts: [artifact] }, at).artifacts.length, 1);

	// The task text, working directories, and file list are the fields that must
	// never appear, so an unknown key is refused rather than ignored.
	throws(
		() => projectEvidenceInspection({ ...base, artifacts: [{ ...artifact, tasks: ["rewrite it"] }] }, at),
		/invalid evidence row/u,
	);
	throws(
		() => projectEvidenceInspection({ ...base, artifacts: [artifact, artifact] }, at),
		/duplicate evidence identities/u,
	);
	// A historical bundle has no canonical runs and no verdict of its own.
	throws(
		() =>
			projectEvidenceInspection({
				...base,
				artifacts: [{ ...artifact, trust: { verdict: "grounded", runsCovered: 0, historical: true } }],
			}, at),
		/contradictory evidence trust facts/u,
	);
	// A failed call is a subset of the calls that were attempted.
	throws(
		() =>
			projectEvidenceInspection({
				...base,
				artifacts: [{ ...artifact, totals: { ...artifact.totals, toolErrors: 9 } }],
			}, at),
		/contradictory evidence tool counts/u,
	);
	throws(
		() =>
			projectEvidenceInspection({
				...base,
				artifacts: [{ ...artifact, runIds: ["run-alpha", "run-alpha"] }],
			}, at),
		/invalid evidence run id list/u,
	);
});

Deno.test("evidence inspection maps incompatible output to a bounded GUI error", async () => {
	const inspector = new ClioCliEvidenceInspector({
		executable: Deno.execPath(),
		prefixArgs: ["eval", "console.log('{}')", "--"],
	});
	await rejects(
		() => inspector.inspect(Deno.cwd()),
		(error: unknown) => error instanceof ClioEvidenceInspectError && error.code === "internal",
	);
});

Deno.test("the bundle read projects closed vocabularies and refuses a record for another bundle", () => {
	const at = "2026-08-31T14:03:00.000Z";
	const axes = {
		artifactIntegrity: "verified",
		validationGrounding: "failed",
		independentReview: "absent",
		contextProvenance: "recorded",
		autonomyEnforcement: "enforced",
		completionEvidence: "absent",
	};
	const base = {
		version: 1,
		generatedAt: "2026-08-31T14:00:40.000Z",
		evidenceId: "run-alpha-bundle",
		sourceKind: "run",
		canonical: true,
		runs: [{ runId: "run-alpha", verdict: "compromised", axes }],
		runsTruncated: false,
	};

	const detail = projectEvidenceDetail(base, at, "run-alpha-bundle");
	equal(detail.runs[0]?.axes.validationGrounding, "failed");
	equal(detail.inspectedAt, at);

	// The single failure this whole boundary exists to prevent: a process that
	// read something other than the artifact the allowlist admitted.
	throws(
		() => projectEvidenceDetail(base, at, "run-beta-bundle"),
		/record for a different evidence artifact/u,
	);
	// Each axis owns its own state set, so a state legal elsewhere is still a
	// rejection here.
	throws(
		() =>
			projectEvidenceDetail(
				{
					...base,
					runs: [{ runId: "run-alpha", verdict: "compromised", axes: { ...axes, contextProvenance: "validated" } }],
				},
				at,
				"run-alpha-bundle",
			),
		/invalid evidence axis state/u,
	);
	// Every axis is always reported, so a partial record is refused rather than
	// silently filled in.
	throws(
		() =>
			projectEvidenceDetail(
				{
					...base,
					runs: [{ runId: "run-alpha", verdict: "compromised", axes: { artifactIntegrity: "verified" } }],
				},
				at,
				"run-alpha-bundle",
			),
		/incomplete evidence axis record/u,
	);
	// A non-canonical bundle has no axes to report.
	throws(
		() => projectEvidenceDetail({ ...base, canonical: false }, at, "run-alpha-bundle"),
		/contradictory evidence projection facts/u,
	);
	throws(
		() =>
			projectEvidenceDetail(
				{
					...base,
					runs: [base.runs[0], base.runs[0]],
				},
				at,
				"run-alpha-bundle",
			),
		/duplicate evidence trust runs/u,
	);
});
