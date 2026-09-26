import { match, strictEqual } from "node:assert/strict";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { it } from "node:test";
import { toolchainFindings } from "../../src/cli/doctor-toolchain.js";
import { yaziProfileDir } from "../../src/domains/mux/index.js";
import { ensureYaziProfile } from "../../src/domains/mux/yazi/profile.js";
import { isolateClioEnv } from "../harness/scratch-env.js";

it("doctor treats an unused Yazi profile as information and repairs missing and stale profiles", async () => {
	const env = await isolateClioEnv("doctor-yazi-");
	try {
		const bin = join(env.dir, "bin");
		mkdirSync(bin);
		for (const name of ["yazi", "ya"])
			writeFileSync(join(bin, name), '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "yazi 99.0.0"; fi\n', {
				mode: 0o755,
			});
		process.env.PATH = bin;
		const profileRow = (fix = false) =>
			toolchainFindings({ filesEnabled: true, fix }).find((row) => row.name === "files pane profile");
		strictEqual(profileRow()?.level, "info");
		strictEqual(profileRow(true)?.level, "ok");
		writeFileSync(join(yaziProfileDir(), "stamp.json"), "{}");
		strictEqual(profileRow()?.level, "warn");
		strictEqual(profileRow(true)?.level, "ok");
	} finally {
		env.restore();
	}
});

it("doctor retains a generation failure until a profile successfully regenerates", async () => {
	const env = await isolateClioEnv("doctor-yazi-failure-");
	try {
		const bin = join(env.dir, "bin");
		mkdirSync(bin);
		const yazi = join(bin, "yazi");
		writeFileSync(join(bin, "ya"), '#!/bin/sh\necho "ya 99.0.0"\n', { mode: 0o755 });
		writeFileSync(yazi, '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "yazi 99.0.0"; else exit 1; fi\n', {
			mode: 0o755,
		});
		process.env.PATH = bin;
		const row = (fix = false) =>
			toolchainFindings({ filesEnabled: true, fix }).find((finding) => finding.name === "files pane profile");
		strictEqual(row(true)?.level, "warn");
		strictEqual(row()?.level, "warn");
		match(row()?.detail ?? "", /generation failed/);
		writeFileSync(yazi, '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "yazi 99.0.0"; fi\n', { mode: 0o755 });
		strictEqual(row(true)?.level, "ok");
		strictEqual(row()?.level, "ok");
	} finally {
		env.restore();
	}
});

it("review round 2 B: an unwritable cache returns null even when its failure marker cannot be written", async () => {
	const env = await isolateClioEnv("yazi-unwritable-");
	try {
		const cache = join(env.dir, "cache-file");
		writeFileSync(cache, "not a directory");
		strictEqual(
			ensureYaziProfile({ yaPath: "/missing/ya", profileDir: join(cache, "profile"), yaziPath: "/missing/yazi" }),
			null,
		);
	} finally {
		env.restore();
	}
});

it("review round 2 B: failure recording and cleanup tolerate a cache becoming unwritable during validation", async () => {
	const env = await isolateClioEnv("yazi-cache-permission-");
	const cache = join(env.dir, "cache");
	mkdirSync(cache);
	try {
		const yazi = join(env.dir, "failing-yazi");
		writeFileSync(yazi, `#!/bin/sh\n/bin/chmod 500 '${cache}'\nexit 1\n`, { mode: 0o755 });
		strictEqual(ensureYaziProfile({ yaPath: "/missing/ya", yaziPath: yazi, profileDir: join(cache, "profile") }), null);
	} finally {
		chmodSync(cache, 0o700);
		env.restore();
	}
});
