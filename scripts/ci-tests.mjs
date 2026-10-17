#!/usr/bin/env node
import { spawn } from "node:child_process";
import { appendFileSync, readdirSync } from "node:fs";
import { availableParallelism } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { stripVTControlCharacters } from "node:util";

const root = fileURLToPath(new URL("..", import.meta.url));

// Keep the development gate small and source-only. Package, platform and
// historical regressions stay available through their explicit commands.
export const coreTests = [
	"auth-storage-durability",
	"bash-exec-settlement",
	"bash-output-cap",
	"damage-control-shell-segments",
	"dispatch-session-ownership",
	"gateway-authority",
	"mutation-atomicity",
	"physical-dotdot",
	"read-scope",
	"session-durability",
	"state-file-lock",
	"symlink-escape",
	"turn-outcome-settlement",
	"worker-grant-broker",
	"worker-permit",
	"worker-refusal-limit",
	"job-tool",
	"acp-v1-basics",
	"configure-routing",
	"mcp-config-trust",
].map((name) => `tests/contracts/${name}.test.ts`);

export const guiTests = [
	"chat-composer",
	"chat-approval",
	"chat-turns",
	"egress-policy",
	"sessions-http",
	"app-state",
].map((name) => `tests/${name}.test.ts`);

export const packageTests = ["tests/smoke/installed-package.test.ts", "tests/smoke/native-call-timing.test.ts"];

// Qualification runs the core, GUI and package tiers at once. Core at four
// (da71294f7) was measured alone on 24 CPUs; on a 4-vCPU hosted runner the
// combined eight test processes pushed timing-bound ACP, idle-exit and RPC
// deadline tests past their limits in ci (22), so small hosts keep two.
const coreConcurrency = availableParallelism() >= 8 ? 4 : 2;

export async function runTests(tier) {
	const gui = tier === "gui";
	const cwd = gui ? join(root, "apps/clio-coder-gui") : root;
	const files = { core: coreTests, gui: guiTests, package: packageTests }[tier];
	if (!files) throw new Error(`Unknown test tier: ${tier}`);
	const preloads = [join(root, "tests/harness/tmp-root.ts"), ...(gui ? ["./tests/harness/no-network.ts"] : [])];
	const child = spawn(
		process.execPath,
		[
			"--import",
			"tsx",
			...preloads.flatMap((preload) => ["--import", preload]),
			"--test",
			"--test-reporter=spec",
			`--test-concurrency=${tier === "core" ? coreConcurrency : 2}`,
			...files,
		],
		{ cwd, stdio: ["inherit", "pipe", "pipe"] },
	);
	let transcript = "";
	for (const stream of [child.stdout, child.stderr])
		stream.on("data", (chunk) => {
			transcript += chunk;
			(stream === child.stdout ? process.stdout : process.stderr).write(chunk);
		});
	const code = await new Promise((resolve, reject) => {
		child.once("error", reject);
		child.once("close", (status) => resolve(status ?? 1));
	});
	const plain = stripVTControlCharacters(transcript);
	const count = Number(/(?:ℹ|#) tests (\d+)/u.exec(plain)?.[1]);
	if (!Number.isSafeInteger(count) || count < 1) throw new Error(`Missing ${tier} test count`);
	if (process.env.CLIO_CODER_TEST_SUMMARY)
		appendFileSync(
			process.env.CLIO_CODER_TEST_SUMMARY,
			`${JSON.stringify({ tier, tests: count, passed: code === 0, files: files.length })}\n`,
		);
	if (code !== 0) throw new Error(`${tier} tests failed (exit ${code})`);
	return count;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	try {
		if (process.argv[2] === "list") {
			for (const [tier, dir, selected] of [
				["core", "tests/contracts", coreTests],
				["gui", "apps/clio-coder-gui/tests", guiTests.map((path) => `apps/clio-coder-gui/${path}`)],
			]) {
				console.log(`\n${tier}: default behavior checks\n${selected.join("\n")}`);
				const omitted = readdirSync(join(root, dir))
					.filter((name) => /\.test\.tsx?$/u.test(name))
					.map((name) => `${dir}/${name}`)
					.filter((name) => !selected.includes(name));
				console.log(`\n${tier}: full investigation only\n${omitted.join("\n")}`);
			}
		} else await runTests(process.argv[2]);
	} catch (error) {
		console.error(`ci-tests: ${error.message}`);
		process.exitCode = 1;
	}
}
