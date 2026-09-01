import { deepStrictEqual, ok, strictEqual, throws } from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { enumerateWorkspaceFiles, WorkspaceEnumerationLimitError } from "../../src/core/workspace-files.js";
import { heuristicBootstrapOutput } from "../../src/domains/context/bootstrap.js";
import { parseClioMd, serializeClioMd } from "../../src/domains/context/clio-md.js";
import { readProjectMetadata } from "../../src/domains/context/project-metadata.js";
import { detectProjectProfile } from "../../src/domains/session/workspace/project-type.js";
import { probeWorkspace } from "../../src/domains/session/workspace/snapshot.js";

const roots: string[] = [];

function scratch(): string {
	const root = mkdtempSync(join(tmpdir(), "clio-project-bootstrap-"));
	roots.push(root);
	return root;
}

function packageFile(root: string): void {
	writeFileSync(
		join(root, "package.json"),
		JSON.stringify({
			name: "operator-console",
			description: "A bounded operator console.",
			packageManager: "pnpm@10.0.0",
			scripts: { typecheck: "tsc --noEmit", test: "node --test" },
		}),
	);
}

describe("project bootstrap boundary", () => {
	afterEach(() => {
		for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
	});

	it("keeps workspace identity exact and derives metadata and language from repository facts", () => {
		const root = scratch();
		packageFile(root);
		mkdirSync(join(root, "src"));
		writeFileSync(join(root, "src", "index.ts"), "export const ready = true;\n");
		const nested = join(root, "src");
		deepStrictEqual(readProjectMetadata(root), {
			name: "operator-console",
			description: "A bounded operator console",
			nameSource: "package.json",
			descriptionSource: "package.json",
		});
		const profile = detectProjectProfile(root);
		strictEqual(profile.projectType, "typescript");
		strictEqual(profile.sourceFiles, 1);
		const workspace = probeWorkspace(nested);
		strictEqual(workspace.cwd, nested, "an enclosing root never replaces the bound workspace");
		strictEqual(workspace.projectType, "typescript");
	});

	it("enumerates a complete bounded file set without following symlinked trees", () => {
		const root = scratch();
		const outside = scratch();
		mkdirSync(join(root, "src"));
		writeFileSync(join(root, "src", "a.ts"), "a\n");
		writeFileSync(join(root, "src", "b.ts"), "b\n");
		writeFileSync(join(outside, "secret.ts"), "outside\n");
		symlinkSync(outside, join(root, "linked"), "dir");
		deepStrictEqual(enumerateWorkspaceFiles(root), ["src/a.ts", "src/b.ts"]);
		throws(
			() => enumerateWorkspaceFiles(root, undefined, { maxVisitedEntries: 1 }),
			(error: unknown) => error instanceof WorkspaceEnumerationLimitError && error.kind === "entries",
		);
	});

	it("builds a deterministic, parseable handbook artifact from bounded project evidence", async () => {
		const root = scratch();
		packageFile(root);
		mkdirSync(join(root, "src"));
		writeFileSync(join(root, "src", "index.ts"), "export const ready = true;\n");
		const output = await heuristicBootstrapOutput({
			cwd: root,
			projectType: "typescript",
			siblingFiles: [],
			adoption: {
				cwd: root,
				homeDir: root,
				includeGlobal: false,
				sources: [],
				rejected: [],
				importedRules: [],
				conflicts: [],
				sourceHash: "none",
				sourceSnapshots: [],
			},
			codewiki: {
				version: 5,
				language: "typescript",
				files: [
					{
						id: "src-index",
						path: "src/index.ts",
						lang: "typescript",
						loc: 1,
						role: "entry",
						hash: "fixture",
						imports: [],
					},
				],
				symbols: [],
				edges: [],
			},
		});
		strictEqual(output.projectName, "Operator Console");
		ok(output.identity.includes("bounded operator console"));
		ok(output.sections?.some(({ title, body }) => title === "Context retrieval" && body.includes("src/index.ts")));
		const artifact = serializeClioMd(output);
		const parsed = parseClioMd(artifact);
		ok(parsed.ok);
		if (parsed.ok) {
			strictEqual(parsed.value.projectName, output.projectName);
			deepStrictEqual(parsed.value.conventions, output.conventions);
		}
	});
});
