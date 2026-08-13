import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import type { ResourceList, Skill } from "../../src/domains/resources/index.js";
import {
	discoverMarketplaceSkills,
	getMarketplaceSkills,
	MARKETPLACE_UNCONFIGURED,
} from "../../src/domains/resources/index.js";
import { ListOverlayView } from "../../src/interactive/overlays/list-overlay.js";
import {
	buildDiagnosticItems,
	buildInstalledItems,
	buildMarketplaceItems,
	SKILLS_HUB_EMPTY,
} from "../../src/interactive/overlays/skills-hub.js";
import { clioTheme, GLYPH } from "../../src/interactive/theme/index.js";

const ESC = String.fromCharCode(27);
const stripAnsi = (text: string): string => text.replace(new RegExp(`${ESC}\\[[0-9;]*m`, "g"), "");

function makeSkill(overrides: Partial<Skill> & { name: string }): Skill {
	const base = {
		description: `${overrides.name} description`,
		filePath: `/repo/skills/${overrides.name}/SKILL.md`,
		baseDir: `/repo/skills/${overrides.name}`,
		content: `---\nname: ${overrides.name}\n---\nBody of ${overrides.name}`,
		sourceInfo: { path: `/repo/skills/${overrides.name}/SKILL.md`, scope: "project" } as Skill["sourceInfo"],
		disableModelInvocation: false,
		source: "clio" as Skill["source"],
		scope: "project" as Skill["scope"],
		hash: "0".repeat(64),
		pathSubject: `/repo/skills/${overrides.name}`,
		trusted: true,
		precedence: 0,
		metadata: {},
	};
	return { ...base, ...overrides } as Skill;
}

function makeList(items: Skill[], diagnostics: ResourceList<Skill>["diagnostics"] = []): ResourceList<Skill> {
	return { items, diagnostics };
}

describe("contracts/skills-hub", () => {
	it("groups installed skills by scope with origin meta", () => {
		const items = buildInstalledItems(
			makeList([
				makeSkill({ name: "clio-dev", scope: "project" as Skill["scope"] }),
				makeSkill({ name: "hlab", scope: "user" as Skill["scope"], source: "claude" as Skill["source"] }),
			]),
		);
		deepStrictEqual(
			items.map((item) => item.group),
			["Project", "User"],
		);
		strictEqual(items[0]?.meta, "project/clio");
		strictEqual(items[1]?.meta, "user/claude");
	});

	it("marks untrusted skills and diagnostic-affected skills in meta", () => {
		const skill = makeSkill({ name: "sketchy", trusted: false });
		const items = buildInstalledItems(
			makeList([skill], [{ type: "warning", message: "bad frontmatter", path: skill.filePath }]),
		);
		strictEqual(stripAnsi(items[0]?.meta ?? ""), `project/clio · untrusted · ${GLYPH.warnInline}`);
		ok(items[0]?.meta?.includes(clioTheme().fgSequence("warning")), "diagnostic mark uses the warning token");
	});

	it("detail pane includes invocation, source path, diagnostics, and body", () => {
		const skill = makeSkill({ name: "clio-test" });
		const items = buildInstalledItems(
			makeList([skill], [{ type: "warning", message: "stale pin", path: skill.filePath }]),
		);
		const detail = items[0]?.detail?.() ?? [];
		const joined = detail.join("\n");
		ok(joined.includes("/skill:clio-test [task]"));
		ok(joined.includes(skill.filePath));
		ok(joined.includes("stale pin"));
		ok(joined.includes("Body of clio-test"));
	});

	it("diagnostics render as their own group", () => {
		const items = buildDiagnosticItems(
			makeList([], [{ type: "error", message: "unreadable SKILL.md", path: "/repo/broken/SKILL.md" }]),
		);
		strictEqual(items.length, 1);
		strictEqual(items[0]?.group, "Diagnostics");
		strictEqual(items[0]?.meta, "/repo/broken/SKILL.md");
		strictEqual(stripAnsi(items[0]?.label ?? ""), `${GLYPH.error} unreadable SKILL.md`);
		ok(items[0]?.label.includes(clioTheme().fgSequence("error")), "error diagnostics use the error token");
		ok((items[0]?.detail?.() ?? []).join("\n").includes("unreadable SKILL.md"));
	});
});

