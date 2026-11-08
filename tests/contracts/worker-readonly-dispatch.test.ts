import { match, ok, rejects, strictEqual, throws } from "node:assert/strict";
import { test } from "node:test";
import { Type } from "typebox";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import { ToolNames } from "../../src/core/tool-names.js";
import { buildDynamicPromptMessages } from "../../src/domains/dispatch/extension.js";
import type { SpawnedWorker } from "../../src/domains/dispatch/worker-spawn.js";
import { startClaudeSdkWorkerRun } from "../../src/engine/claude/sdk-runtime.js";
import type { WorkerRunInput } from "../../src/engine/worker-runtime.js";
import { createWorkerSafety } from "../../src/engine/worker-tools.js";
import { createRegistry } from "../../src/tools/registry.js";
import { workerPermitDigest } from "../../src/worker/protocol.js";
import { parseWorkerSpec, WORKER_SPEC_HOOKLESS_VERSION, type WorkerSpec } from "../../src/worker/spec-contract.js";
import { makeDispatchBundle } from "../harness/dispatch.js";
import { dispatchStubContext } from "../harness/dispatch-stub-context.js";
import { isolateClioEnv } from "../harness/scratch-env.js";

test("a yolo session dispatches a default worker as version 8 and rejects a wire version it does not read", async () => {
	const env = await isolateClioEnv("clio-default-worker-");
	const settings = structuredClone(DEFAULT_SETTINGS);
	settings.safety.autonomy = "yolo";
	let started = false;
	const bundle = makeDispatchBundle(dispatchStubContext({ settings }), {
		spawnWorker(spec) {
			started = true;
			strictEqual("autonomy" in spec, false);
			strictEqual(spec.readOnly, undefined);
			strictEqual(parseWorkerSpec(spec).readOnly, undefined);
			// A spec without extension hooks stays version 8, so a node one release behind still serves it.
			strictEqual(spec.specVersion, WORKER_SPEC_HOOKLESS_VERSION);
			throws(
				() => parseWorkerSpec({ ...spec, specVersion: WORKER_SPEC_HOOKLESS_VERSION - 1 }),
				/is not one this worker reads .*different Clio Coder builds/u,
			);
			throw new Error("worker spec observed");
		},
	});
	try {
		await bundle.extension.start();
		await rejects(
			bundle.contract.dispatch({ agentId: "coder", task: "Inspect the task", executionRole: "builder", cwd: env.dir }),
			/worker spec observed/u,
		);
		ok(started);
		const registry = createRegistry({ safety: createWorkerSafety({ cwd: env.dir }), autonomy: () => "default" });
		registry.register({
			name: ToolNames.Bash,
			description: "contract command",
			parameters: Type.Object({}),
			baseActionClass: "execute",
			run: async () => ({ kind: "ok", output: "ran" }),
		});
		let asked = false;
		registry.onPermissionRequired((_call, _decision, meta) => {
			asked = true;
			registry.cancelParkedCall(meta.requestId, "contract denial");
		});
		const verdict = await registry.invoke({ tool: ToolNames.Bash, args: { command: "unrecognized-contract-command" } });
		strictEqual(asked, true);
		strictEqual(verdict.kind, "blocked");
	} finally {
		await bundle.extension.stop?.();
		env.restore();
	}
});

/** The worker allowance dispatch seals when the operator's live autonomy is `operatorAutonomy`, settings.yaml at unconfined yolo. */
async function allowanceUnderYoloSettings(prefix: string, operatorAutonomy?: () => "default" | "yolo") {
	const env = await isolateClioEnv(prefix);
	const settings = structuredClone(DEFAULT_SETTINGS);
	settings.safety.autonomy = "yolo";
	settings.safety.yoloConfinement = "unconfined";
	settings.safety.yoloUnconfinedAccepted = true;
	let captured: WorkerSpec | undefined;
	const bundle = makeDispatchBundle(dispatchStubContext({ settings }), {
		...(operatorAutonomy !== undefined ? { operatorAutonomy } : {}),
		spawnWorker(spec) {
			captured = spec;
			throw new Error("worker spec observed");
		},
	});
	try {
		await bundle.extension.start();
		await rejects(
			bundle.contract.dispatch({ agentId: "coder", task: "Inspect the task", executionRole: "builder", cwd: env.dir }),
			/worker spec observed/u,
		);
		ok(captured);
		return captured.permit.allowance;
	} finally {
		await bundle.extension.stop?.();
		env.restore();
	}
}

