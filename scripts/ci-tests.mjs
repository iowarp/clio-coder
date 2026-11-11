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
	"check-lane-selection",
	"reload-prompts",
	"memory-off-marker",
	"headless-observed",
	"prompt-preconditions",
	"prompt-tier-golden",
	"memory-recall-hygiene",
	"memory-observation-envelope",
	"dispatch-memory-scope",
	"oracle-second-opinion",
	"verifiability-routing",
	"mux-private-host",
	"memory-route-redaction",
	"prior-session-hint",
	"auth-storage-durability",
	"bash-exec-settlement",
	"bash-output-cap",
	"damage-control-shell-segments",
	"damage-control-git-words",
	"internal-git-hooks",
	"safety-gates",
	"safety-gate-findings",
	"default-containment",
	"setup-status",
	"key-prefix",
	"configure-import",
	"setup-next",
	"contained-secrets",
	"true-yolo",
	"contained-yolo",
	"autonomy-window",
	"transcript-operator-grant",
	"yolo-script-sandbox",
	"verify-sandbox-trojan",
	"search-completeness",
	"tool-boundaries",
	"engine-utilities",
	"assistant-text-tool-order",
	"test-runner-vocabulary",
	"bootstrap-schema-retry-identity",
	"installed-package-ci",
	"release-boundary",
	"release-plan",
	"dispatch-session-ownership",
	"dispatch-prefix-stagger",
	"monitor-steer-tools",
	"gateway-authority",
	"mutation-atomicity",
	"open-browser",
	"physical-dotdot",
	"proxy-env-bypass",
	"read-scope",
	"session-durability",
	"project-settings-save",
	"state-file-lock",
	"symlink-escape",
	"turn-outcome-settlement",
	"worker-grant-broker",
	"worker-permit",
	"worker-refusal-limit",
	"job-tool",
	"judge-screen-park-surfaces",
	"acp-v1-basics",
	"configure-routing",
	"configure-clio-tool",
	"settings-authority",
	"settings-controls",
	"mcp-config-trust",
	"project-trust-card",
	"url-userinfo-hold",
	"url-credential-surfaces",
	"bootstrap-grounding",
	"in-prefix-summary",
	"compaction-exact-facts",
	"stale-edit-guard",
	"replay-unsent-call-usage",
	"overflow-compaction-fit",
	"compaction-summary-tool-results",
	"packed-source-directory",
	"eval-onboarding-rescore",
	"code-nav",
	"skill-frontmatter-cache",
	"codewiki-grammar-note",
	"read-only-user-files",
	"read-only-remedy",
	"sandbox-clio-roots",
	"fleet-run-history-prime",
	"codewiki-worker-identity",
	"telemetry-multi-install",
	"approval-card-arguments",
	"footer-snapshot",
	"quota-tui",
	"quota-poll-loop",
	"tui-presentation-modes",
	"copilot-sdk-route",
	"copilot-keychain",
	"retired-settings-keys",
	"doctor-unknown-runtime",
	"plugin-engine",
	"claims-ledger",
	"arena",
	"research-campaign",
	"cli-leaf-help",
	"mux-platform-win32",
	"keyboard-model",
	"background-surfaces",
	"completed-worker-presentation",
	"gateway-prompt",
	"host-verification-admission",
	"receipt-verify-latest-outcome",
	"verify-numeric",
	"verify-numeric-boundaries",
	"verify-reproduce",
	"verify-toolchain-checks",
	"verify-task-gates",
	"provider-error-presentation",
	"handbook-discovery",
	"report-share",
	"report-dataset",
	"census-ping",
	"typecheck-corpus",
	"anthropic-thread-idle",
]
	.map((name) => `tests/contracts/${name}.test.ts`)
	// Signature features whose guards live in the extended suite: the working
	// set, judged perf checks and sealed receipts under heartbeat contention.
	.concat(
		["working-set-core", "verify-perf", "dispatch-heartbeat-finalization"].map(
			(name) => `tests/extended/${name}.test.ts`,
		),
	)
	// The issue labeler runs on untrusted report bodies in GitHub Actions.
	.concat(".github/scripts/report-labels.test.mjs");

export const guiTests = [
	"report-dialog-model",
	"chat-composer",
	"chat-approval",
	"chat-interview",
	"chat-turns",
	"egress-policy",
	"sessions-http",
	"targets-http",
	"library-http",
	"file-preview",
	"app-state",
	"system-model",
	"telemetry-live",
	"ssh-model",
	"arena-model",
	"research-model",
	"research-http",
	"pages",
	"machine-proxy",
	"client-auth",
	"session-control",
	"openapi",
	"boundaries",
]
	.map((name) => `tests/${name}.test.ts`)
	.concat("tests/public-help.test.tsx", "tests/secondary-pages.test.tsx");

export const packageTests = [
	"tests/smoke/installed-package.test.ts",
	"tests/smoke/native-call-timing.test.ts",
	"tests/contracts/instant-shell-import-graph.test.ts",
	"tests/extended/dogfood-doctor-readonly.test.ts",
];

export const fullTests = ["contracts", "extended", "smoke", "extended-smoke"].flatMap((suite) =>
	readdirSync(join(root, "tests", suite))
		.filter((name) => name.endsWith(".test.ts"))
		.sort()
		.map((name) => `tests/${suite}/${name}`),
);

// Qualification runs the core, GUI and package tiers at once. Core at four
// (da71294f7) was measured alone on 24 CPUs; on a 4-vCPU hosted runner the
// combined eight test processes pushed timing-bound ACP, idle-exit and RPC
// deadline tests past their limits in ci (22), so small hosts keep two.
const rootConcurrency = availableParallelism() >= 8 ? 4 : 2;

export async function runTests(tier) {
	const gui = tier === "gui";
	const cwd = gui ? join(root, "apps/clio-coder-gui") : root;
	const files = { core: coreTests, gui: guiTests, package: packageTests, full: fullTests }[tier];
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
			`--test-concurrency=${tier === "core" || tier === "full" ? rootConcurrency : 2}`,
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
