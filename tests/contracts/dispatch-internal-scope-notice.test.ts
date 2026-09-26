import { deepStrictEqual, ok, rejects, strictEqual } from "node:assert/strict";
import { it } from "node:test";
import { BusChannels } from "../../src/core/bus-events.js";
import { installDiagnosticSink } from "../../src/core/diagnostics.js";
import { declaredScopeIntent } from "../../src/domains/dispatch/intent.js";
import { declaredScopeReplacementDiagnostic, resolveDispatchPathScope } from "../../src/domains/dispatch/path-scope.js";
import { makeDispatchBundle } from "../harness/dispatch.js";
import { dispatchStubContext } from "../harness/dispatch-stub-context.js";
import { isolateClioEnv } from "../harness/scratch-env.js";

it("operator bootstrap report: internal schema retries keep scope provenance without transcript warnings", async () => {
	const env = await isolateClioEnv("internal-scope-notice-");
	const context = dispatchStubContext();
	const notices: unknown[] = [];
	const diagnostics: string[] = [];
	const removeSink = installDiagnosticSink((text) => diagnostics.push(text));
	const unsubscribe = context.bus.on(BusChannels.DispatchScopeNotice, (notice) => {
		notices.push(notice);
	});
	const bundle = makeDispatchBundle(context);
	try {
		await bundle.extension.start();
		const scope = declaredScopeIntent({ readRoots: ["."] });
		ok(scope.ok);
		const request = {
			agentId: "context-bootstrap",
			executionRole: "researcher" as const,
			task: "Inspect CLIO-CODER.md CLAUDE.md src/engine/types.ts and tests/contracts/bootstrap-route.test.ts.",
			cwd: env.dir,
			intent: scope.intent,
			responseSchema: { type: "object" },
		};
		for (let attempt = 0; attempt < 2; attempt++)
			await rejects(
				bundle.contract.dispatch({
					...request,
					requestOrigin: "internal",
					lineage: { rootRunId: "bootstrap-root", parentRunId: null, attempt, depth: 0 },
				}),
				/responseSchema/,
			);
		strictEqual(diagnostics.filter((text) => text.includes("typed scope replacement")).length, 1);
		strictEqual(
			notices.length,
			0,
			"harness-owned native-schema attempts must not repeat the generated prompt's path list in the transcript",
		);
		const resolved = resolveDispatchPathScope(request);
		deepStrictEqual(resolved.workingContextPaths, []);
		deepStrictEqual(resolved.writeBoundaries, []);
		ok(declaredScopeReplacementDiagnostic(resolved)?.includes("src/engine/types.ts"), "the diagnostic remains available");
		ok(resolved.inferredOnlyPaths.includes("CLIO-CODER.md"), "omissions remain recorded without expanding authority");
		for (const requestOrigin of ["user", "agent"] as const)
			await rejects(bundle.contract.dispatch({ ...request, agentId: "coder", requestOrigin }), /responseSchema/);
		strictEqual(notices.length, 2, "ordinary dispatches retain their scope warnings");
		for (const requestOrigin of ["user", "agent"] as const) {
			await rejects(
				bundle.contract.dispatch({
					...request,
					agentId: "coder",
					requestOrigin,
					lineage: { rootRunId: `retry-${requestOrigin}`, parentRunId: null, attempt: 1, depth: 0 },
				}),
				/responseSchema/,
			);
		}
		strictEqual(notices.length, 2, "retries never repeat transcript scope warnings");
		strictEqual(
			diagnostics.filter((text) => text.includes("typed scope replacement")).length,
			3,
			"retries never repeat diagnostics",
		);
	} finally {
		unsubscribe();
		removeSink();
		await bundle.extension.stop?.();
		env.restore();
	}
});
