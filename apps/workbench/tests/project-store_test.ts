import { deepStrictEqual, equal, ok, rejects } from "node:assert/strict";
import { join } from "node:path";
import { ProjectStore, ProjectStoreError, type ProjectStoreErrorCode, type ProjectTreeNode } from "../project-store.ts";

interface TestLayout {
	root: string;
	sandbox: string;
	outside: string;
}

async function withLayout(run: (layout: TestLayout) => Promise<void>): Promise<void> {
	const root = await Deno.makeTempDir({ prefix: "workbench-project-store-" });
	const sandbox = join(root, "sandbox");
	const outside = join(root, "outside");
	await Deno.mkdir(sandbox);
	await Deno.mkdir(outside);
	try {
		await run({ root, sandbox, outside });
	} finally {
		await Deno.remove(root, { recursive: true });
	}
}

function opaqueIdFactory(): () => string {
	let sequence = 0;
	return () => `opaque-${String(++sequence).padStart(8, "0")}`;
}

async function expectStoreError(promise: Promise<unknown>, code: ProjectStoreErrorCode): Promise<void> {
	await rejects(
		promise,
		(error: unknown) => error instanceof ProjectStoreError && error.code === code,
		`expected ProjectStoreError(${code})`,
	);
}

function findNode(root: ProjectTreeNode, path: readonly string[]): ProjectTreeNode | undefined {
	if (root.path.length === path.length && root.path.every((segment, index) => segment === path[index])) return root;
	for (const child of root.children ?? []) {
		const found = findNode(child, path);
		if (found) return found;
	}
	return undefined;
}

function greatestDepth(root: ProjectTreeNode): number {
	return Math.max(root.path.length, ...(root.children ?? []).map(greatestDepth));
}

Deno.test("seeded, created, and registered projects keep opaque IDs and isolate mutations", async () => {
	await withLayout(async ({ sandbox }) => {
		await Deno.mkdir(join(sandbox, "existing"));
		const store = await ProjectStore.open({
			sandboxRoot: sandbox,
			sandboxId: "test-sandbox",
			idFactory: opaqueIdFactory(),
			seeds: [
				{
					id: "project-alpha-0001",
					displayName: "Alpha",
					relativeRoot: ["alpha"],
					createIfMissing: true,
				},
				{
					id: "project-beta-0002",
					displayName: "Beta",
					relativeRoot: ["beta"],
					createIfMissing: true,
				},
			],
		});

		const [alpha, beta] = store.listProjects();
		ok(alpha);
		ok(beta);
		equal(alpha.id, "project-alpha-0001");
		equal(beta.id, "project-beta-0002");
		deepStrictEqual(alpha.identity, {
			kind: "local-sandbox",
			sandboxId: "test-sandbox",
			relativeRoot: ["alpha"],
		});
		ok(!JSON.stringify(alpha).includes(sandbox), "renderer DTO must not contain the absolute sandbox root");

		await store.createFile({ projectId: alpha.id, parent: [], name: "shared.txt" });
		await store.createFile({ projectId: beta.id, parent: [], name: "shared.txt" });
		await store.moveEntry({
			projectId: alpha.id,
			source: ["shared.txt"],
			destination: { parent: [], name: "alpha-only.txt" },
		});

		const alphaTree = await store.getTree({ projectId: alpha.id });
		const betaTree = await store.getTree({ projectId: beta.id });
		ok(findNode(alphaTree.root, ["alpha-only.txt"]));
		equal(findNode(alphaTree.root, ["shared.txt"]), undefined);
		ok(findNode(betaTree.root, ["shared.txt"]));

		const deleteAlpha = await store.prepareDelete({ projectId: alpha.id, target: ["alpha-only.txt"] });
		await store.confirmDelete({ projectId: alpha.id, confirmationId: deleteAlpha.confirmationId });
		ok((await Deno.lstat(join(sandbox, "beta", "shared.txt"))).isFile);

		const created = await store.createProject({ displayName: "Gamma", directoryName: "gamma" });
		const duplicate = await store.registerProject({ displayName: "Ignored duplicate name", relativeRoot: ["gamma"] });
		equal(duplicate.id, created.id, "registering the same canonical root must preserve its ID");
		const existing = await store.registerProject({ relativeRoot: ["existing"] });
		equal(existing.displayName, "existing");
		ok(store.listProjects().some((project) => project.id === created.id));
	});
});

