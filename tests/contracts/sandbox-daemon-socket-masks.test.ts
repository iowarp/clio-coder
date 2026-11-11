import { deepStrictEqual } from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { runtimeEscapeMasksUnder } from "../../src/core/sandbox/worker-process.js";

describe("worker sandbox masks root-equivalent daemon sockets", () => {
	const root = mkdtempSync(join(tmpdir(), "clio-daemon-sockets-"));
	after(() => rmSync(root, { recursive: true, force: true }));

	it("masks container and virtualization daemon sockets that exist under the root", () => {
		const files = [
			"run/docker.sock",
			"var/snap/lxd/common/lxd/unix.socket",
			"var/lib/lxd/unix.socket",
			"var/lib/incus/unix.socket",
			"var/lib/incus/unix.socket.user",
		];
		const dirs = ["run/podman", "run/containerd", "run/libvirt", "run/incus"];
		for (const file of files) {
			mkdirSync(dirname(join(root, file)), { recursive: true });
			writeFileSync(join(root, file), "");
		}
		for (const dir of dirs) mkdirSync(join(root, dir), { recursive: true });
		const masks = runtimeEscapeMasksUnder(root).map((mask) => [mask.path.slice(root.length + 1), mask.kind]);
		deepStrictEqual(
			new Set(masks.map(([path, kind]) => `${path}:${kind}`)),
			new Set([...files.map((file) => `${file}:file`), ...dirs.map((dir) => `${dir}:directory`)]),
		);
	});
});
