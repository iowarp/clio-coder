import { match, ok, rejects, strictEqual, throws } from "node:assert/strict";
import { test } from "node:test";
import { Type } from "typebox";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import { ToolNames } from "../../src/core/tool-names.js";
import { buildDynamicPromptMessages } from "../../src/domains/dispatch/extension.js";
import { createWorkerSafety } from "../../src/engine/worker-tools.js";
import { createRegistry } from "../../src/tools/registry.js";
import { parseWorkerSpec, WORKER_SPEC_VERSION } from "../../src/worker/spec-contract.js";
import { makeDispatchBundle } from "../harness/dispatch.js";
import { dispatchStubContext } from "../harness/dispatch-stub-context.js";
import { isolateClioEnv } from "../harness/scratch-env.js";

test("a yolo session dispatches a default worker and rejects the previous worker wire version", async () => {
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
			throws(() => parseWorkerSpec({ ...spec, specVersion: WORKER_SPEC_VERSION - 1 }), /unsupported.*expected version/u);
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

test("read-only admission denies mutation, dispatch, and outside reads without parking", async () => {
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
			[ToolNames.Dispatch, { agentId: "coder", task: "change" }, "dispatch"],
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
		const read = await registry.invoke({ tool: ToolNames.Read, args: { path: "inside.txt" } });
		strictEqual(read.kind, "ok");
		registry.register({
			name: ToolNames.Context,
			description: "contract context",
			parameters: Type.Object({}),
			baseActionClass: "read",
			run: async () => ({ kind: "ok", output: "skill activated" }),
		});
		const skill = await registry.invoke({ tool: ToolNames.Context, args: { scope: "skills", name: "example" } });
		strictEqual(skill.kind, "blocked");
		if (skill.kind === "blocked") match(skill.reason, /this run is read-only/u);
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
