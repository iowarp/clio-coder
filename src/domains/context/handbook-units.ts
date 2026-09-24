/**
 * CLIO-CODER.md compiled into routable rule units.
 *
 * The main session preloads the whole handbook, but a fleet worker gets a small
 * budget, and a blind prefix of the file hands a GUI coder the first invariants
 * and never the GUI recipe. Compiling splits each H2 section into rule units
 * (one per list item or paragraph) and derives two things per unit, so authors
 * write plain Markdown and nothing else:
 *
 * - audience, from the section title: invariants reach every worker, release
 *   rules reach git-master, orchestrator rules never leave the main session;
 * - path scope, from the backticked paths the rule already cites, which the
 *   bootstrap citation rule forces every generated line to carry.
 *
 * A section may override both with `<!-- clio: audience=verify paths=vendor/** -->`
 * on the line after its heading. Units become `ProjectRule`s so path activation
 * shares one matcher with `.clio-coder/rules`.
 */
import { createHash } from "node:crypto";
import { isAbsolute, relative } from "node:path";
import type { AgentCapabilityClass } from "../agents/spec.js";
import { type ProjectRule, selectActiveRules } from "./project-rules.js";

export type HandbookAudience = "all" | "write" | "verify" | "docs" | "git" | "orchestrator";

export interface HandbookUnit {
	/** Section slug plus a content hash, stable while the rule text is unchanged. */
	id: string;
	section: string;
	audience: readonly HandbookAudience[];
	/** Derived or declared globs; absent means the rule applies anywhere. */
	paths?: string[];
	/** The rule's exact Markdown lines. */
	text: string;
}

export interface CompiledHandbook {
	path: string;
	title: string | null;
	identity: string;
	units: HandbookUnit[];
}

const AUDIENCES: ReadonlyArray<HandbookAudience> = ["all", "write", "verify", "docs", "git", "orchestrator"];

/** First match wins; unmatched titles are code-facing (conventions, recipes, gotchas). */
const SECTION_AUDIENCE: ReadonlyArray<readonly [RegExp, readonly HandbookAudience[]]> = [
	[/invariant/i, ["all"]],
	[/operat|harness|orchestrat|routing|fleet/i, ["orchestrator"]],
	[/\bgit\b|release|commit|branch|publish/i, ["git"]],
	[/\bdocs?\b|documentation|prose|changelog/i, ["docs", "write"]],
	[/test|verif|\bci\b|lint|check/i, ["verify", "write"]],
];
const DEFAULT_AUDIENCE: readonly HandbookAudience[] = ["write", "verify"];

