import { ok, strictEqual } from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { runBoundedParent } from "../harness/bounded-worker.js";
import { startOpenAICompatFixture } from "../harness/openai-compat-fixture.js";
import { scratchClioEnvVars } from "../harness/scratch-env.js";
import { fixtureSettingsFingerprint } from "../harness/worker-attestation.js";

const REPO_ROOT = new URL("../..", import.meta.url).pathname;
const CLI_ENTRY = join(REPO_ROOT, "dist", "cli", "index.js");
const OUTER_DEADLINE_MS = 120_000;

/**
 * #148: the real built worker entry (`dist/worker/entry.js`) must consume the
 * Clio-injected NODE_COMPILE_CACHE / CLIO_CODER_INJECTED_COMPILE_CACHE pair
 * before any application-triggered descendant can be spawned. The narrower
 * contracts prove the injected pair at the spawn boundary, the consumption
 * helper, and the direct-handler environment; this smoke drives the real
 * worker graph through one stubbed inference turn whose single tool call is a
 * real bash descendant that itself launches a generic Node child, and asserts
 * what each actually inherited. Hermetic: the model is a loopback
 * OpenAI-compat fixture, no live provider or network is reached, and every
 * process is bounded and group-reaped by the shared bounded-worker harness.
 */

interface EnvObservation {
	cache: string | null;
	marker: string | null;
}

/**
 * One bash tool call that records the shell's own view of the two variables
 * (distinguishing unset from empty via the `${VAR-…}` default) and then
 * spawns a generic Node child that records its view. The shell and the Node
 * child are two independent descendant spawn paths off the worker's live
 * process.env, which is the same environment middleware hooks and external
 * runtime subprocesses copy.
 */
function observationCommand(shellObs: string, nodeObs: string): string {
	const nodeCode =
		'require("node:fs").writeFileSync(process.argv[1],JSON.stringify({cache:process.env.NODE_COMPILE_CACHE??null,marker:process.env.CLIO_CODER_INJECTED_COMPILE_CACHE??null}))';
	return [
		`printf 'cache=%s\\nmarker=%s\\n' "\${NODE_COMPILE_CACHE-__unset__}" "\${CLIO_CODER_INJECTED_COMPILE_CACHE-__unset__}" > ${shellObs}`,
		`node -e '${nodeCode}' ${nodeObs}`,
	].join(" && ");
}

function readShellObservation(path: string): EnvObservation {
	ok(existsSync(path), `the bash descendant ran and recorded its environment at ${path}`);
	const lines = Object.fromEntries(
		readFileSync(path, "utf8")
			.trim()
			.split("\n")
			.map((line) => {
				const eq = line.indexOf("=");
				return [line.slice(0, eq), line.slice(eq + 1)];
			}),
	) as Record<string, string>;
	return {
		cache: lines.cache === "__unset__" ? null : (lines.cache ?? null),
		marker: lines.marker === "__unset__" ? null : (lines.marker ?? null),
	};
}

function readNodeObservation(path: string): EnvObservation {
	ok(existsSync(path), `the generic Node descendant ran and recorded its environment at ${path}`);
	return JSON.parse(readFileSync(path, "utf8")) as EnvObservation;
}

/** A complete, valid v3 WorkerSpec against the loopback fixture. */
function workerSpec(fixtureUrl: string): Record<string, unknown> {
	return {
		specVersion: 3,
		settingsFingerprint: fixtureSettingsFingerprint(),
		systemPrompt: "You are a test worker. Run the command you are asked to run.",
		agentId: "coder",
		task: "Run the observation command with the bash tool, then reply done.",
		target: {
			id: "mock-fleet",
			runtime: "openai-compat",
			url: fixtureUrl,
			defaultModel: "mock-model",
			wireModels: ["mock-model"],
		},
		runtime: { version: 2, id: "openai-compat", kind: "http", apiFamily: "openai-completions", auth: "api-key" },
		runtimeId: "openai-compat",
		wireModelId: "mock-model",
		apiKey: "clio-test-key",
		modelCapabilities: { tools: true },
		allowedTools: ["bash"],
		autonomy: "full-auto",
		onPermission: "deny",
		budget: { toolCalls: 2, readReserve: 0, synthesis: true, hardCap: 3 },
	};
}