Deno.test("segment-array paths reject traversal, absolute forms, separators, and controls", async () => {
	await withLayout(async ({ sandbox, outside }) => {
		const store = await ProjectStore.open({
			sandboxRoot: sandbox,
			idFactory: opaqueIdFactory(),
			seeds: [{ id: "project-safe-0001", displayName: "Safe", relativeRoot: ["safe"], createIfMissing: true }],
		});
		const projectId = store.listProjects()[0]?.id as string;
		await Deno.writeTextFile(join(outside, "sentinel.txt"), "outside");

		for (const root of [[".."], ["/etc"], ["C:\\Windows"], ["C:"], ["bad\nname"]]) {
			await expectStoreError(store.getTree({ projectId, root }), "invalid_path");
		}
		for (const name of ["../escape", "child/name", "child\\name", "bad\u0000name"]) {
			await expectStoreError(store.createFile({ projectId, parent: [], name }), "invalid_path");
		}
		await expectStoreError(store.prepareDelete({ projectId, target: [] }), "invalid_path");
		await expectStoreError(
			store.moveEntry({
				projectId,
				source: ["missing"],
				destination: { parent: [], name: "bad\nname" },
			}),
			"invalid_path",
		);
		equal(await Deno.readTextFile(join(outside, "sentinel.txt")), "outside");
	});
});

Deno.test("tree exposes symlinks as blocked leaves and operations never follow them", async () => {
	await withLayout(async ({ sandbox, outside }) => {
		await Deno.mkdir(join(sandbox, "alpha"));
		await Deno.writeTextFile(join(outside, "sentinel.txt"), "outside");
		await Deno.symlink(outside, join(sandbox, "alpha", "escape"), { type: "dir" });
		await Deno.symlink(outside, join(sandbox, "linked-project"), { type: "dir" });

		const store = await ProjectStore.open({ sandboxRoot: sandbox, idFactory: opaqueIdFactory() });
		const alpha = await store.registerProject({ displayName: "Alpha", relativeRoot: ["alpha"] });
		const tree = await store.getTree({ projectId: alpha.id });
		const link = findNode(tree.root, ["escape"]);
		ok(link);
		equal(link.kind, "symlink");
		equal(link.operable, false);
		equal(link.blockedReason, "symlink");
		equal(link.children, undefined);

		await expectStoreError(
			store.createFile({ projectId: alpha.id, parent: ["escape"], name: "escaped.txt" }),
			"symlink_blocked",
		);
		await expectStoreError(store.prepareDelete({ projectId: alpha.id, target: ["escape"] }), "symlink_blocked");
		await expectStoreError(
			store.moveEntry({
				projectId: alpha.id,
				source: ["escape"],
				destination: { parent: [], name: "moved-link" },
			}),
			"symlink_blocked",
		);
		await expectStoreError(
			store.registerProject({ displayName: "Linked", relativeRoot: ["linked-project"] }),
			"symlink_blocked",
		);
		equal(await Deno.readTextFile(join(outside, "sentinel.txt")), "outside");
		await rejects(Deno.lstat(join(outside, "escaped.txt")), Deno.errors.NotFound);
	});
});

