import { ok, strictEqual } from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { test } from "node:test";
import type { Metafile } from "esbuild";

const root = resolve(import.meta.dirname, "../..");
const buildDirectory = process.env.CLIO_TEST_BUILD_DIR ?? "dist";
// The 0.6.2 sprint measured Effect at 55-117 ms per cold first use and cut it.
// An externalized import evades a byte count, so both input and external paths
// are checked for every eagerly loaded chunk.
const effectPackage = /(?:^effect(?:\/|$)|node_modules\/(?:.*\/)?effect(?:\/|$))/u;

function readMetafile(): Metafile {
	return JSON.parse(readFileSync(resolve(root, buildDirectory, "metafile-esm.json"), "utf8")) as Metafile;
}

function assertNoEffect(metadata: Metafile, entry: string, label: string): void {
	const seen = new Set<string>();
	const visit = (name: string): void => {
		if (seen.has(name)) return;
		const output = metadata.outputs[name];
		ok(output, `missing static output: ${name}`);
		seen.add(name);
		for (const source of Object.keys(output.inputs)) {
			ok(!effectPackage.test(source), `${label} bundles Effect: ${source}`);
		}
		for (const dependency of output.imports) {
			if (dependency.kind === "dynamic-import") continue;
			if (dependency.external) ok(!effectPackage.test(dependency.path), `${label} imports Effect: ${dependency.path}`);
			else visit(dependency.path);
		}
	};
	visit(entry);
}

test("production Stage 0 static closure stays within its measured bundle budget", () => {
	const metadata = readMetafile();
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
	assertNoEffect(metadata, owner[0], "Stage 0");
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
	// Pi 0.87.1 bundled TUI: 13 chunks / 670,404 B, including 156,272 B of Clio.
	// 0.5.6 measured 15 chunks and 171,937 B of Clio: the composer dock and the
	// terminal background probe both draw the first frame, so they belong here.
	// 0.5.7 measured 15 chunks / 731,619 B with 211,363 B of Clio after the
	// composer rail's context meter moved into a leaf; the caps were doubled
	// from 16 / 700,000 / 175,000 for the larger first frame. A leak through a
	// render module still shows here at several times these numbers.
	// Keep vendor bytes visible, with a separate cap so they cannot hide Clio growth.
	ok(closure.size <= 32, `Stage 0 chunks: ${closure.size} > 32`);
	ok(totalBytes <= 1_400_000, `Stage 0 bytes: ${totalBytes} > 1,400,000`);
	ok(clioBytes <= 350_000, `Stage 0 Clio source bytes: ${clioBytes} > 350,000`);
});

test("CLI entry static closure loads no Effect", () => {
	const metadata = readMetafile();
	const entries = Object.entries(metadata.outputs).filter(([, output]) => output.entryPoint === "src/cli/index.ts");
	strictEqual(entries.length, 1, "build with pnpm build before checking the CLI artifact");
	const entry = entries[0];
	ok(entry);
	assertNoEffect(metadata, entry[0], "CLI entry");
});
