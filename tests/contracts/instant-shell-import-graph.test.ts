import { ok, strictEqual } from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { test } from "node:test";
import type { Metafile } from "esbuild";

const root = resolve(import.meta.dirname, "../..");
const buildDirectory = process.env.CLIO_TEST_BUILD_DIR ?? "dist";

test("production Stage 0 static closure stays within its measured bundle budget", () => {
	const metadata = JSON.parse(readFileSync(resolve(root, buildDirectory, "metafile-esm.json"), "utf8")) as Metafile;
	const owners = Object.entries(metadata.outputs).filter(
		([, output]) => "src/interactive/terminal-lease.ts" in output.inputs,
	);
	strictEqual(owners.length, 1, "build with pnpm build before checking the Stage 0 artifact");
	const owner = owners[0];
	ok(owner);
	// Metafile output names belong to the build checkout. Resolve the Stage 0
	// chunks against the selected artifact directory, including isolated builds.
	const chunkPath = (name: string): string => resolve(root, buildDirectory, relative(dirname(owner[0]), name));
	const closure = new Set<string>();
	const visit = (name: string): void => {
		if (closure.has(name)) return;
		const output = metadata.outputs[name];
		ok(output, `missing static output: ${name}`);
		closure.add(name);
		ok(statSync(chunkPath(name)).isFile(), `missing built chunk: ${name}`);
		for (const dependency of output.imports) {
			if (dependency.kind === "dynamic-import") continue;
			if (dependency.external) {
				ok(
					!/^@earendil-works\/pi-(ai|agent-core)(?:\/|$)/u.test(dependency.path),
					`Stage 0 must not load the model/agent SDK: ${dependency.path}`,
				);
			} else visit(dependency.path);
		}
	};
	visit(owner[0]);
	let totalBytes = 0;
	let clioBytes = 0;
	const forbidden =
		/^(?:src\/(?:entry\/orchestrator|domains\/(?:providers|dispatch|session)|tools\/|worker\/|engine\/(?:agent|api-registry|models|session))|.*node_modules\/.*(?:pi-ai|pi-agent-core|tree-sitter))/u;
	for (const name of closure) {
		const output = metadata.outputs[name];
		ok(output);
		// tsup appends source-map comments after esbuild reports its byte count.
		totalBytes += statSync(chunkPath(name)).size;
		for (const [source, contribution] of Object.entries(output.inputs)) {
			ok(!forbidden.test(source), `heavy runtime source entered Stage 0: ${source}`);
			if (source.startsWith("src/")) clioBytes += contribution.bytesInOutput;
		}
	}
	// Pi 0.86.1 bundled TUI: 13 chunks / 666,307 B, including 152,325 B of Clio.
	// Keep vendor bytes visible, with a separate cap so they cannot hide Clio growth.
	ok(closure.size <= 16, `Stage 0 chunks: ${closure.size} > 16`);
	ok(totalBytes <= 700_000, `Stage 0 bytes: ${totalBytes} > 700,000`);
	ok(clioBytes <= 165_000, `Stage 0 Clio source bytes: ${clioBytes} > 165,000`);
});
