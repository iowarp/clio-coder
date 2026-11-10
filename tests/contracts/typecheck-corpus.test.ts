import { deepStrictEqual, match, notStrictEqual, ok, strictEqual } from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

// Conformance corpus for `pnpm run typecheck` (tsrs) against the reference
// `tsc`: small projects with injected errors under the options Clio relies on.
// expected.txt is tsc's output; refresh it after a paired compiler bump with
// TYPECHECK_CORPUS_WRITE=1 and review the diff. See "Typechecking" in CONTRIBUTING.md.
const root = fileURLToPath(new URL("../..", import.meta.url));
const corpus = join(root, "tests/fixtures/typecheck-corpus");
const expectedPath = join(corpus, "expected.txt");
const projects = ["node", "tsx", "declaration"];
const wrapper = join(root, "scripts/typecheck.mjs");

interface Toolchain {
	resolveTsc(): string;
	resolveTsrs(): Promise<{ path?: string; reason?: string }>;
	tsrsTypescriptVersion(): string;
}
const toolchain = (await import(wrapper)) as Toolchain;
const tsrs = await toolchain.resolveTsrs();
const tsrsSkip = tsrs.path ? false : `tsrs unavailable: ${tsrs.reason}`;

/** Diagnostic blocks (header plus indented message chain), path-normalized and sorted. */
function blocks(output: string): string[] {
	const result: string[] = [];
	for (const line of output.replaceAll(corpus, "<corpus>").replaceAll("\\", "/").split(/\r?\n/u)) {
		if (/^\S.*\berror TS\d+:/u.test(line)) result.push(line);
		else if (/^\s+\S/u.test(line) && result.length > 0) result[result.length - 1] += `\n${line}`;
	}
	return result.sort();
}

function check(command: string, args: string[], project: string, env: NodeJS.ProcessEnv = process.env) {
	const result = spawnSync(command, [...args, "-p", project, "--noEmit"], { cwd: corpus, encoding: "utf8", env });
	return { status: result.status, stderr: result.stderr, diagnostics: blocks(`${result.stdout}\n${result.stderr}`) };
}

function expected(): Record<string, string[]> {
	const sections: Record<string, string[]> = {};
	for (const section of readFileSync(expectedPath, "utf8").split(/^## /mu).slice(1)) {
		const [name = "", ...rest] = section.split("\n");
		sections[name.trim()] = blocks(rest.join("\n"));
	}
	return sections;
}

if (process.env.TYPECHECK_CORPUS_WRITE === "1") {
	const sections = projects.map((project) => {
		const { diagnostics } = check(process.execPath, [toolchain.resolveTsc(), "--pretty", "false"], project);
		return `## ${project}\n${diagnostics.join("\n")}\n`;
	});
	writeFileSync(expectedPath, `${sections.join("\n")}`);
}

describe("typecheck conformance corpus", () => {
	const golden = expected();
	const tsc = [toolchain.resolveTsc()];

	it("pairs tsrs with the reference tsc's TypeScript release", { skip: tsrsSkip }, () => {
		const version = spawnSync(process.execPath, [...tsc, "--version"], { encoding: "utf8" }).stdout.trim();
		strictEqual(version, `Version ${toolchain.tsrsTypescriptVersion()}`);
	});

	for (const project of projects) {
		it(`${project}: tsc reports the recorded diagnostics`, () => {
			const result = check(process.execPath, [...tsc, "--pretty", "false"], project);
			ok((golden[project]?.length ?? 0) > 0, `${project} injects errors`);
			deepStrictEqual(result.diagnostics, golden[project]);
			notStrictEqual(result.status, 0);
		});
		for (const mode of [[], ["--fast"]])
			it(`${project}: tsrs ${mode.join(" ") || "default mode"} matches tsc`, { skip: tsrsSkip }, () => {
				const result = check(tsrs.path ?? "", [...mode, "--pretty", "false"], project);
				deepStrictEqual(result.diagnostics, golden[project]);
				notStrictEqual(result.status, 0);
			});
		// Agents read piped output, where both compilers drop colors without being told to.
		it(`${project}: piped default output matches`, { skip: tsrsSkip }, () => {
			deepStrictEqual(check(tsrs.path ?? "", ["--fast"], project).diagnostics, golden[project]);
			deepStrictEqual(check(process.execPath, tsc, project).diagnostics, golden[project]);
		});
	}

	it("falls back to tsc visibly when tsrs is missing or crashes", () => {
		const scratch = mkdtempSync(join(tmpdir(), "typecheck-fallback-"));
		try {
			const crash = join(scratch, "tsrs");
			writeFileSync(crash, "#!/bin/sh\nkill -SEGV $$\n");
			chmodSync(crash, 0o755);
			const cases: [string, RegExp][] = [
				[join(scratch, "missing"), /because TSRS_BIN=.* does not exist/u],
				...(process.platform === "win32" ? [] : [[crash, /because tsrs crashed \(SIGSEGV\)/u] as [string, RegExp]]),
			];
			for (const [bin, reason] of cases) {
				const result = check(process.execPath, [wrapper, "--pretty", "false"], "node", { ...process.env, TSRS_BIN: bin });
				match(result.stderr, /typecheck: using tsc, the slower reference compiler,/u);
				match(result.stderr, reason);
				deepStrictEqual(result.diagnostics, golden.node);
				notStrictEqual(result.status, 0);
			}
		} finally {
			rmSync(scratch, { recursive: true, force: true });
		}
	});
});
