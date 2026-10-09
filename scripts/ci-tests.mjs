#!/usr/bin/env node
import { spawn } from "node:child_process";
import { appendFileSync, readdirSync } from "node:fs";
import { availableParallelism } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { stripVTControlCharacters } from "node:util";

const root = fileURLToPath(new URL("..", import.meta.url));

// The default gate protects installed behavior, protocols, persistence, and
// permissions. Directory membership alone does not make a test a release gate.
export const coreTests = [
	"acp-deferred-boot",
	"acp-dispatch-plan-approval",
	"acp-permission-options",
	"acp-prompt-slash-screen",
	"acp-session-branches",
	"acp-session-handoff",
	"acp-v1-basics",
	"acp-v1-sessions",
	"admission-fs-ops",
	"antigravity-subprocess",
	"ask-user-tool",
	"auth-oauth-refresh",
	"auth-storage-durability",
	"bash-cd-ln",
	"bash-exec-settlement",
	"bash-output-cap",
	"bash-timeout-diagnostic",
	"bootstrap-route",
	"builtin-runtime-boot-manifest",
	"claude-sdk-install",
	"cli-ignored-flags",
	"clio-command",
	"code-nav",
	"configure-experience",
	"configure-routing",
	"continuity-persistence",
	"continuity-replay-fork",
	"credential-present",
	"damage-control-git-words",
	"damage-control-literal-text",
	"damage-control-scan-args",
	"damage-control-shell-segments",
	"detect-chat-routes",
	"dispatch-admission",
	"dispatch-failure-classification",
	"dispatch-lifecycle",
	"dispatch-session-ownership",
	"doctor-unknown-runtime",
	"engine-lifecycle",
	"engine-transcript",
	"extension-resources",
	"gateway-authority",
	"gateway-loop-guard",
	"git-clean-dry-run",
	"git-force-with-lease",
	"git-single-path-restore",
	"headless-approval-prompt",
	"headless-autonomy-flag",
	"headless-dispatched-runs",
	"host-verification-admission",
	"install-script",
	"installed-package-ci",
	"instant-shell-import-graph",
	"launcher-guard",
	"lifecycle-cleanup",
	"lifecycle-safety",
	"mcp-config-trust",
	"mcp-stdio-client",
	"mutation-atomicity",
	"native-install-hardening",
	"panes-tool",
	"peer-default-readonly",
	"physical-dotdot",
	"project-settings-save",
	"prompt-skill-policy",
	"provider-content-filter",
	"provider-error-presentation",
	"provider-probe-lifecycle",
	"provider-transport",
	"read-only-validation",
	"read-scope",
	"release-boundary",
	"retired-settings-keys",
	"retired-settings-values",
	"run-script",
	"safe-exec-streaming",
	"safety-gates",
	"search-completeness",
	"session-durability",
	"session-integrity",
	"session-resume-route-e2e",
	"session-routing-scope",
	"settings-controls",
	"settings-target-wizard",
	"skill-install",
	"state-file-lock",
	"symlink-escape",
	"tool-boundaries",
	"transcript-operator-grant",
	"transcript-retry-prefix",
	"trust-gate",
	"turn-control-outcome",
	"turn-ending-contract",
	"turn-outcome-settlement",
	"update-check",
	"upgrade-command",
	"verify-numeric-boundaries",
	"verify-toolchain-checks",
	"windows-process-tree",
	"worker-boundary",
	"worker-grant-broker",
	"worker-permit",
	"worker-readonly-dispatch",
	"worker-refusal-limit",
	"worker-sandbox",
]
	.map((name) => `tests/contracts/${name}.test.ts`)
	.concat([
		"tests/extended/session-title-typed-input.test.ts",
		"tests/smoke/acp-boundary.test.ts",
		"tests/smoke/real-binary-boot.test.ts",
		"tests/smoke/process-lifecycle.test.ts",
		"tests/smoke/boot-handoff.test.ts",
	]);

export const guiTests = [
	"acp-tolerance",
	"auth-recovery",
	"background",
	"boundaries",
	"chat-approval",
	"chat-composer",
	"chat-turns",
	"cli-runner",
	"contracts",
	"egress-policy",
	"event-hub",
	"gateway-acp",
	"gui-uninstall",
	"idle-exit",
	"kill-parent",
	"launcher-linux",
	"launcher-windows",
	"openapi",
	"process-policy",
	"pwa",
	"session-controls",
	"sessions-http",
	"settings-controls-http",
	"settings-drafts",
	"targets-http",
	"worker-rpc",
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
	const preload = gui ? "./tests/harness/no-network.ts" : "./tests/harness/tmp-root.ts";
	const child = spawn(
		process.execPath,
		[
			"--import",
			"tsx",
			"--import",
			preload,
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
				console.log(`\n${tier}: default qualification\n${selected.join("\n")}`);
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
