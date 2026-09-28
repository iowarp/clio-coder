import { match, throws } from "node:assert/strict";
import { mkdir, mkdtemp, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { assertClioDirLayout, type ClioDirs, clioDirLayoutProblems } from "../../src/core/xdg.js";

test("lifecycle roots must be distinct and non-nesting through symlink aliases", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "clio-layout-contract-"));
	t.after(async () => {
		await import("node:fs/promises").then(({ rm }) => rm(root, { recursive: true, force: true }));
	});
	const actual = join(root, "actual");
	const alias = join(root, "alias");
	await mkdir(actual);
	await symlink(actual, alias, "dir");
	const aliased: ClioDirs = {
		config: join(actual, "config"),
		data: join(alias, "config"),
		state: join(root, "state"),
		cache: join(root, "cache"),
	};
	match(clioDirLayoutProblems(aliased).join("\n"), /config and data roots resolve to the same path/u);
	throws(() => assertClioDirLayout(aliased), /Unsafe Clio directory layout/u);

	const nested: ClioDirs = {
		config: join(root, "config"),
		data: join(root, "config", "data"),
		state: join(root, "state"),
		cache: join(root, "cache"),
	};
	match(clioDirLayoutProblems(nested).join("\n"), /config root contains data root/u);
});
