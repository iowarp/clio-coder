import { deepStrictEqual, equal } from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { validateExtensionPackage } from "../../src/domains/extensions/authoring/validate.js";
import { isolateClioEnv } from "../harness/scratch-env.js";

test("validating from inside the package never creates its declared write roots in the source tree", async (t) => {
	const env = await isolateClioEnv("clio-coder-validate-workspace-");
	const root = path.join(env.dir, "pkg");
	mkdirSync(root);
	writeFileSync(
		path.join(root, "clio-coder-extension.json"),
		JSON.stringify({
			id: "desk",
			name: "desk",
			version: "1.0.0",
			description: "Writes planning records",
			runtime: { api: 2, entrypoint: "extension.mjs", permissions: { fs: { write: [".planning"] } } },
		}),
	);
	writeFileSync(path.join(root, "extension.mjs"), "export default () => {};\n");
	const previous = process.cwd();
	process.chdir(root);
	t.after(() => {
		process.chdir(previous);
		env.restore();
	});
	const report = await validateExtensionPackage(".");
	deepStrictEqual(report.registration.status === "failed" ? report.registration.reason : null, null);
	equal(report.registration.status, "passed");
	equal(existsSync(path.join(root, ".planning")), false);
});
