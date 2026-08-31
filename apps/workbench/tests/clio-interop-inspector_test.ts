import { equal, ok, rejects, throws } from "node:assert/strict";
import {
	ClioCliInteropInspector,
	ClioInteropInspectError,
	projectInteropInspection,
} from "../clio-interop-inspector.ts";

const FIXTURE = new URL("./interop-child-fixture.ts", import.meta.url).pathname;

Deno.test("the interop adapter invokes only the fixed detection read", async () => {
	const root = await Deno.makeTempDir({ prefix: "clio-coder-gui-interop-" });
	try {
		const inspector = new ClioCliInteropInspector({
			executable: Deno.execPath(),
			prefixArgs: ["run", "--quiet", "--no-config", FIXTURE, "--"],
			now: () => Date.parse("2026-08-31T15:02:00.000Z"),
		});
		const inspection = await inspector.inspect(root);
		equal(inspection.scope, "installation");
		equal(inspection.inspectedAt, "2026-08-31T15:02:00.000Z");
		equal(inspection.knownKinds, 8);
		equal(inspection.agents.length, 3);
		equal(inspection.agents[0]?.configured, true);
		equal(inspection.agents[1]?.decisionStale, true);
		equal(inspection.agents[1]?.proposed, true);
		// A kind with no ACP recipe reports no adapter at all.
		equal(inspection.agents[2]?.adapter, null);
		// Neither the resolved binary nor the agent's own directory crosses, and
		// neither does the fingerprint a decision is keyed by.
		const serialized = JSON.stringify(inspection);
		ok(!serialized.includes("/"));
		ok(!serialized.includes("sha256"));
	} finally {
		await Deno.remove(root, { recursive: true });
	}
});

Deno.test("interop projection refuses contradictions detection cannot produce", () => {
	const agent = {
		id: "claude-code",
		label: "Claude Code",
		presence: "present",
		version: "2.1.237",
		hasUserDirectory: true,
		acp: true,
		adapter: "absent",
		configured: false,
		decision: "declined",
		decidedAt: "2026-08-20T20:31:58.391Z",
		decisionStale: false,
		proposed: false,
		needsNetworkInstall: true,
	};
	const base = {
		version: 1,
		generatedAt: "2026-08-31T15:01:58.000Z",
		detectedAt: "2026-08-31T15:01:57.900Z",
		knownKinds: 8,
	};
	const project = (value: unknown) => projectInteropInspection({ ...base, agents: [value] }, base.generatedAt);
	equal(project(agent).agents[0]?.decision, "declined");

	// The resolved binary is exactly what this boundary keeps host-side.
	throws(() => project({ ...agent, binary: "/usr/local/bin/claude" }), /invalid detected-agent row/u);
	// Only a kind with an ACP recipe has an adapter to report on.
	throws(() => project({ ...agent, acp: false }), /adapter state that does not track its ACP recipe/u);
	// A decision and its stamp are written together.
	throws(() => project({ ...agent, decidedAt: null }), /decision stamp without the decision/u);
	throws(
		() => project({ ...agent, decision: null, decidedAt: null, decisionStale: true }),
		/called a decision stale that was never taken/u,
	);
	// Clio Coder offers only an installed ACP peer that is not already wired.
	throws(() => project({ ...agent, configured: true, proposed: true }), /proposal it does not qualify for/u);
	throws(() => project({ ...agent, presence: "absent", proposed: true }), /proposal it does not qualify for/u);
	// An agent that starts printing a banner cannot spend it as a version.
	throws(() => project({ ...agent, version: "claude version 2.1.237 (build 9)" }), /not a version/u);
	throws(
		() => projectInteropInspection({ ...base, agents: [agent, agent] }, base.generatedAt),
		/duplicate detected-agent identities/u,
	);
	// Detection walks the registry once and drops a kind with nothing to report.
	throws(
		() => projectInteropInspection({ ...base, knownKinds: 0, agents: [agent] }, base.generatedAt),
		/more agents than it knows kinds/u,
	);
	// A snapshot from a build that predates this read is rejected in both directions.
	throws(
		() =>
			projectInteropInspection(
				{ version: 1, generatedAt: base.generatedAt, knownKinds: 8, agents: [] },
				base.generatedAt,
			),
		/invalid detected-agent inventory/u,
	);
});

Deno.test("interop detection maps incompatible output to a bounded GUI error", async () => {
	const inspector = new ClioCliInteropInspector({
		executable: Deno.execPath(),
		prefixArgs: ["eval", "console.log('{}')", "--"],
	});
	await rejects(
		() => inspector.inspect(Deno.cwd()),
		(error: unknown) => error instanceof ClioInteropInspectError && error.code === "internal",
	);
});
