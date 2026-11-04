import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, it } from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("../../scripts/export-github-wiki.mjs", import.meta.url));
let root: string;
let repo: string;
let from: string;
let to: string;
let head: string;

function write(base: string, relative: string, text: string): void {
	const target = join(base, relative);
	mkdirSync(dirname(target), { recursive: true });
	writeFileSync(target, text);
}

function git(...args: string[]): string {
	return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
}

function meta(overrides: Record<string, unknown> = {}): string {
	return JSON.stringify({
		gitHead: head,
		updatedAt: "2026-11-04T00:00:00.000Z",
		model: "fixture-model",
		generation: { pagesPlanned: 2, pagesWritten: 2 },
		...overrides,
	});
}

function exportWiki(...extra: string[]) {
	return spawnSync(process.execPath, [script, "--from", from, "--to", to, "--repo", repo, ...extra], {
		encoding: "utf8",
	});
}

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "wiki-export-"));
	repo = join(root, "repo");
	from = join(root, "wiki");
	to = join(root, "out");
	mkdirSync(repo);
	git("init", "-q");
	write(repo, "src/api.ts", "export const api = 1;\n");
	git("add", ".");
	git("-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture");
	head = git("rev-parse", "HEAD");
	write(from, "quickstart.md", "# repo wiki\n\nOverview.\n\n- [Dispatch](domains/dispatch.md)\n");
	write(from, "index.md", "# Wiki\n");
	write(
		from,
		"domains/dispatch.md",
		'---\ntitle: "Run dispatch"\nsources:\n  - "src/api.ts"\n---\n# Run dispatch\n\nSee `src/api.ts:1:api`, [home](../index.md) and [self](#run-dispatch).\n\n```text\n`src/api.ts`\n```\n',
	);
	write(from, "meta.json", meta());
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

it("exports flat pages with pinned source links, a stamped home and a grouped sidebar", () => {
	write(to, ".git/keep", "kept");
	write(to, "Domains-Observability.md", "a page the new plan dropped");
	const result = exportWiki();
	assert.equal(result.status, 0, result.stderr);
	assert.deepEqual(readdirSync(to).sort(), [".git", "Domains-Dispatch.md", "Home.md", "_Footer.md", "_Sidebar.md"]);
	const page = readFileSync(join(to, "Domains-Dispatch.md"), "utf8");
	assert.match(
		page,
		new RegExp(`\\[\`src/api\\.ts:1:api\`\\]\\(https://github\\.com/iowarp/clio-coder/blob/${head}/src/api\\.ts#L1\\)`),
	);
	assert.match(page, /\[home\]\(https:\/\/github\.com\/iowarp\/clio-coder\/wiki\/Home\)/);
	assert.match(page, /```text\n`src\/api\.ts`\n```/, "fenced code stays untouched");
	const home = readFileSync(join(to, "Home.md"), "utf8");
	assert.match(home, /^# Clio Coder Wiki\n\nGenerated from /);
	assert.ok(home.includes(head.slice(0, 9)));
	const sidebar = readFileSync(join(to, "_Sidebar.md"), "utf8");
	assert.match(sidebar, /\*\*Domains\*\*\n\n- \[Run dispatch\]\(.*\/wiki\/Domains-Dispatch\)/);
	assert.match(readFileSync(join(to, "_Footer.md"), "utf8"), /with fixture-model/);
});

for (const [label, text, expected] of [
	["home path", "Built in /home/someone/project.", /local home path/],
	["private address", "Served from 192.168.1.20.", /private network address/],
	["private directory", "Notes live in .mine/vault.md.", /private directory/],
	["token", `Uses sk-ant-${"a".repeat(24)} today.`, /Anthropic token/],
] as const) {
	it(`refuses a page holding a ${label} and writes nothing`, () => {
		write(from, "domains/dispatch.md", `# Run dispatch\n\n${text}\n`);
		const result = exportWiki();
		assert.equal(result.status, 1);
		assert.match(result.stderr, expected);
		assert.ok(result.stderr.includes("Domains-Dispatch.md:3"));
		assert.equal(existsSync(to), false);
	});
}

it("applies a maintainer deny file", () => {
	const deny = join(root, "deny.txt");
	writeFileSync(deny, "# hosts\n\\bzephyr\\b\n");
	write(from, "domains/dispatch.md", "# Run dispatch\n\nRuns on Zephyr.\n");
	const result = exportWiki("--deny-file", deny);
	assert.equal(result.status, 1);
	assert.match(result.stderr, /denied term/);
	assert.equal(existsSync(to), false);
});

it("refuses broken links, broken anchors and incomplete generations", () => {
	write(from, "domains/dispatch.md", "# Run dispatch\n\n[gone](missing.md) and [bad](../quickstart.md#nowhere).\n");
	write(from, "meta.json", meta({ generation: { pagesPlanned: 3, pagesWritten: 2 } }));
	const result = exportWiki();
	assert.equal(result.status, 1);
	assert.match(result.stderr, /unresolved link missing\.md/);
	assert.match(result.stderr, /missing anchor Home#nowhere/);
	assert.match(result.stderr, /2 of 3 pages written/);
	assert.equal(existsSync(to), false);
});

it("refuses to export into the source checkout", () => {
	const result = spawnSync(process.execPath, [script, "--from", from, "--to", join(repo, "out"), "--repo", repo], {
		encoding: "utf8",
	});
	assert.equal(result.status, 2);
	assert.match(result.stderr, /outside the source repository/);
});