Deno.test("delete challenges are project-bound, one-use, expiring, and fingerprint-bound", async () => {
	await withLayout(async ({ sandbox }) => {
		let now = Date.parse("2026-08-17T12:00:00.000Z");
		const store = await ProjectStore.open({
			sandboxRoot: sandbox,
			idFactory: opaqueIdFactory(),
			now: () => now,
			deleteConfirmationTtlMs: 100,
			seeds: [
				{ id: "project-alpha-0001", displayName: "Alpha", relativeRoot: ["alpha"], createIfMissing: true },
				{ id: "project-beta-0002", displayName: "Beta", relativeRoot: ["beta"], createIfMissing: true },
			],
		});
		const [alpha, beta] = store.listProjects();
		ok(alpha);
		ok(beta);

		await store.createFile({ projectId: alpha.id, parent: [], name: "victim.txt" });
		const challenge = await store.prepareDelete({ projectId: alpha.id, target: ["victim.txt"] });
		await expectStoreError(
			store.confirmDelete({ projectId: beta.id, confirmationId: challenge.confirmationId }),
			"confirmation_mismatch",
		);
		ok((await Deno.lstat(join(sandbox, "alpha", "victim.txt"))).isFile);
		await store.confirmDelete({ projectId: alpha.id, confirmationId: challenge.confirmationId });
		await rejects(Deno.lstat(join(sandbox, "alpha", "victim.txt")), Deno.errors.NotFound);
		await expectStoreError(
			store.confirmDelete({ projectId: alpha.id, confirmationId: challenge.confirmationId }),
			"confirmation_not_found",
		);

		await store.createFile({ projectId: alpha.id, parent: [], name: "expired.txt" });
		const expiring = await store.prepareDelete({ projectId: alpha.id, target: ["expired.txt"] });
		now += 101;
		await expectStoreError(
			store.confirmDelete({ projectId: alpha.id, confirmationId: expiring.confirmationId }),
			"confirmation_expired",
		);
		ok((await Deno.lstat(join(sandbox, "alpha", "expired.txt"))).isFile);

		await store.createFile({ projectId: alpha.id, parent: [], name: "changed.txt" });
		const stale = await store.prepareDelete({ projectId: alpha.id, target: ["changed.txt"] });
		await Deno.writeTextFile(join(sandbox, "alpha", "changed.txt"), "changed after confirmation");
		await expectStoreError(
			store.confirmDelete({ projectId: alpha.id, confirmationId: stale.confirmationId }),
			"stale_entry",
		);
		equal(await Deno.readTextFile(join(sandbox, "alpha", "changed.txt")), "changed after confirmation");
		await expectStoreError(
			store.confirmDelete({ projectId: alpha.id, confirmationId: stale.confirmationId }),
			"confirmation_not_found",
		);

		await store.createFolder({ projectId: alpha.id, parent: [], name: "non-empty" });
		await store.createFile({ projectId: alpha.id, parent: ["non-empty"], name: "child.txt" });
		await expectStoreError(
			store.prepareDelete({ projectId: alpha.id, target: ["non-empty"] }),
			"directory_not_empty",
		);
	});
});

Deno.test("move is serialized and refuses an existing destination without clobbering either entry", async () => {
	await withLayout(async ({ sandbox }) => {
		const store = await ProjectStore.open({
			sandboxRoot: sandbox,
			idFactory: opaqueIdFactory(),
			seeds: [{ id: "project-moves-0001", displayName: "Moves", relativeRoot: ["moves"], createIfMissing: true }],
		});
		const projectId = store.listProjects()[0]?.id as string;
		await store.createFile({ projectId, parent: [], name: "source.txt" });
		await store.createFile({ projectId, parent: [], name: "destination.txt" });
		await Deno.writeTextFile(join(sandbox, "moves", "source.txt"), "source");
		await Deno.writeTextFile(join(sandbox, "moves", "destination.txt"), "destination");

		await expectStoreError(
			store.moveEntry({
				projectId,
				source: ["source.txt"],
				destination: { parent: [], name: "destination.txt" },
			}),
			"already_exists",
		);
		equal(await Deno.readTextFile(join(sandbox, "moves", "source.txt")), "source");
		equal(await Deno.readTextFile(join(sandbox, "moves", "destination.txt")), "destination");

		await store.createFolder({ projectId, parent: [], name: "folder" });
		await expectStoreError(
			store.moveEntry({
				projectId,
				source: ["folder"],
				destination: { parent: ["folder"], name: "nested" },
			}),
			"invalid_move",
		);

		const simultaneous = await Promise.allSettled([
			store.createFile({ projectId, parent: [], name: "once.txt" }),
			store.createFile({ projectId, parent: [], name: "once.txt" }),
		]);
		equal(simultaneous.filter((result) => result.status === "fulfilled").length, 1);
		const rejected = simultaneous.find((result) => result.status === "rejected");
		ok(rejected?.status === "rejected");
		ok(rejected.reason instanceof ProjectStoreError);
		equal(rejected.reason.code, "already_exists");
	});
});