test("a dispatcher no one granted yolo never seals a yolo worker, whatever settings.yaml says", async () => {
	// A headless fleet, bootstrap or wiki run has no live operator level; the settings file is not a grant.
	strictEqual((await allowanceUnderYoloSettings("clio-ceiling-none-")).executeAutonomy, undefined);
	strictEqual((await allowanceUnderYoloSettings("clio-ceiling-default-", () => "default")).executeAutonomy, undefined);
	// The live level is the ceiling: a granted unconfined yolo operator still passes it on.
	strictEqual((await allowanceUnderYoloSettings("clio-ceiling-yolo-", () => "yolo")).executeAutonomy, "yolo");
});

test("an attempt queued for capacity launches at the dispatcher's live level, not the one it was admitted under", async () => {
	const env = await isolateClioEnv("clio-ceiling-queued-");
	const settings = structuredClone(DEFAULT_SETTINGS);
	settings.safety.autonomy = "yolo";
	settings.safety.yoloConfinement = "unconfined";
	settings.safety.yoloUnconfinedAccepted = true;
	let live: "default" | "yolo" = "yolo";
	const specs: WorkerSpec[] = [];
	let releaseFirst = (): void => {};
	const firstHeld = new Promise<void>((resolve) => {
		releaseFirst = resolve;
	});
	const scheduling = { maxWorkers: () => 1 };
	const bundle = makeDispatchBundle(dispatchStubContext({ settings, scheduling }), {
		operatorAutonomy: () => live,
		spawnWorker: (spec): SpawnedWorker => {
			specs.push(spec);
			const hold = specs.length === 1 ? firstHeld : Promise.resolve();
			return {
				pid: null,
				promise: hold.then(() => ({ exitCode: 0, signal: null })),
				heartbeatAt: { current: Date.now(), monotonic: 0 },
				events: (async function* () {
					await hold;
					yield { type: "message_end", message: { role: "assistant", stopReason: "stop", content: "done" } };
				})(),
				abort() {},
			};
		},
	});
	try {
		await bundle.extension.start();
		const request = { agentId: "coder", task: "Inspect the task", executionRole: "builder" as const, cwd: env.dir };
		const first = await bundle.contract.dispatch(request);
		const queued = bundle.contract.dispatch(request);
		await new Promise((resolve) => setTimeout(resolve, 200));
		strictEqual(specs.length, 1, "the second attempt waits for the only slot");
		live = "default";
		releaseFirst();
		await first.finalPromise;
		const second = await queued;
		const receipt = await second.finalPromise;
		strictEqual(specs[0]?.permit.allowance.executeAutonomy, "yolo");
		const narrowed = specs[1];
		ok(narrowed);
		strictEqual(narrowed.permit.allowance.executeAutonomy, undefined);
		strictEqual(parseWorkerSpec(JSON.parse(JSON.stringify(narrowed))).permit.digest, narrowed.permit.digest);
		strictEqual(receipt.safety?.permit?.executeAutonomy, undefined);
		strictEqual(receipt.safety?.permit?.digest, narrowed.permit.digest);
	} finally {
		await bundle.extension.stop?.();
		env.restore();
	}
});

/**
 * Dispatches one unconfined-yolo attempt whose launch preparation (opening the owner's telemetry session) runs
 * `duringPrep` with setters for the dispatcher's live level and its current settings, and returns the spawned spec
 * and the receipt.
 */
