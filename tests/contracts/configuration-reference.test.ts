import { strictEqual } from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { it } from "node:test";

it("checks configuration rows through real hygiene in a disposable package fixture", () => {
	const root = resolve(import.meta.dirname, "../..");
	const fixture = mkdtempSync(join(tmpdir(), "clio-configuration-reference-"));
	try {
		for (const entry of readdirSync(root)) {
			if (!["node_modules", ".git", "dist"].includes(entry))
				cpSync(join(root, entry), join(fixture, entry), { recursive: true });
			else symlinkSync(join(root, entry), join(fixture, entry));
		}
		const docPath = join(fixture, "docs/guide/configuration-reference.md");
		const original = readFileSync(docPath, "utf8");
		const cases = [
			{
				paths: [
					"context.compaction.model",
					"fleet.profiles.<key>.node",
					"targets[].auth.headers.<key>",
					"fleet.rosters.<key>.members[].model",
				],
				stale: false,
			},
			{
				paths: [
					"chat.obsoleteOption",
					"context.compaction.obsoleteOption",
					"targets[].capabilities.obsoleteOption",
					"fleet.profiles.<key>.obsoleteOption",
					"fleet.rosters.<key>.members[].obsoleteOption",
					"chat.model.obsoleteOption",
					"chat[].model",
					"chat.<key>.model",
				],
				stale: true,
			},
		];
		for (const scenario of cases) {
			writeFileSync(
				docPath,
				original.replace(
					"## Settings keys",
					`## Settings keys\n${scenario.paths.map((path) => `| \`${path}\` | fixture |`).join("\n")}`,
				),
			);
			const result = spawnSync(process.execPath, ["--import", "tsx", join(root, "scripts/check-hygiene.ts")], {
				cwd: root,
				env: { ...process.env, CLIO_CODER_PACKAGE_ROOT: fixture },
				encoding: "utf8",
				timeout: 120_000,
			});
			strictEqual(result.error, undefined);
			const output = result.stdout + result.stderr;
			strictEqual(result.status, scenario.stale ? 1 : 0, output);
			for (const path of scenario.paths) {
				strictEqual(output.includes(`\n  ${path}\n`), scenario.stale, output);
			}
		}
	} finally {
		rmSync(fixture, { recursive: true, force: true });
	}
});