Deno.test("recursive trees never exceed five levels or two hundred total nodes", async () => {
	await withLayout(async ({ sandbox }) => {
		const projectRoot = join(sandbox, "large");
		await Deno.mkdir(projectRoot);
		let deep = join(projectRoot, "000-deep");
		await Deno.mkdir(deep);
		for (let depth = 1; depth <= 7; depth += 1) {
			deep = join(deep, `level-${depth}`);
			await Deno.mkdir(deep);
		}
		await Deno.writeTextFile(join(deep, "leaf.txt"), "leaf");
		await Promise.all(
			Array.from(
				{ length: 205 },
				(_, index) =>
					Deno.writeTextFile(join(projectRoot, `file-${String(index).padStart(3, "0")}.txt`), String(index)),
			),
		);

		const store = await ProjectStore.open({ sandboxRoot: sandbox, idFactory: opaqueIdFactory() });
		const project = await store.registerProject({ displayName: "Large", relativeRoot: ["large"] });
		const tree = await store.getTree({ projectId: project.id, maxDepth: 99, maxNodes: 999 });
		equal(tree.maxDepth, 5);
		equal(tree.maxNodes, 200);
		ok(tree.nodeCount <= 200);
		ok(greatestDepth(tree.root) <= 5);
		equal(tree.truncated, true);
	});
});

Deno.test("registered root identity changes fail closed", async () => {
	await withLayout(async ({ sandbox }) => {
		const store = await ProjectStore.open({
			sandboxRoot: sandbox,
			idFactory: opaqueIdFactory(),
			seeds: [{ id: "project-root-0001", displayName: "Root", relativeRoot: ["root"], createIfMissing: true }],
		});
		const projectId = store.listProjects()[0]?.id as string;
		await Deno.rename(join(sandbox, "root"), join(sandbox, "original-root"));
		await Deno.mkdir(join(sandbox, "root"));

		await expectStoreError(store.createFile({ projectId, parent: [], name: "wrong-root.txt" }), "root_changed");
		await rejects(Deno.lstat(join(sandbox, "root", "wrong-root.txt")), Deno.errors.NotFound);
	});
});

Deno.test("trusted root resolution returns the exact canonical project root", async () => {
	await withLayout(async ({ sandbox }) => {
		const projectRoot = join(sandbox, "trusted");
		await Deno.mkdir(projectRoot);
		const store = await ProjectStore.open({ sandboxRoot: sandbox, idFactory: opaqueIdFactory() });
		const project = await store.registerProject({ displayName: "Trusted", relativeRoot: ["trusted"] });

		equal(await store.resolveTrustedRoot(project.id), await Deno.realPath(projectRoot));
	});
});

Deno.test("trusted root resolution rejects an unknown project", async () => {
	await withLayout(async ({ sandbox }) => {
		const store = await ProjectStore.open({ sandboxRoot: sandbox, idFactory: opaqueIdFactory() });

		await expectStoreError(store.resolveTrustedRoot("project-missing-0001"), "project_not_found");
	});
});

Deno.test("trusted root resolution fails closed after a registered root is replaced or symlinked", async () => {
	await withLayout(async ({ sandbox }) => {
		const store = await ProjectStore.open({
			sandboxRoot: sandbox,
			idFactory: opaqueIdFactory(),
			seeds: [
				{ id: "project-replaced-0001", displayName: "Replaced", relativeRoot: ["replaced"], createIfMissing: true },
				{ id: "project-symlinked-0002", displayName: "Symlinked", relativeRoot: ["symlinked"], createIfMissing: true },
			],
		});

		await Deno.rename(join(sandbox, "replaced"), join(sandbox, "original-replaced"));
		await Deno.mkdir(join(sandbox, "replaced"));
		await expectStoreError(store.resolveTrustedRoot("project-replaced-0001"), "root_changed");

		await Deno.rename(join(sandbox, "symlinked"), join(sandbox, "original-symlinked"));
		await Deno.symlink(join(sandbox, "original-symlinked"), join(sandbox, "symlinked"), { type: "dir" });
		await expectStoreError(store.resolveTrustedRoot("project-symlinked-0002"), "root_changed");
	});
});