const FENCE_RE = /^\s{0,3}(`{3,}|~{3,})/;
const ITEM_RE = /^\s{0,3}(?:[-*+]|\d+[.)])\s+/;
const OVERRIDE_RE = /^<!--\s*clio:\s*(.*?)\s*-->$/;
const CODE_TOKEN_RE = /`([^`\n]+)`/g;
const GLOB_CHARS = /[*?[\]{}<>]/;

function audienceForTitle(title: string): readonly HandbookAudience[] {
	for (const [pattern, audience] of SECTION_AUDIENCE) if (pattern.test(title)) return audience;
	return DEFAULT_AUDIENCE;
}

/**
 * The literal directory a cited path lives under, as a `dir/**` glob. One
 * segment (`src/`, `docs/`) scopes nothing useful and is ignored; a command,
 * an absolute or home path, a URL and an npm scope are not repository paths.
 */
function scopeGlob(token: string): string | null {
	const cleaned = token
		.trim()
		.replace(/:\d+(?:-\d+)?$/, "")
		.replace(/^\.\//, "");
	if (!cleaned.includes("/") || /\s/.test(cleaned) || /^[~/@]|:\/\//.test(cleaned)) return null;
	const segments = cleaned.split("/");
	const isDirectory = cleaned.endsWith("/");
	if (isDirectory) segments.pop();
	const anchor: string[] = [];
	for (const [index, segment] of segments.entries()) {
		if (segment.length === 0 || GLOB_CHARS.test(segment)) break;
		const last = index === segments.length - 1;
		if (last && !isDirectory && segment.includes(".")) break;
		anchor.push(segment);
	}
	return anchor.length >= 2 ? `${anchor.join("/")}/**` : null;
}

function derivedPaths(text: string): string[] | undefined {
	const globs = new Set<string>();
	for (const match of text.matchAll(CODE_TOKEN_RE)) {
		const glob = match[1] ? scopeGlob(match[1]) : null;
		if (glob) globs.add(glob);
	}
	// A rule citing `apps/web/package.json` and `apps/web/tests/` is one GUI rule.
	const anchors = [...globs].map((glob) => glob.slice(0, -2));
	const outermost = [...globs].filter((glob) => {
		const anchor = glob.slice(0, -2);
		return !anchors.some((other) => other !== anchor && anchor.startsWith(other));
	});
	return outermost.length > 0 ? outermost.sort() : undefined;
}

interface SectionOverride {
	audience?: HandbookAudience[];
	paths?: string[] | null;
}

function parseOverride(line: string): SectionOverride | null {
	const match = OVERRIDE_RE.exec(line.trim());
	if (!match) return null;
	const override: SectionOverride = {};
	for (const pair of (match[1] ?? "").split(/\s+/)) {
		const [key, value = ""] = pair.split("=", 2);
		const values = value
			.split(",")
			.map((entry) => entry.trim())
			.filter((entry) => entry.length > 0);
		if (key === "audience" || key === "roles") {
			const audience = values.filter((entry): entry is HandbookAudience => AUDIENCES.includes(entry as HandbookAudience));
			if (audience.length > 0) override.audience = audience;
		}
		if (key === "paths") override.paths = values.length === 0 || values[0] === "none" ? null : values;
	}
	return override;
}

function slug(title: string): string {
	return (
		title
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-|-$/g, "") || "preamble"
	);
}

/**
 * Split a handbook into rule units. Returns null when no H2 section holds a
 * rule, so a prose handbook keeps its verbatim delivery.
 */
export function compileHandbook(source: string, path: string): CompiledHandbook | null {
	const lines = source.replace(/\r\n?/g, "\n").split("\n");
	let title: string | null = null;
	const identityLines: string[] = [];
	let identityDone = false;
	let section: string | null = null;
	let override: SectionOverride | null = null;
	let awaitingOverride = false;
	let current: string[] = [];
	let fence: string | null = null;
	const units: HandbookUnit[] = [];

	const flush = (): void => {
		const text = current.join("\n").trim();
		current = [];
		if (section === null || text.length === 0) return;
		const audience = override?.audience ?? audienceForTitle(section);
		const paths = override && override.paths !== undefined ? (override.paths ?? undefined) : derivedPaths(text);
		const hash = createHash("sha256").update(text).digest("hex").slice(0, 8);
		units.push({ id: `${slug(section)}#${hash}`, section, audience, ...(paths ? { paths } : {}), text });
	};

	for (const line of lines) {
		if (fence !== null) {
			current.push(line);
			if (line.trim().startsWith(fence)) fence = null;
			continue;
		}
		const fenceOpen = FENCE_RE.exec(line);
		if (fenceOpen?.[1]) {
			fence = fenceOpen[1];
			// A fence belongs to the rule it follows; outside a section it is prose.
			current.push(line);
			continue;
		}
		const heading = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
		if (heading?.[1] === "#" && title === null && section === null) {
			title = heading[2] ?? null;
			continue;
		}
		if (heading?.[1] === "##") {
			flush();
			section = (heading[2] ?? "").trim();
			override = null;
			awaitingOverride = true;
			identityDone = true;
			continue;
		}
		if (section === null) {
			if (!identityDone) {
				if (line.trim().length === 0) {
					if (identityLines.length > 0) identityDone = true;
				} else identityLines.push(line.trim());
			}
			continue;
		}
		if (awaitingOverride && line.trim().length > 0) {
			awaitingOverride = false;
			const parsed = parseOverride(line);
			if (parsed) {
				override = parsed;
				continue;
			}
		}
		if (ITEM_RE.test(line)) {
			flush();
			current.push(line);
			continue;
		}
		if (line.trim().length === 0) {
			// A blank line ends a paragraph rule, but an item's indented
			// continuation or trailing fence may still follow it.
			if (current.length > 0 && !ITEM_RE.test(current[0] ?? "")) flush();
			else if (current.length > 0) current.push(line);
			continue;
		}
		if (/^\s{2,}\S/.test(line) || current.length > 0) {
			if (current.length > 0 && ITEM_RE.test(current[0] ?? "") && !/^\s/.test(line) && current.at(-1) === "") {
				flush();
			}
			current.push(line);
			continue;
		}
		current.push(line);
	}
	flush();
	if (units.length === 0) return null;
	return { path, title, identity: identityLines.join(" "), units };
}

/** Which handbook audiences a fleet worker serves, by recipe id first, then capability class. */
export function workerHandbookAudience(
	agentId: string | null | undefined,
	capabilityClass: AgentCapabilityClass | null | undefined,
): HandbookAudience[] {
	switch (agentId) {
		case "git-master":
			return ["git", "write"];
		case "documenter":
		case "wiki-writer":
			return ["docs", "write"];
		case "tester":
		case "verifier":
		case "debugger":
			return ["verify", "write"];
	}
	switch (capabilityClass) {
		case "verification":
			return ["verify"];
		case "artifact-write":
			return ["write", "docs"];
		case "orchestration":
			return ["write", "verify", "docs", "git", "orchestrator"];
		case "internal":
			return [];
		default:
			return ["write", "verify"];
	}
}

export interface WorkerHandbookSelection {
	text: string;
	selected: number;
	total: number;
}

function asRule(unit: HandbookUnit, sourcePath: string): ProjectRule {
	return {
		id: unit.id,
		sourcePath,
		hash: unit.id,
		tokenEstimate: Math.ceil(unit.text.length / 4),
		...(unit.paths ? { paths: unit.paths } : {}),
		enabled: true,
		body: unit.text,
	};
}

function relativeWorkingPaths(cwd: string, paths: ReadonlyArray<string>): string[] {
	const normalized = new Set<string>();
	for (const path of paths) {
		const rel = isAbsolute(path) ? relative(cwd, path) : path;
		if (!rel || rel.startsWith("..") || isAbsolute(rel)) continue;
		normalized.add(rel.replace(/\\/g, "/"));
	}
	return [...normalized];
}

/**
 * Choose the rules one worker should see and render them within `maxChars`.
 * A scoped rule whose paths miss a declared dispatch scope is never sent.
 * Output keeps document order, so the prompt prefix is stable for one scope,
 * and names every section with an unselected rule.
 */
export function selectWorkerHandbook(
	handbooks: ReadonlyArray<CompiledHandbook>,
	options: {
		audience: ReadonlyArray<HandbookAudience>;
		cwd: string;
		workingPaths: ReadonlyArray<string>;
		maxChars: number;
	},
): WorkerHandbookSelection {
	const workingPaths = relativeWorkingPaths(options.cwd, options.workingPaths);
	const serves = (unit: HandbookUnit): boolean => {
		if (unit.audience.includes("orchestrator") && !options.audience.includes("orchestrator")) return false;
		return unit.audience.some((entry) => entry === "all" || options.audience.includes(entry));
	};
	// The first audience is the worker's own trade: git-master's release rules
	// must not lose their room to the general write rules that precede them.
	const primary = options.audience[0];
	// Nearest handbook first within each tier; the ancestor chain renders first.
	// Tiers: invariants, path matches, primary unscoped, primary scoped when the
	// dispatch named no paths, then the same two for secondary audiences.
	const tiers: HandbookUnit[][] = [[], [], [], [], [], []];
	for (const handbook of [...handbooks].reverse()) {
		const matched = new Set(
			selectActiveRules(
				handbook.units.filter((unit) => unit.paths).map((unit) => asRule(unit, handbook.path)),
				workingPaths,
			).map((rule) => rule.id),
		);
		for (const unit of handbook.units) {
			if (unit.audience.includes("all")) tiers[0]?.push(unit);
			else if (!serves(unit)) continue;
			else if (unit.paths && matched.has(unit.id)) tiers[1]?.push(unit);
			else if (unit.paths && workingPaths.length > 0) continue;
			else {
				const offset = primary !== undefined && unit.audience.includes(primary) ? 2 : 4;
				tiers[offset + (unit.paths ? 1 : 0)]?.push(unit);
			}
		}
	}

	const chosen = new Set<HandbookUnit>();
	const render = (): string => {
		const blocks: string[] = [];
		for (const handbook of handbooks) {
			const kept = handbook.units.filter((unit) => chosen.has(unit));
			const omitted = [...new Set(handbook.units.filter((unit) => !chosen.has(unit)).map((unit) => unit.section))];
			const lines = [`<project-handbook path="${handbook.path}" rules="${kept.length}/${handbook.units.length}">`];
			if (handbook.title) lines.push(`# ${handbook.title}`);
			if (handbook.identity) lines.push(handbook.identity);
			let lastSection: string | null = null;
			for (const unit of kept) {
				if (unit.section !== lastSection) {
					lines.push("", `## ${unit.section}`);
					lastSection = unit.section;
				}
				lines.push(unit.text);
			}
			if (omitted.length > 0) {
				lines.push(
					"",
					`Rules not selected for this task, from: ${omitted.join("; ")}. Read ${handbook.path} if the task reaches them.`,
				);
			}
			lines.push("</project-handbook>");
			blocks.push(lines.join("\n"));
		}
		return blocks.join("\n\n");
	};

	// Invariants are a strict prefix: nothing of lower priority may take the room
	// an invariant needed. Later tiers fill greedily around what does not fit.
	let text = render();
	packing: for (const [index, tier] of tiers.entries()) {
		for (const unit of tier) {
			chosen.add(unit);
			const next = render();
			if (next.length <= options.maxChars) {
				text = next;
				continue;
			}
			chosen.delete(unit);
			if (index === 0) break packing;
		}
	}
	const total = handbooks.reduce((sum, handbook) => sum + handbook.units.length, 0);
	return { text: text.length <= options.maxChars ? text : "", selected: chosen.size, total };
}
