import { deepStrictEqual, equal, ok, rejects, throws } from "node:assert/strict";
import {
	ClioCliToolchainInspector,
	ClioToolchainInspectError,
	projectToolchainInspection,
} from "../clio-toolchain-inspector.ts";

const FIXTURE = new URL("./toolchain-inspect-child-fixture.ts", import.meta.url).pathname;

Deno.test("the toolchain adapter invokes only the fixed listing and removes every native path", async () => {
	const root = await Deno.makeTempDir({ prefix: "clio-coder-gui-toolchain-inspect-" });
	try {
		const inspector = new ClioCliToolchainInspector({
			executable: Deno.execPath(),
			prefixArgs: ["run", "--quiet", "--no-config", FIXTURE, "--"],
			now: () => Date.parse("2026-08-31T15:02:00.000Z"),
		});
		const inspection = await inspector.inspect(root);
		equal(inspection.scope, "installation");
		equal(inspection.inspectedAt, "2026-08-31T15:02:00.000Z");
		equal(inspection.tools[0]?.id, "herdr");
		equal(inspection.tools[0]?.source, "vendored");
		deepStrictEqual(inspection.tools[0]?.pathCandidate, {
			version: "0.7.5",
			satisfiesMinimum: false,
		});
		const frame = JSON.stringify(inspection);
		for (const forbidden of ["/native/", "installDir", "binaryPath", "detail", 'path"']) {
			ok(!frame.includes(forbidden), `toolchain projection leaked ${forbidden}`);
		}
	} finally {
		await Deno.remove(root, { recursive: true });
	}
});

Deno.test("toolchain projection rejects extra fields, duplicate ids, and contradictory resolution", () => {
	const row = {
		id: "herdr",
		version: "0.8.2",
		license: "Apache-2.0",
		platform: "linux-x64",
		supported: true,
		installed: true,
		installDir: "/tools/herdr",
		source: "vendored",
		binaryPath: "/tools/herdr/herdr",
		foundVersion: "0.8.2",
		minimumVersion: "0.8.2",
		pathCandidate: null,
		detail: "vendored",
	};
	const at = "2026-08-31T15:02:00.000Z";
	for (
		const value of [
			[{ ...row, secretPath: "/private" }],
			[row, row],
			[{ ...row, source: "none" }],
		]
	) {
		throws(() => projectToolchainInspection(value, at));
	}
});

Deno.test("toolchain inspection maps incompatible output to a bounded GUI error", async () => {
	const inspector = new ClioCliToolchainInspector({
		executable: Deno.execPath(),
		prefixArgs: ["eval", "console.log('{}')", "--"],
	});
	await rejects(
		() => inspector.inspect(Deno.cwd()),
		(error: unknown) => error instanceof ClioToolchainInspectError && error.code === "internal",
	);
});
