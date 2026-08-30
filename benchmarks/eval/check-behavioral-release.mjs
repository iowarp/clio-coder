#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));
const suite = join(root, "benchmarks/eval/behavioral-machinery.yaml");
const baselinePath = join(root, "benchmarks/eval/behavioral-machinery-baseline.json");
const cli = join(root, "dist/cli/index.js");
const update = process.argv.slice(2).includes("--update");
const scratch = mkdtempSync(join(tmpdir(), "clio-behavioral-release-"));
const artifactPath = join(scratch, "candidate.json");

try {
	execFileSync(
		process.execPath,
		[cli, "eval", "run", "--suite", suite, "--out", artifactPath, "--clio-coder-entry", cli],
		{
			cwd: root,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
			env: {
				...process.env,
				CLIO_CODER_STATE_DIR: join(scratch, "state"),
			},
		},
	);
	const artifact = JSON.parse(readFileSync(artifactPath, "utf8"));
	const evidence = releaseEvidence(artifact);
	const rendered = formatBaseline(evidence);
	if (update) {
		writeFileSync(baselinePath, rendered, "utf8");
		process.stdout.write(`behavioral-release: updated ${baselinePath}\n`);
		process.exit(0);
	}
	const baseline = readFileSync(baselinePath, "utf8");
	if (baseline === rendered) {
		process.stdout.write(
			`behavioral-release: pass (${evidence.results.length} machinery scenarios matched the checked baseline)\n`,
		);
		process.exit(0);
	}
	const candidatePath = join(scratch, "behavioral-machinery-candidate.json");
	writeFileSync(candidatePath, rendered, "utf8");
	process.stderr.write("behavioral-release: candidate differs from the checked machinery baseline\n");
	for (const affected of affectedCorpusResults(JSON.parse(baseline), evidence)) {
		process.stderr.write(
			`behavioral-release: affected corpus result ${affected.scenarioId} role=${affected.role} changed=${affected.changed.join(",")}\n`,
		);
	}
	try {
		execFileSync("git", ["diff", "--no-index", "--", baselinePath, candidatePath], {
			cwd: root,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		});
	} catch (error) {
		if (typeof error?.stdout === "string") process.stderr.write(error.stdout);
	}
	process.stderr.write(
		`behavioral-release: review the diff, then run node benchmarks/eval/check-behavioral-release.mjs --update and commit the baseline intentionally\n`,
	);
	process.exit(1);
} finally {
	rmSync(scratch, { recursive: true, force: true });
}

function releaseEvidence(artifact) {
	if (artifact?.version !== 4 || !Array.isArray(artifact.results)) {
		throw new Error("behavioral-release: eval runner did not produce Artifact v4");
	}
	const results = artifact.results.map((result) => {
		if (result.executionEnvelope?.schema !== "clio.eval.execution-envelope.v1") {
			throw new Error(`behavioral-release: ${String(result.taskId)} has no execution envelope`);
		}
		return {
			scenarioId: result.taskId,
			role: result.behavioralMetrics?.role ?? "unknown",
			outcome: result.behavioral?.outcome ?? "unmeasured",
			labels: Object.fromEntries((result.behavioral?.labels ?? []).map((label) => [label.category, label.label])),
			metrics: Object.fromEntries(
				Object.entries(result.behavioralMetrics?.metrics ?? {})
					.filter(([name]) => name !== "latency.wallMs")
					.map(([name, observation]) => [name, observation.value]),
			),
			executionEnvelope: result.executionEnvelope,
		};
	});
	results.sort((left, right) => left.scenarioId.localeCompare(right.scenarioId));
	return {
		schema: "clio.eval.behavior.release-baseline.v1",
		corpus: { id: "public-built-in-behavior", version: "1.0.0" },
		suite: { id: artifact.suite.id, hash: artifact.suite.hash },
		matrixDimensions: artifact.matrix.dimensions ?? [],
		results,
	};
}

function formatBaseline(evidence) {
	const biome = join(root, "node_modules", ".bin", "biome");
	return execFileSync(biome, ["format", "--stdin-file-path", baselinePath], {
		input: `${JSON.stringify(evidence, null, "\t")}\n`,
		encoding: "utf8",
	});
}

function affectedCorpusResults(baseline, candidate) {
	const previous = new Map((baseline.results ?? []).map((result) => [result.scenarioId, result]));
	return candidate.results.flatMap((result) => {
		const before = previous.get(result.scenarioId);
		if (before === undefined) return [{ scenarioId: result.scenarioId, role: result.role, changed: ["scenario"] }];
		const changed = [];
		if (stableJson(before.executionEnvelope?.prompt) !== stableJson(result.executionEnvelope.prompt)) {
			changed.push("prompt");
		}
		if (stableJson(before.executionEnvelope?.recipe) !== stableJson(result.executionEnvelope.recipe)) {
			changed.push("recipe");
		}
		if (stableJson(before) !== stableJson(result) && changed.length === 0) changed.push("behavior");
		return changed.length === 0 ? [] : [{ scenarioId: result.scenarioId, role: result.role, changed }];
	});
}

function stableJson(value) {
	if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
	if (value !== null && typeof value === "object") {
		return `{${Object.entries(value)
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
			.join(",")}}`;
	}
	return JSON.stringify(value);
}