async function dispatchAcrossLaunchPrep(
	prefix: string,
	duringPrep: (change: { level(next: "default" | "yolo"): void; settings(next: typeof DEFAULT_SETTINGS): void }) => void,
) {
	const env = await isolateClioEnv(prefix);
	const settings = structuredClone(DEFAULT_SETTINGS);
	settings.safety.autonomy = "yolo";
	settings.safety.yoloConfinement = "unconfined";
	settings.safety.yoloUnconfinedAccepted = true;
	let current = settings;
	let live: "default" | "yolo" = "yolo";
	let prepared = false;
	const stub = dispatchStubContext({ settings });
	const telemetry = {
		acquireTelemetrySession: async () => {
			duringPrep({
				level: (next) => {
					live = next;
				},
				settings: (next) => {
					current = next;
				},
			});
			await new Promise((resolve) => setTimeout(resolve, 20));
			prepared = true;
			return undefined;
		},
	};
	const getContract = ((name: string) =>
		name === "telemetry" ? telemetry : stub.getContract(name as never)) as typeof stub.getContract;
	const specs: WorkerSpec[] = [];
	const bundle = makeDispatchBundle(
		{ ...stub, getContract },
		{
			operatorAutonomy: () => live,
			getSettings: () => current,
			spawnWorker: (spec): SpawnedWorker => {
				specs.push(spec);
				return {
					pid: null,
					promise: Promise.resolve({ exitCode: 0, signal: null }),
					heartbeatAt: { current: Date.now(), monotonic: 0 },
					events: (async function* () {
						yield { type: "message_end", message: { role: "assistant", stopReason: "stop", content: "done" } };
					})(),
					abort() {},
				};
			},
		},
	);
	try {
		await bundle.extension.start();
		const handle = await bundle.contract.dispatch({
			agentId: "coder",
			task: "Inspect the task",
			executionRole: "builder",
			cwd: env.dir,
			ownerSessionId: "owner-session",
			ownerSessionCwdHash: "owner-cwd",
		});
		const receipt = await handle.finalPromise;
		ok(prepared, "the dispatcher changed inside launch preparation");
		const spec = specs[0];
		ok(spec);
		strictEqual(parseWorkerSpec(JSON.parse(JSON.stringify(spec))).permit.digest, spec.permit.digest);
		strictEqual(receipt.safety?.permit?.digest, spec.permit.digest);
		return { spec, receipt };
	} finally {
		await bundle.extension.stop?.();
		env.restore();
	}
}

test("a dispatcher that leaves unconfined yolo during launch preparation spawns its worker without the yolo grant", async () => {
	const dropped = await dispatchAcrossLaunchPrep("clio-ceiling-prep-level-", (change) => change.level("default"));
	strictEqual(dropped.spec.permit.allowance.executeAutonomy, undefined);
	strictEqual(dropped.receipt.safety?.permit?.executeAutonomy, undefined);
	// Still yolo, but now contained: contained yolo admits as default and grants no worker yolo.
	const contained = await dispatchAcrossLaunchPrep("clio-ceiling-prep-confinement-", (change) => {
		const next = structuredClone(DEFAULT_SETTINGS);
		next.safety.autonomy = "yolo";
		next.safety.yoloConfinement = "contained";
		change.settings(next);
	});
	strictEqual(contained.spec.permit.allowance.executeAutonomy, undefined);
	strictEqual(contained.receipt.safety?.permit?.executeAutonomy, undefined);
	// Nothing changed: the grant stands.
	const kept = await dispatchAcrossLaunchPrep("clio-ceiling-prep-kept-", () => {});
	strictEqual(kept.spec.permit.allowance.executeAutonomy, "yolo");
	strictEqual(kept.receipt.safety?.permit?.executeAutonomy, "yolo");
});

/** The JSON document production dispatch writes for a default coder run. */
async function sealedCoderSpec(prefix: string) {
	const env = await isolateClioEnv(prefix);
	let captured: WorkerSpec | undefined;
	const bundle = makeDispatchBundle(dispatchStubContext(), {
		spawnWorker(spec) {
			captured = spec;
			throw new Error("worker spec observed");
		},
	});
	try {
		await bundle.extension.start();
		await rejects(
			bundle.contract.dispatch({ agentId: "coder", task: "Inspect the task", executionRole: "builder", cwd: env.dir }),
			/worker spec observed/u,
		);
		ok(captured);
		return JSON.parse(JSON.stringify(captured));
	} finally {
		await bundle.extension.stop?.();
		env.restore();
	}
}

test("a worker refuses a permit or tool surface edited after the host sealed it", async () => {
	const sealed = await sealedCoderSpec("clio-permit-seal-");
	strictEqual(parseWorkerSpec(structuredClone(sealed)).permit.digest, sealed.permit.digest);
	const widened = structuredClone(sealed);
	widened.permit.ceiling.tools = [...widened.permit.ceiling.tools, ToolNames.Dispatch].sort();
	throws(() => parseWorkerSpec(widened), /WorkerSpec\.permit\.digest does not match the permit/u);
	const outside = structuredClone(sealed);
	outside.allowedTools = [...outside.allowedTools, ToolNames.Dispatch];
	throws(() => parseWorkerSpec(outside), /WorkerSpec\.allowedTools exceed the permit ceiling: dispatch/u);
});

