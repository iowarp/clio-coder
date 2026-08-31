import { deepStrictEqual, equal, ok, rejects, throws } from "node:assert/strict";
import {
	ClioCliRecoveryInspector,
	ClioRecoveryInspectError,
	projectRecoveryInspection,
} from "../clio-recovery-inspector.ts";

const FIXTURE = new URL("./recovery-inspect-child-fixture.ts", import.meta.url).pathname;

Deno.test("recovery inspection names each check and drops every raw diagnostic detail", async () => {
	const root = await Deno.makeTempDir({ prefix: "clio-coder-gui-recovery-inspect-" });
	try {
		const inspector = new ClioCliRecoveryInspector({
			executable: Deno.execPath(),
			prefixArgs: ["run", "--quiet", "--no-config", FIXTURE, "--"],
			now: () => Date.parse("2026-08-30T15:00:00.000Z"),
		});
		const inspection = await inspector.inspect(root, true);
		equal(inspection.scope, "installation");
		equal(inspection.projectContext, true);
		equal(inspection.inspectedAt, "2026-08-30T15:00:00.000Z");
		equal(inspection.healthy, false);
		equal(inspection.pathsResolved, 4);
		deepStrictEqual(inspection.versions, { clioCoder: "0.3.9", node: "v24.9.0", platform: "linux-x64" });
		deepStrictEqual(inspection.summary, { checks: 18, passed: 12, warnings: 4, failures: 2 });
		deepStrictEqual(inspection.sections.find((section) => section.id === "models"), {
			id: "models",
			checks: 2,
			passed: 0,
			warnings: 1,
			failures: 1,
		});
		// Names that classified into the sections the older projection did not know
		// about, which previously all landed in "other".
		deepStrictEqual(inspection.sections.find((section) => section.id === "toolchain"), {
			id: "toolchain",
			checks: 1,
			passed: 0,
			warnings: 1,
			failures: 0,
		});
		deepStrictEqual(inspection.sections.find((section) => section.id === "panes"), {
			id: "panes",
			checks: 1,
			passed: 1,
			warnings: 0,
			failures: 0,
		});

		equal(inspection.checks.length, inspection.summary.checks);
		equal(inspection.checksTruncated, false);
		// The subject a check ran against crosses with it: that is what makes the
		// verdict actionable rather than "one models check failed".
		deepStrictEqual(
			inspection.checks.find((check) => check.name === "model private-lab"),
			{ name: "model private-lab", section: "models", level: "error" },
		);
		deepStrictEqual(
			inspection.checks.find((check) => check.name === "external tool yazi"),
			{ name: "external tool yazi", section: "toolchain", level: "warn" },
		);
		// A name carrying a native path keeps its verdict and section and loses the
		// name, rather than blanking the whole sweep.
		deepStrictEqual(
			inspection.checks.filter((check) => check.name === null),
			[{ name: null, section: "other", level: "ok" }],
		);

		const frame = JSON.stringify(inspection);
		for (
			const forbidden of [
				"researcher",
				"model-secret",
				"10.0.0",
				"secretToken",
				"/private/",
				"http://",
				"herdr.sock",
				"below the floor",
			]
		) ok(!frame.includes(forbidden), `recovery projection leaked ${forbidden}`);
	} finally {
		await Deno.remove(root, { recursive: true });
	}
});

Deno.test("recovery projection rejects contradictory summaries and invalid path roots", () => {
	const roots = { config: "/a", data: "/b", state: "/c", cache: "/d" };
	const at = "2026-08-30T15:00:00.000Z";
	throws(
		() =>
			projectRecoveryInspection(
				{ ok: true, fix: false, findings: [{ ok: false, name: "settings.yaml", detail: "invalid" }] },
				roots,
				at,
				false,
			),
		/contradictory diagnostic summary/u,
	);
	throws(
		() =>
			projectRecoveryInspection(
				{ ok: true, fix: false, findings: [{ ok: true, name: "Clio Coder version", detail: "0.3.9" }] },
				{ ...roots, config: "relative" },
				at,
				false,
			),
		/invalid path resolution report/u,
	);
	throws(
		() => projectRecoveryInspection({ ok: true, fix: false, findings: [] }, roots, at, /* projectContext */ false),
		/invalid diagnostic report/u,
	);
});

Deno.test("recovery inspection maps incompatible output to a bounded GUI error", async () => {
	const inspector = new ClioCliRecoveryInspector({
		executable: Deno.execPath(),
		prefixArgs: ["eval", "console.log('{}')", "--"],
	});
	await rejects(
		() => inspector.inspect(Deno.cwd(), false),
		(error: unknown) => error instanceof ClioRecoveryInspectError && error.code === "internal",
	);
});