describe("smoke/compile cache reaches the real worker graph but never its descendants (#148)", () => {
	it("local spawn: the built entry consumes the injected pair before bash and Node descendants spawn", async () => {
		const scratch = mkdtempSync(join(tmpdir(), "clio-cc-desc-local-"));
		const shellObs = join(scratch, "shell-env.txt");
		const nodeObs = join(scratch, "node-env.json");
		const command = observationCommand(shellObs, nodeObs);
		const fixture = await startOpenAICompatFixture("done", {
			toolCall: { name: "bash", arguments: { command } },
		});
		try {
			const homeEnv = scratchClioEnvVars(scratch, { requireHomePrefix: true });
			// Initialized install: the cache root exists, so the spawn boundary
			// enables the cache and injects the pair for the worker's bootstrap.
			mkdirSync(join(scratch, "cache"), { recursive: true });

			const specFile = join(scratch, "spec.json");
			writeFileSync(specFile, JSON.stringify(workerSpec(fixture.url)), "utf8");
			const workerPidFile = join(scratch, "worker.pid");
			const parentScript = join(scratch, "parent.mts");
			writeFileSync(
				parentScript,
				`import { readFileSync, writeFileSync } from "node:fs";
import { spawnNativeWorker } from ${JSON.stringify(join(REPO_ROOT, "src/domains/dispatch/worker-spawn.ts"))};

const spec = JSON.parse(readFileSync(${JSON.stringify(specFile)}, "utf8"));
// No workerEntryPath override: the default resolves to the package's real
// built dist/worker/entry.js, which is the graph under test.
const worker = spawnNativeWorker(spec, { cwd: ${JSON.stringify(scratch)} });
if (worker.pid !== null) {
	writeFileSync(${JSON.stringify(workerPidFile)}, String(worker.pid));
	console.error("WORKER_PID=" + worker.pid);
}
const deadline = setTimeout(() => {
	process.exitCode = 1;
	console.error("worker did not settle within the deadline; aborting");
	worker.abort();
}, 90_000);
try {
	for await (const event of worker.events) {
		const type = (event as { type?: string }).type ?? "unknown";
		console.error("EVENT " + type);
	}
	await worker.promise;
} catch (error) {
	process.exitCode = 1;
	console.error(error);
} finally {
	clearTimeout(deadline);
}
`,
				"utf8",
			);

			const result = await runBoundedParent(process.execPath, ["--import", "tsx", parentScript], {
				cwd: REPO_ROOT,
				env: {
					...process.env,
					...homeEnv,
					NODE_COMPILE_CACHE: undefined,
					NODE_DISABLE_COMPILE_CACHE: undefined,
					CLIO_CODER_INJECTED_COMPILE_CACHE: undefined,
				},
				outerDeadlineMs: OUTER_DEADLINE_MS,
				workerPidFile,
			});
			strictEqual(result.code, 0, result.stderr);
			ok(result.workerPid !== null, `the parent published the worker pid: ${result.stderr}`);

			// The pair was available to Node bootstrap for the real worker graph:
			// the injected directory holds compiled bytecode after the run.
			const cacheDir = join(scratch, "cache", "v8-compile-cache");
			ok(existsSync(cacheDir), `the injected cache directory exists: ${result.stderr}`);
			ok(readdirSync(cacheDir).length > 0, "the real worker graph compiled through the injected cache");

			// The entry consumed the pair before the run could spawn anything:
			// neither descendant saw the cache directory or the marker.
			const shell = readShellObservation(shellObs);
			strictEqual(shell.cache, null, "the bash descendant inherited no NODE_COMPILE_CACHE");
			strictEqual(shell.marker, null, "the bash descendant inherited no provenance marker");
			const node = readNodeObservation(nodeObs);
			strictEqual(node.cache, null, "the generic Node child inherited no NODE_COMPILE_CACHE");
			strictEqual(node.marker, null, "the generic Node child inherited no provenance marker");
		} finally {
			await new Promise<void>((resolve) => fixture.server.close(() => resolve()));
			rmSync(scratch, { recursive: true, force: true });
		}
	});

	for (const [label, spoofedMarker] of [
		["a matching spoofed marker", (operatorDir: string): string => operatorDir],
		["a mismatched spoofed marker", (): string => "/nonexistent/spoofed-cache"],
	] as const) {
		it(`direct \`clio-coder worker\`: an operator cache survives ${label} and reaches descendants`, async () => {
			const scratch = mkdtempSync(join(tmpdir(), "clio-cc-desc-direct-"));
			const shellObs = join(scratch, "shell-env.txt");
			const nodeObs = join(scratch, "node-env.json");
			const command = observationCommand(shellObs, nodeObs);
			const fixture = await startOpenAICompatFixture("done", {
				toolCall: { name: "bash", arguments: { command } },
			});
			try {
				const homeEnv = scratchClioEnvVars(scratch, { requireHomePrefix: true });
				const operatorDir = join(scratch, "operator-cache");
				const spec = JSON.stringify(workerSpec(fixture.url));

				// The SSH/direct path: no local spawn boundary injected anything, so
				// any marker present is foreign. The subcommand must strip it, keep
				// the operator's NODE_COMPILE_CACHE intact for this process and every
				// descendant, and never let the entry's consume delete it.
				const result = await runBoundedParent(process.execPath, [CLI_ENTRY, "worker"], {
					cwd: scratch,
					env: {
						...process.env,
						...homeEnv,
						NODE_COMPILE_CACHE: operatorDir,
						NODE_DISABLE_COMPILE_CACHE: undefined,
						CLIO_CODER_INJECTED_COMPILE_CACHE: spoofedMarker(operatorDir),
					},
					outerDeadlineMs: OUTER_DEADLINE_MS,
					stdin: `${spec}\n`,
					parentIsWorker: true,
				});
				strictEqual(result.code, 0, result.stderr);

				const shell = readShellObservation(shellObs);
				strictEqual(shell.cache, operatorDir, "the operator's NODE_COMPILE_CACHE reached the bash descendant unchanged");
				strictEqual(shell.marker, null, "the foreign marker never reached the bash descendant");
				const node = readNodeObservation(nodeObs);
				strictEqual(node.cache, operatorDir, "the operator's NODE_COMPILE_CACHE reached the Node child unchanged");
				strictEqual(node.marker, null, "the foreign marker never reached the Node child");
				ok(existsSync(operatorDir), "the operator's directory is the one Node used for the worker graph");
			} finally {
				await new Promise<void>((resolve) => fixture.server.close(() => resolve()));
				rmSync(scratch, { recursive: true, force: true });
			}
		});
	}
});