test("escalate is refused, never downgraded, where the runtime cannot park a call", async () => {
	const parked = await sealedCoderSpec("clio-permit-escalate-");
	parked.onPermission = "escalate";
	parked.permit.allowance = { ...parked.permit.allowance, asks: "main", approvalAuthority: "operator" };
	parked.permit.digest = workerPermitDigest(parked.permit);
	strictEqual(parseWorkerSpec(structuredClone(parked)).onPermission, "escalate");
	parked.permit.ceiling.enforcement = { ...parked.permit.ceiling.enforcement, grantPauseResume: false };
	parked.permit.digest = workerPermitDigest(parked.permit);
	throws(() => parseWorkerSpec(parked), /escalate needs a runtime that can park a call/u);
	throws(
		() => startClaudeSdkWorkerRun({ onPermission: "escalate" } as unknown as WorkerRunInput, () => {}),
		/escalate is unsupported on the Claude SDK runtime/u,
	);
});

test("read-only admission denies mutation, steering, and outside reads without parking, and admits a dispatch", async () => {
	const env = await isolateClioEnv("clio-readonly-registry-");
	try {
		const registry = createRegistry({ safety: createWorkerSafety({ cwd: env.dir }), readOnly: true });
		let parked = false;
		registry.onPermissionRequired(() => {
			parked = true;
		});
		for (const [tool, args, action] of [
			[ToolNames.Write, { path: "change.txt", content: "change" }, "write"],
			[ToolNames.Bash, { command: "git status" }, "execute"],
			[ToolNames.Steer, { run_id: "r1", message: "change" }, "dispatch"],
			[ToolNames.Read, { path: "/etc/hosts" }, "read"],
		] as const) {
			registry.register({
				name: tool,
				description: "contract tool",
				parameters: Type.Object({}),
				baseActionClass: action,
				run: async () => ({ kind: "ok", output: "ran" }),
			});
			const verdict = await registry.invoke({ tool, args });
			strictEqual(verdict.kind, "blocked", tool);
			if (verdict.kind === "blocked") {
				match(verdict.reason, /this run is read-only/u);
				strictEqual(
					/autonomy|\/settings/u.test(JSON.stringify("rejection" in verdict.decision ? verdict.decision.rejection : {})),
					false,
				);
			}
		}
		strictEqual(parked, false);
		// The dispatched worker inherits read-only, so the dispatch itself passes.
		registry.register({
			name: ToolNames.Dispatch,
			description: "contract dispatch",
			parameters: Type.Object({}),
			baseActionClass: "dispatch",
			run: async () => ({ kind: "ok", output: "dispatched" }),
		});
		strictEqual(
			(await registry.invoke({ tool: ToolNames.Dispatch, args: { agentId: "coder", task: "look" } })).kind,
			"ok",
		);
		const read = await registry.invoke({ tool: ToolNames.Read, args: { path: "inside.txt" } });
		strictEqual(read.kind, "ok");
		registry.register({
			name: ToolNames.Context,
			description: "contract context",
			parameters: Type.Object({}),
			baseActionClass: "read",
			run: async () => ({ kind: "ok", output: "skill activated" }),
		});
		// Loading a skill reads it and can only narrow the surface, so read-only admits it.
		const skill = await registry.invoke({ tool: ToolNames.Context, args: { scope: "skills", name: "example" } });
		strictEqual(skill.kind, "ok");
		strictEqual(parked, false);
	} finally {
		env.restore();
	}
});

test("an ACP read-only worker receives the default posture and its run restriction", () => {
	const messages = buildDynamicPromptMessages(
		{ agentId: "peer", task: "Inspect the change", executionRole: "reviewer", readOnly: true },
		{ autonomy: "default", readOnly: true },
	);
	match(messages.find(({ id }) => id === "dispatch-safety-posture")?.body ?? "", /autonomy default/u);
	match(messages.find(({ id }) => id === "dispatch-read-only")?.body ?? "", /inspection inside the workspace/u);
});
