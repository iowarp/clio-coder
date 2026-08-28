import { ok, strictEqual } from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { artifactDefaultPath, CLIO_ARTIFACT_DIR } from "../../src/core/artifact-paths.js";
import { asDirectoryPathBoundary } from "../../src/core/path-boundary.js";
import { ToolNames } from "../../src/core/tool-names.js";
import type { SafetyContract } from "../../src/domains/safety/contract.js";
import { createWorkerSafety } from "../../src/engine/worker-tools.js";
import { createArtifactTool } from "../../src/tools/artifact.js";

/**
 * The placement contract: everything Clio generates on its own lands under the
 * gitignored `.clio-coder/`, and the repo working tree holds only files a human
 * asked for. The defect this pins: a report-writing turn dropped REPORT.md into
 * the repo root while a second agent was working in the same tree, twice in one
 * day, from turns nobody asked a root-level file from.
 */
describe("contracts/artifact placement", () => {
	let cwd: string;

	beforeEach(() => {
		cwd = mkdtempSync(join(tmpdir(), "clio-artifact-placement-"));
	});

	afterEach(() => {
		rmSync(cwd, { recursive: true, force: true });
	});

	for (const [kind, filename] of [
		["plan", "PLAN.md"],
		["review", "REVIEW.md"],
		["report", "REPORT.md"],
	] as const) {
		it(`writes a pathless ${kind} under ${CLIO_ARTIFACT_DIR}/ and never in the working tree`, async () => {
			const tool = createArtifactTool({ getCwd: () => cwd });
			const result = await tool.run({ kind, content: `# ${kind}\n\nbody` });

			strictEqual(result.kind, "ok");
			const target = join(cwd, CLIO_ARTIFACT_DIR, filename);
			ok(existsSync(target), `${kind} artifact should exist at ${target}`);
			strictEqual(existsSync(join(cwd, filename)), false, "the repo root stays clean");
			if (result.kind === "ok") {
				ok(result.output.includes(join(CLIO_ARTIFACT_DIR, filename)), result.output);
				ok(result.terminate);
			}
		});
	}

	it("still honors an explicit path, including one in the working tree", async () => {
		const tool = createArtifactTool({ getCwd: () => cwd });
		mkdirSync(join(cwd, "docs"), { recursive: true });
		const result = await tool.run({ kind: "report", path: "docs/findings.md", content: "body" });

		strictEqual(result.kind, "ok");
		strictEqual(readFileSync(join(cwd, "docs", "findings.md"), "utf8"), "body");
		strictEqual(existsSync(join(cwd, CLIO_ARTIFACT_DIR, "REPORT.md")), false);
	});

	it("reports the artifact's byte count as the ledger's shown size, not the confirmation length", async () => {
		const tool = createArtifactTool({ getCwd: () => cwd });
		const content = `# plan\n\n${"detail ".repeat(700)}`;
		const result = await tool.run({ kind: "plan", content });

		strictEqual(result.kind, "ok");
		const bytes = Buffer.byteLength(content, "utf8");
		const observation = result.details?.observation as { shownBytes?: unknown } | undefined;
		strictEqual(observation?.shownBytes, bytes);
		if (result.kind === "ok") ok(result.output.includes(`(${bytes}B)`), result.output);
	});

	it("refuses a path that escapes the workspace", async () => {
		const tool = createArtifactTool({ getCwd: () => cwd });
		const result = await tool.run({ kind: "report", path: "../escape.md", content: "body" });
		strictEqual(result.kind, "error");
		if (result.kind === "error") ok(result.message.includes("escapes workspace root"));
	});

	it("resolves every kind under the artifact directory, unknown kinds included", () => {
		strictEqual(artifactDefaultPath("plan"), `${CLIO_ARTIFACT_DIR}/PLAN.md`);
		strictEqual(artifactDefaultPath("review"), `${CLIO_ARTIFACT_DIR}/REVIEW.md`);
		strictEqual(artifactDefaultPath("report"), `${CLIO_ARTIFACT_DIR}/REPORT.md`);
		strictEqual(artifactDefaultPath(undefined), `${CLIO_ARTIFACT_DIR}/PLAN.md`);
	});
});

/**
 * The safety layer predicts the path a pathless artifact call will write to,
 * from the arguments alone. If its prediction and the tool's default ever
 * diverge, the write-root check guards a file nobody writes. These pin the two
 * to the same answer through the confinement seam.
 */
describe("contracts/artifact placement under write-root confinement", () => {
	let scratch: string;
	let originalCwd: string;

	beforeEach(() => {
		originalCwd = process.cwd();
		scratch = mkdtempSync(join(tmpdir(), "clio-artifact-roots-"));
		process.chdir(scratch);
	});

	afterEach(() => {
		process.chdir(originalCwd);
		rmSync(scratch, { recursive: true, force: true });
	});

	function safetyWithRoot(root: string): SafetyContract {
		return createWorkerSafety({ cwd: scratch, writeRoots: [asDirectoryPathBoundary(join(scratch, root))] });
	}

	it("admits a pathless artifact call when the artifact directory is a write root", () => {
		const decision = safetyWithRoot(CLIO_ARTIFACT_DIR).evaluate({
			tool: ToolNames.Artifact,
			args: { kind: "report" },
		});
		strictEqual(decision.kind, "allow");
	});

	it("blocks a pathless artifact call when only the working tree is a write root", () => {
		const decision = safetyWithRoot("src").evaluate({ tool: ToolNames.Artifact, args: { kind: "report" } });
		strictEqual(decision.kind, "block");
		strictEqual(decision.policy?.reasonCode, "write-root");
	});
});
