import { deepStrictEqual, equal, ok, rejects } from "node:assert/strict";
import {
	ClioCliRecoveryInspector,
	ClioRecoveryInspectError,
	projectRecoveryInspection,
} from "../clio-recovery-inspector.ts";

const FIXTURE = new URL("./recovery-inspect-child-fixture.ts", import.meta.url).pathname;

Deno.test("recovery inspection aggregates fixed categories and drops raw diagnostic identities", async () => {
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
		deepStrictEqual(inspection.summary, { checks: 15, passed: 10, warnings: 3, failures: 2 });
		deepStrictEqual(inspection.sections.find((section) => section.id === "models"), {
			id: "models",
			checks: 2,
			passed: 0,
			warnings: 1,
			failures: 1,
		});
		const frame = JSON.stringify(inspection);
		for (
			const forbidden of [
				"researcher",
				"private-lab",
				"model-secret",
				"private-peer",
				"ssh-private",
				"10.0.0",
				"secretToken",
			]
		) ok(!frame.includes(forbidden), `recovery projection leaked ${forbidden}`);
	} finally {
		await Deno.remove(root, { recursive: true });
	}
});

Deno.test("recovery projection rejects contradictory summaries and invalid path roots", () => {
	const doctor = { ok: true, fix: false, findings: [{ ok: false, name: "settings.yaml", detail: "invalid" }] };
	rejects(
		Promise.resolve().then(() =>
			projectRecoveryInspection(
				doctor,
				{
					config: "/a",
					data: "/b",
					state: "/c",
					cache: "/d",
				},
				"2026-08-30T15:00:00.000Z",
				false,
			)
		),
		/contradictory diagnostic summary/u,
	);
	rejects(
		Promise.resolve().then(() =>
			projectRecoveryInspection(
				{ ok: true, fix: false, findings: [{ ok: true, name: "Clio Coder version", detail: "0.3.9" }] },
				{ config: "relative", data: "/b", state: "/c", cache: "/d" },
				"2026-08-30T15:00:00.000Z",
				false,
			)
		),
		/invalid path resolution report/u,
	);
	rejects(
		Promise.resolve().then(() =>
			projectRecoveryInspection(
				{ ok: true, fix: false, findings: [] },
				{ config: "/a", data: "/b", state: "/c", cache: "/d" },
				"2026-08-30T15:00:00.000Z",
				false,
			)
		),
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