function seedCatalog(files: Record<string, string>): string {
	const root = mkdtempSync(path.join(tmpdir(), "clio-skills-hub-"));
	for (const [rel, content] of Object.entries(files)) {
		const full = path.join(root, rel);
		mkdirSync(path.dirname(full), { recursive: true });
		writeFileSync(full, content, "utf8");
	}
	return root;
}

function skillFile(name: string): string {
	return `---\nname: ${name}\ndescription: ${name} description\nversion: 0.1.0\n---\nBody of ${name}\n`;
}

// The hub used to list a remote GitHub directory listing while the installer and
// `/skill:<name>` resolved through the local marketplace, so every row it drew in
// a fresh environment failed both advertised paths. These pin the hub to the one
// lookup that can resolve what it lists.
describe("contracts/skills-hub marketplace rows", () => {
	it("lists exactly the entries the install resolver finds for the same lookup", () => {
		const cwd = seedCatalog({
			"skills/alpha/SKILL.md": skillFile("alpha"),
			"skills/research/beta/SKILL.md": skillFile("beta"),
		});
		const discovery = discoverMarketplaceSkills({ cwd, indexPath: null });
		const items = buildMarketplaceItems(discovery.skills, new Set());

		deepStrictEqual(
			items.map((item) => item.id),
			getMarketplaceSkills({ cwd, indexPath: null }).map((skill) => `marketplace:${skill.name}`),
		);
		deepStrictEqual(items.map((item) => item.label).sort(), ["alpha", "beta"]);
		strictEqual(items[0]?.group, "Marketplace");
		strictEqual(items[0]?.meta, "catalog · v0.1.0");

		const detail = (items.find((item) => item.label === "beta")?.detail?.() ?? []).join("\n");
		ok(detail.includes("/skill:beta [task]"), detail);
		ok(detail.includes(path.join(cwd, "skills", "research", "beta")), detail);
		ok(detail.includes("beta description"), detail);
	});

	it("drops a marketplace entry that is already installed", () => {
		const cwd = seedCatalog({ "skills/alpha/SKILL.md": skillFile("alpha") });
		const discovery = discoverMarketplaceSkills({ cwd, indexPath: null });
		deepStrictEqual(buildMarketplaceItems(discovery.skills, new Set(["alpha"])), []);
	});

	it("has no rows and no diagnostic row when nothing is configured", () => {
		const cwd = seedCatalog({ "README.md": "no skills here\n" });
		const discovery = discoverMarketplaceSkills({ cwd, indexPath: null });

		strictEqual(discovery.status, "unavailable");
		deepStrictEqual(discovery.diagnostics, [MARKETPLACE_UNCONFIGURED]);
		deepStrictEqual(buildMarketplaceItems(discovery.skills, new Set()), []);
		// The unconfigured case is the empty state, not a diagnostic row; a row
		// here would fill the list and suppress the empty state that names the remedy.
		deepStrictEqual(buildDiagnosticItems({ items: [], diagnostics: [] }, discovery.diagnostics), []);
	});

	it("keeps a real marketplace failure as its own diagnostic row", () => {
		const cwd = seedCatalog({ "index.json": "{not json" });
		const discovery = discoverMarketplaceSkills({ cwd, indexPath: path.join(cwd, "index.json") });
		const items = buildDiagnosticItems({ items: [], diagnostics: [] }, discovery.diagnostics);

		strictEqual(items.length, 1);
		strictEqual(items[0]?.group, "Diagnostics");
		strictEqual(items[0]?.meta, "marketplace");
		ok(items[0]?.label.includes("skill marketplace index unreadable"), items[0]?.label);
	});

	it("renders the empty state with the remedy when the hub has nothing to list", () => {
		const view = new ListOverlayView(
			{ title: "Skills", items: [], filterable: true, layout: "split", emptyMessage: SKILLS_HUB_EMPTY, onClose: () => {} },
			() => {},
		);
		const ESC_PATTERN = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");
		const rendered = view.render(80).map((line) => line.replace(ESC_PATTERN, ""));
		const body = rendered
			.filter((line) => line.trim().length > 0)
			.map((line) => line.trim())
			.join(" ");

		ok(body.includes("no skills installed and no local marketplace configured"), body);
		ok(body.includes("clio skills install"), body);
		ok(body.includes("CLIO_SKILL_CATALOG_DIR"), body);
		ok(!body.includes("…"), `the remedy must not be cut: ${body}`);
	});
});
