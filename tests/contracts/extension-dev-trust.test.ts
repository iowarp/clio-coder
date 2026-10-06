import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { DEV_EXTENSIONS_DIR, ExtensionDevScope } from "../../src/domains/extensions/dev-scope.js";
import { trustProjectPackages } from "../harness/project-trust.js";
import { isolateClioEnv } from "../harness/scratch-env.js";

// A cloned repository can ship .clio-coder/dev/extensions/<id>/, which the
// terminal would otherwise raise as a code-execution consent card at the first
// idle moment. Discovery is workspace-trust gated; naming a folder is not.
describe("dev extension discovery and workspace trust", () => {
	let env: Awaited<ReturnType<typeof isolateClioEnv>>;
	let workspace: string;
	let scope: ExtensionDevScope;

	beforeEach(async () => {
		env = await isolateClioEnv("clio-coder-dev-trust-home-");
		workspace = realpathSync(mkdtempSync(path.join(tmpdir(), "clio-coder-dev-trust-ws-")));
		const folder = path.join(workspace, DEV_EXTENSIONS_DIR, "cloned");
		mkdirSync(folder, { recursive: true });
		writeFileSync(path.join(folder, "clio-coder-extension.yaml"), "id: cloned\n");
		scope = new ExtensionDevScope(() => workspace);
	});

	afterEach(() => {
		scope.dispose();
		rmSync(workspace, { recursive: true, force: true });
		rmSync(env.dir, { recursive: true, force: true });
		env.restore();
	});

	it("claims nothing from an untrusted workspace and reports what it withheld", () => {
		deepStrictEqual(scope.discover(), []);
		deepStrictEqual(scope.sources(), []);
		deepStrictEqual(scope.withheld(), [path.join(workspace, DEV_EXTENSIONS_DIR, "cloned")]);
	});

	it("still loads a folder the operator names", () => {
		const folder = path.join(DEV_EXTENSIONS_DIR, "cloned");
		strictEqual(scope.add(folder), null);
		deepStrictEqual(scope.sources(), [path.join(workspace, folder)]);
		deepStrictEqual(scope.withheld(), []);
	});

	it("discovers the folder once the workspace's project extensions are approved", () => {
		mkdirSync(path.join(workspace, ".clio-coder", "extensions"), { recursive: true });
		writeFileSync(path.join(workspace, ".clio-coder", "extensions", "state.json"), '{"version":1,"extensions":{}}\n');
		trustProjectPackages(workspace, "extensions");
		const found = scope.discover();
		deepStrictEqual(found, [path.join(workspace, DEV_EXTENSIONS_DIR, "cloned")]);
		ok(scope.withheld().length === 0);
	});
});
