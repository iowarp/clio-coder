import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createExtensionTestHost } from "@iowarp/clio-coder/extensions/testing";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
function workspace(): string {
	assert.ok(process.env.TMPDIR, "Set an owned TMPDIR for the fixtures.");
	return realpathSync(mkdtempSync(path.join(process.env.TMPDIR, "peer-guard-")));
}

test("another owner is blocked on write and edit, including a symlink alias; the same owner and unclaimed paths pass", async () => {
	const cwd = workspace();
	mkdirSync(path.join(cwd, "actual"));
	symlinkSync("actual", path.join(cwd, "alias"));
	const first = await createExtensionTestHost(ROOT, { workspace: cwd, sessionId: "first" });
	const peer = await createExtensionTestHost(ROOT, { workspace: cwd, sessionId: "peer" });
	try {
		assert.match((await first.command("claim", "actual/draft.txt")).text, /Claimed/);
		// Each test host deliberately has isolated storage. Seed the second host with the first's real command output state.
		await peer.store.set("claims", (await first.store.get("claims")).value);
		const write = {
			point: "before_tool" as const,
			turnId: null,
			tool: "write",
			args: { path: "actual/draft.txt", content: "new" },
		};
		const blocked = await peer.hook(write);
		assert.equal(blocked.effects?.[0]?.kind, "block_tool");
		assert.match(JSON.stringify(blocked), /another session \(first\)/);
		const aliased = await peer.hook({
			point: "before_tool",
			turnId: null,
			tool: "edit",
			args: { path: "alias/draft.txt", old_string: "old", new_string: "new" },
		});
		assert.equal(aliased.effects?.[0]?.kind, "block_tool");
		assert.deepEqual(await first.hook(write), {});
		assert.deepEqual(await peer.hook({ ...write, args: { path: "unclaimed.txt" } }), {});
		assert.match((await peer.command("claim", "alias/draft.txt")).text, /Cannot claim/);
		assert.match((await peer.command("release", "actual/draft.txt")).text, /Cannot release/);
		const list = await peer.command("claims");
		assert.equal(list.card?.t, "table");
		assert.match(list.text, /first · 10 min/);
		assert.match((await first.command("release", "actual/draft.txt")).text, /Released/);
		await peer.store.set("claims", (await first.store.get("claims")).value);
		assert.deepEqual(await peer.hook(write), {});
	} finally {
		await first.dispose();
		await peer.dispose();
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("claims expire at the configured boundary and another owner can reclaim the path", async () => {
	const cwd = workspace();
	const host = await createExtensionTestHost(ROOT, {
		workspace: cwd,
		sessionId: "new-owner",
		options: { claimMinutes: 1 },
	});
	try {
		await host.store.set("claims", { [path.join(cwd, "draft.txt")]: { owner: "previous-owner", at: 0 } });
		const event = { point: "before_tool" as const, turnId: null, tool: "write", args: { path: "draft.txt" } };
		assert.equal((await host.hook(event)).effects?.[0]?.kind, "block_tool");
		await host.advance(60000);
		assert.deepEqual(await host.hook(event), {});
		assert.equal((await host.command("claims")).text, "No active claims.");
		assert.match((await host.command("claim", "draft.txt")).text, /Claimed/);
		assert.deepEqual(await host.hook(event), {});
	} finally {
		await host.dispose();
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("compare-and-set retains concurrent claims with one stable session owner", async () => {
	const cwd = workspace();
	const host = await createExtensionTestHost(ROOT, { workspace: cwd, sessionId: "parallel" });
	try {
		const outputs = await Promise.all([host.command("claim", "first.txt"), host.command("claim", "second.txt")]);
		assert.ok(outputs.every((output) => /Claimed/.test(output.text)));
		const claims = (await host.store.get<Record<string, { owner: string }>>("claims")).value;
		assert.equal(Object.keys(claims ?? {}).length, 2);
		const identity = (await host.state.get<string>("owner")).value;
		assert.equal(identity, "parallel");
		assert.ok(Object.values(claims ?? {}).every((claim) => claim.owner === identity));
		assert.deepEqual(
			await host.hook({ point: "before_tool", turnId: null, tool: "edit", args: { path: "first.txt" } }),
			{},
		);
	} finally {
		await host.dispose();
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("paths escaping the physical workspace cannot be claimed; invalid input is advisory pass", async () => {
	const cwd = workspace();
	const outside = workspace();
	symlinkSync(outside, path.join(cwd, "escape"));
	const host = await createExtensionTestHost(ROOT, { workspace: cwd });
	try {
		await assert.rejects(host.command("claim", "../outside.txt"), /inside this workspace/);
		await assert.rejects(host.command("claim", "escape/draft.txt"), /physical workspace/);
		assert.deepEqual(
			await host.hook({ point: "before_tool", turnId: null, tool: "write", args: { path: "escape/draft.txt" } }),
			{},
		);
	} finally {
		await host.dispose();
		rmSync(cwd, { recursive: true, force: true });
		rmSync(outside, { recursive: true, force: true });
	}
});

test("pre-turn commands do not leave claims that a reload could orphan", async () => {
	const cwd = workspace();
	const host = await createExtensionTestHost(ROOT, { workspace: cwd, sessionId: null });
	try {
		assert.match((await host.command("claim", "draft.txt")).text, /established Clio session/);
		assert.equal((await host.store.get("claims")).value, undefined);
		await host.store.set("claims", { [path.join(cwd, "draft.txt")]: { owner: "peer", at: 0 } });
		assert.equal(
			(await host.hook({ point: "before_tool", turnId: null, tool: "write", args: { path: "draft.txt" } })).effects?.[0]
				?.kind,
			"block_tool",
		);
	} finally {
		await host.dispose();
		rmSync(cwd, { recursive: true, force: true });
	}
});
