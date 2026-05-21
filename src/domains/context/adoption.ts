import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, extname, join, relative, resolve, sep } from "node:path";

export type AdoptionProvider = "claude-code" | "codex" | "gemini" | "cursor" | "copilot";
export type AdoptionScope = "project" | "global";
export type AdoptionSourceKind = "instructions" | "settings" | "command" | "agent" | "skill" | "rule";

export interface AdoptionSourceSnapshot {
	path: string;
	scope: AdoptionScope;
	provider: AdoptionProvider;
	kind: AdoptionSourceKind;
	sha256: string;
}

export interface AdoptionSource {
	path: string;
	displayPath: string;
	scope: AdoptionScope;
	provider: AdoptionProvider;
	providerLabel: string;
	kind: AdoptionSourceKind;
	kindLabel: string;
	content: string;
	contentSha256: string;
	byteLength: number;
	itemCount: number;
	order: number;
}

export interface AdoptionRejectedSource {
	path: string;
	displayPath: string;
	scope: AdoptionScope;
	provider?: AdoptionProvider;
	reason: string;
}

export interface AdoptedAgentRule {
	text: string;
	sources: string[];
	providers: string[];
	conflictKey?: string;
}

export interface AdoptionConflict {
	key: string;
	kept: string;
	keptSources: string[];
	skipped: Array<{ text: string; source: string; provider: string }>;
}

export interface AdoptionScanResult {
	cwd: string;
	homeDir: string;
	includeGlobal: boolean;
	sources: AdoptionSource[];
	rejected: AdoptionRejectedSource[];
	importedRules: AdoptedAgentRule[];
	conflicts: AdoptionConflict[];
	sourceHash: string;
	sourceSnapshots: AdoptionSourceSnapshot[];
}

export interface AdoptionScanOptions {
	cwd: string;
	homeDir?: string;
	includeGlobal?: boolean;
}

interface CandidateSpec {
	path: string;
	scope: AdoptionScope;
	provider: AdoptionProvider;
	kind: AdoptionSourceKind;
	order: number;
}

interface ExtractedRuleCandidate {
	text: string;
	source: AdoptionSource;
	index: number;
	conflict?: { key: string; value: string };
}

const MAX_SOURCE_BYTES = 128 * 1024;
const MAX_RECURSIVE_FILES = 80;
const MAX_RULES_PER_SOURCE = 4;
const MAX_IMPORTED_RULES = 20;

const PROVIDER_LABELS: Record<AdoptionProvider, string> = {
	"claude-code": "Claude Code",
	codex: "Codex",
	gemini: "Gemini",
	cursor: "Cursor",
	copilot: "GitHub Copilot",
};

const KIND_LABELS: Record<AdoptionSourceKind, string> = {
	instructions: "instructions",
	settings: "settings",
	command: "command",
	agent: "agent",
	skill: "skill",
	rule: "rule",
};

const GENERATED_OR_SECRET_DIRS = new Set([
	".git",
	".clio",
	".antigravitycli",
	"node_modules",
	"dist",
	"build",
	"target",
	".venv",
	"venv",
	"cache",
	"caches",
	"history",
	"histories",
	"sessions",
	"logs",
	"tmp",
	"temp",
	"state",
	"projects",
]);

const UNSAFE_FILE_NAME_RE =
	/(^\.env(?:\.|$)|secret|credential|token|password|history|cache|session|\.log$|state\.json$)/i;
const RULE_KEYWORDS =
	/\b(always|never|must|should|prefer|avoid|do not|don't|use|run|keep|write|allow|allows|deny|denies|enable|enables|define|defines)\b/i;
const SECRET_LINE_PATTERNS = [
	/-----BEGIN [A-Z ]*PRIVATE KEY-----/i,
	/\bauthorization\s*[:=]\s*bearer\s+\S+/i,
	/\b(?:api[_-]?key|auth[_-]?token|access[_-]?token|refresh[_-]?token|password|secret|credential)\b\s*[:=]\s*["']?[^\s"'`,;]{8,}/i,
	/\b(?:ghp|gho|ghu|ghs|github_pat)_[A-Za-z0-9_]{20,}\b/,
	/\bsk-[A-Za-z0-9_-]{20,}\b/,
	/\bxox[baprs]-[A-Za-z0-9-]{20,}\b/,
	/\bAIza[0-9A-Za-z_-]{20,}\b/,
];

function sha256(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

function normalizeText(text: string): string {
	return text
		.replace(/^\uFEFF/, "")
		.replace(/\r\n/g, "\n")
		.replace(/\r/g, "\n");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSubpath(parent: string, child: string): boolean {
	const rel = relative(parent, child);
	return rel === "" || (!rel.startsWith("..") && !rel.includes(`..${sep}`));
}

function displayPath(filePath: string, cwd: string, home: string): string {
	const abs = resolve(filePath);
	const cwdAbs = resolve(cwd);
	const homeAbs = resolve(home);
	if (isSubpath(cwdAbs, abs)) {
		const rel = relative(cwdAbs, abs).split(sep).join("/");
		return rel.length > 0 ? rel : basename(abs);
	}
	if (isSubpath(homeAbs, abs)) {
		const rel = relative(homeAbs, abs).split(sep).join("/");
		return rel.length > 0 ? `~/${rel}` : "~";
	}
	return abs;
}

function unsafePathName(filePath: string): boolean {
	const name = basename(filePath);
	return UNSAFE_FILE_NAME_RE.test(name);
}

function safeDirEntryName(name: string): boolean {
	const lower = name.toLowerCase();
	if (GENERATED_OR_SECRET_DIRS.has(lower)) return false;
	if (lower.includes("secret") || lower.includes("credential") || lower.includes("token")) return false;
	return true;
}

function hasSecretLikeLine(text: string): boolean {
	for (const line of text.split("\n")) {
		if (SECRET_LINE_PATTERNS.some((pattern) => pattern.test(line))) return true;
	}
	return false;
}

function maybeFile(path: string): boolean {
	try {
		return lstatSync(path).isFile();
	} catch {
		return false;
	}
}

function collectFiles(
	dir: string,
	maxDepth: number,
	accept: (filePath: string) => boolean,
	out: string[] = [],
	depth = 0,
): string[] {
	if (out.length >= MAX_RECURSIVE_FILES) return out;
	let entries: import("node:fs").Dirent[];
	try {
		entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
	} catch {
		return out;
	}
	for (const entry of entries) {
		if (out.length >= MAX_RECURSIVE_FILES) break;
		if (entry.isSymbolicLink()) continue;
		const filePath = join(dir, entry.name);
		if (entry.isDirectory()) {
			if (depth >= maxDepth || !safeDirEntryName(entry.name)) continue;
			collectFiles(filePath, maxDepth, accept, out, depth + 1);
			continue;
		}
		if (!entry.isFile()) continue;
		if (unsafePathName(filePath)) continue;
		if (accept(filePath)) out.push(filePath);
	}
	return out;
}

function markdownLike(filePath: string): boolean {
	const ext = extname(filePath).toLowerCase();
	return ext === ".md" || ext === ".mdc";
}

function jsonLike(filePath: string): boolean {
	return extname(filePath).toLowerCase() === ".json";
}

function discoverCandidateSpecs(cwd: string, home: string, includeGlobal: boolean): CandidateSpec[] {
	const specs: CandidateSpec[] = [];
	const seen = new Set<string>();
	let order = 0;
	const add = (path: string, scope: AdoptionScope, provider: AdoptionProvider, kind: AdoptionSourceKind): void => {
		const abs = resolve(path);
		if (seen.has(abs)) return;
		seen.add(abs);
		specs.push({ path: abs, scope, provider, kind, order });
		order += 1;
	};
	const addProject = (relPath: string, provider: AdoptionProvider, kind: AdoptionSourceKind): void => {
		add(join(cwd, relPath), "project", provider, kind);
	};
	const addProjectDir = (
		relPath: string,
		provider: AdoptionProvider,
		kind: AdoptionSourceKind,
		maxDepth: number,
		accept: (filePath: string) => boolean,
	): void => {
		for (const filePath of collectFiles(join(cwd, relPath), maxDepth, accept)) add(filePath, "project", provider, kind);
	};

	addProject("CLAUDE.md", "claude-code", "instructions");
	addProject(join(".claude", "CLAUDE.md"), "claude-code", "instructions");
	addProject(join(".claude", "settings.json"), "claude-code", "settings");
	addProjectDir(join(".claude", "commands"), "claude-code", "command", 3, markdownLike);
	addProjectDir(join(".claude", "agents"), "claude-code", "agent", 2, markdownLike);

	addProject("AGENTS.md", "codex", "instructions");
	addProject("CODEX.md", "codex", "instructions");
	addProject(join(".codex", "AGENTS.md"), "codex", "instructions");
	addProjectDir(join(".codex", "skills"), "codex", "skill", 4, markdownLike);

	addProject("GEMINI.md", "gemini", "instructions");
	addProject(join(".gemini", "GEMINI.md"), "gemini", "instructions");
	addProject(join(".gemini", "settings.json"), "gemini", "settings");
	addProject(join(".gemini", "config.json"), "gemini", "settings");
	addProjectDir(
		join(".gemini", "rules"),
		"gemini",
		"rule",
		2,
		(filePath) => markdownLike(filePath) || jsonLike(filePath),
	);
	addProjectDir(
		join(".gemini", "config"),
		"gemini",
		"rule",
		2,
		(filePath) => markdownLike(filePath) || jsonLike(filePath),
	);

	addProjectDir(join(".cursor", "rules"), "cursor", "rule", 0, markdownLike);
	addProject(join(".github", "copilot-instructions.md"), "copilot", "instructions");

	if (includeGlobal) add(join(home, ".codex", "AGENTS.md"), "global", "codex", "instructions");

	return specs.filter((spec) => existsSync(spec.path));
}

function stripFrontmatter(text: string): string {
	if (!text.startsWith("---\n")) return text;
	const end = text.indexOf("\n---", 4);
	if (end === -1) return text;
	return text.slice(end + "\n---".length).replace(/^\n+/, "");
}

function stripCodeFences(text: string): string {
	const lines: string[] = [];
	let inFence = false;
	for (const line of text.split("\n")) {
		if (/^\s*```/.test(line)) {
			inFence = !inFence;
			continue;
		}
		if (!inFence) lines.push(line);
	}
	return lines.join("\n");
}

function cleanRuleText(raw: string): string | null {
	let text = raw
		.replace(/<!--.*?-->/g, "")
		.replace(/^\[[ xX]\]\s+/, "")
		.replace(/\s+/g, " ")
		.trim();
	text = text.replace(/^[#>\s]+/, "").trim();
	if (text.length < 8 || text.length > 260) return null;
	if (/^(todo|note|example|marker)\b/i.test(text)) return null;
	if (!RULE_KEYWORDS.test(text)) return null;
	if (hasSecretLikeLine(text)) return null;
	if (text.length > 200) text = `${text.slice(0, 197).trimEnd()}…`;
	return text;
}

function extractMarkdownRules(content: string): string[] {
	const text = stripCodeFences(stripFrontmatter(content));
	const rules: string[] = [];
	const seen = new Set<string>();
	for (const line of text.split("\n")) {
		const trimmed = line.trim();
		if (trimmed.length === 0 || trimmed.startsWith("|") || /^#{1,6}\s/.test(trimmed)) continue;
		const bullet = /^(?:[-*+]\s+|\d+\.\s+)(.+?)\s*$/.exec(trimmed)?.[1] ?? null;
		const candidate = bullet ?? (/^[A-Z][^.!?]{8,220}[.!?]?$/.test(trimmed) ? trimmed : null);
		if (!candidate) continue;
		const cleaned = cleanRuleText(candidate);
		if (!cleaned) continue;
		const key = normalizeRuleKey(cleaned);
		if (seen.has(key)) continue;
		seen.add(key);
		rules.push(cleaned);
		if (rules.length >= MAX_RULES_PER_SOURCE) break;
	}
	return rules;
}

function stringArray(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value
		.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
		.map((item) => item.trim());
}

function stringField(record: Record<string, unknown>, key: string): string | null {
	const value = record[key];
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function formatShortList(items: ReadonlyArray<string>, limit = 4): string {
	const cleaned = items.map((item) => item.replace(/\s+/g, " ").trim()).filter(Boolean);
	const shown = cleaned.slice(0, limit).map((item) => `\`${item.length > 48 ? `${item.slice(0, 45)}…` : item}\``);
	if (cleaned.length > limit) shown.push(`+${cleaned.length - limit} more`);
	return shown.join(", ");
}

function extractSettingsRules(provider: AdoptionProvider, content: string): string[] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(content);
	} catch {
		return [];
	}
	if (!isRecord(parsed)) return [];
	const rules: string[] = [];
	if (provider === "claude-code") {
		const permissions = parsed.permissions;
		if (isRecord(permissions)) {
			const allow = stringArray(permissions.allow);
			const deny = stringArray(permissions.deny);
			const defaultMode = stringField(permissions, "defaultMode");
			if (allow.length > 0) rules.push(`Claude Code allows tools: ${formatShortList(allow)}.`);
			if (deny.length > 0) rules.push(`Claude Code denies tools: ${formatShortList(deny)}.`);
			if (defaultMode) rules.push(`Claude Code uses permission mode \`${defaultMode}\` for this project.`);
		}
		if (parsed.enableAllProjectMcpServers === true) rules.push("Claude Code enables all project MCP servers.");
	}
	if (provider === "gemini") {
		const contextFileName = stringField(parsed, "contextFileName");
		if (contextFileName) rules.push(`Gemini uses \`${contextFileName}\` as an additional context file.`);
		const mcpServers = parsed.mcpServers;
		if (isRecord(mcpServers) && Object.keys(mcpServers).length > 0) {
			rules.push(`Gemini project settings define MCP servers: ${formatShortList(Object.keys(mcpServers))}.`);
		}
	}
	return rules.map((rule) => cleanRuleText(rule)).filter((rule): rule is string => Boolean(rule));
}

function extractRules(spec: CandidateSpec, content: string): string[] {
	if (spec.kind === "settings" || jsonLike(spec.path)) return extractSettingsRules(spec.provider, content);
	return extractMarkdownRules(content);
}

function normalizeRuleKey(text: string): string {
	return text
		.toLowerCase()
		.replace(/`([^`]+)`/g, "$1")
		.replace(/[^a-z0-9.+:#/-]+/g, " ")
		.replace(/\s+/g, " ")
		.trim()
		.replace(/[.!?]+$/, "");
}

function classifyConflict(text: string): { key: string; value: string } | undefined {
	const normalized = text.toLowerCase().replace(/`/g, "");
	const packageManager =
		/\b(?:always\s+|must\s+|should\s+|prefer\s+|use\s+|run\s+)*(?:use|prefer|run)\s+(pnpm|npm|yarn|bun)\b/.exec(
			normalized,
		);
	if (packageManager?.[1]) return { key: "package-manager", value: packageManager[1] };
	const testRunner =
		/\b(?:always\s+|must\s+|should\s+|prefer\s+|use\s+|run\s+)*(?:use|prefer|run)\s+(node:test|vitest|jest|pytest|cargo test|go test)\b/.exec(
			normalized,
		);
	if (testRunner?.[1]) return { key: "test-runner", value: testRunner[1] };
	return undefined;
}

function sourcePriority(source: AdoptionSource): number {
	return (source.scope === "project" ? 0 : 10_000) + source.order;
}

function buildImportPlan(sources: ReadonlyArray<AdoptionSource>): {
	importedRules: AdoptedAgentRule[];
	conflicts: AdoptionConflict[];
} {
	const candidates: ExtractedRuleCandidate[] = [];
	for (const source of sources) {
		const rules = extractRules(
			{ path: source.path, scope: source.scope, provider: source.provider, kind: source.kind, order: 0 },
			source.content,
		);
		rules.forEach((text, index) => {
			const conflict = classifyConflict(text);
			candidates.push({ text, source, index, ...(conflict ? { conflict } : {}) });
		});
	}
	candidates.sort((a, b) => {
		const sourceDelta = sourcePriority(a.source) - sourcePriority(b.source);
		return sourceDelta !== 0 ? sourceDelta : a.index - b.index;
	});

	const accepted: AdoptedAgentRule[] = [];
	const byNormalizedText = new Map<string, AdoptedAgentRule>();
	const byConflictKey = new Map<string, { value: string; rule: AdoptedAgentRule }>();
	const conflicts = new Map<string, AdoptionConflict>();

	for (const candidate of candidates) {
		const normalized = normalizeRuleKey(candidate.text);
		const existing = byNormalizedText.get(normalized);
		if (existing) {
			if (!existing.sources.includes(candidate.source.displayPath)) existing.sources.push(candidate.source.displayPath);
			if (!existing.providers.includes(candidate.source.providerLabel))
				existing.providers.push(candidate.source.providerLabel);
			continue;
		}

		if (candidate.conflict) {
			const prior = byConflictKey.get(candidate.conflict.key);
			if (prior && prior.value !== candidate.conflict.value) {
				let conflict = conflicts.get(candidate.conflict.key);
				if (!conflict) {
					conflict = {
						key: candidate.conflict.key,
						kept: prior.rule.text,
						keptSources: [...prior.rule.sources],
						skipped: [],
					};
					conflicts.set(candidate.conflict.key, conflict);
				}
				conflict.skipped.push({
					text: candidate.text,
					source: candidate.source.displayPath,
					provider: candidate.source.providerLabel,
				});
				continue;
			}
		}

		const rule: AdoptedAgentRule = {
			text: candidate.text,
			sources: [candidate.source.displayPath],
			providers: [candidate.source.providerLabel],
			...(candidate.conflict ? { conflictKey: candidate.conflict.key } : {}),
		};
		accepted.push(rule);
		byNormalizedText.set(normalized, rule);
		if (candidate.conflict) byConflictKey.set(candidate.conflict.key, { value: candidate.conflict.value, rule });
		if (accepted.length >= MAX_IMPORTED_RULES) break;
	}

	return { importedRules: accepted, conflicts: [...conflicts.values()] };
}

function readCandidate(spec: CandidateSpec, cwd: string, home: string): AdoptionSource | AdoptionRejectedSource | null {
	const shown = displayPath(spec.path, cwd, home);
	if (unsafePathName(spec.path)) {
		return {
			path: spec.path,
			displayPath: shown,
			scope: spec.scope,
			provider: spec.provider,
			reason: "unsafe path name",
		};
	}
	let stat: import("node:fs").Stats;
	try {
		const lst = lstatSync(spec.path);
		if (lst.isSymbolicLink()) {
			return {
				path: spec.path,
				displayPath: shown,
				scope: spec.scope,
				provider: spec.provider,
				reason: "symlink skipped",
			};
		}
		stat = statSync(spec.path);
	} catch {
		return null;
	}
	if (!stat.isFile()) return null;
	if (stat.size > MAX_SOURCE_BYTES) {
		return { path: spec.path, displayPath: shown, scope: spec.scope, provider: spec.provider, reason: "file too large" };
	}
	let raw: string;
	try {
		raw = readFileSync(spec.path, "utf8");
	} catch {
		return { path: spec.path, displayPath: shown, scope: spec.scope, provider: spec.provider, reason: "unreadable" };
	}
	if (raw.includes("\0")) {
		return { path: spec.path, displayPath: shown, scope: spec.scope, provider: spec.provider, reason: "binary content" };
	}
	const content = normalizeText(raw);
	if (hasSecretLikeLine(content)) {
		return {
			path: spec.path,
			displayPath: shown,
			scope: spec.scope,
			provider: spec.provider,
			reason: "secret-like content",
		};
	}
	const rules = extractRules(spec, content);
	return {
		path: spec.path,
		displayPath: shown,
		scope: spec.scope,
		provider: spec.provider,
		providerLabel: PROVIDER_LABELS[spec.provider],
		kind: spec.kind,
		kindLabel: KIND_LABELS[spec.kind],
		content,
		contentSha256: sha256(content),
		byteLength: Buffer.byteLength(content, "utf8"),
		itemCount: rules.length,
		order: spec.order,
	};
}

function sourceSetHash(snapshots: ReadonlyArray<AdoptionSourceSnapshot>): string {
	const hash = createHash("sha256");
	for (const snapshot of snapshots) {
		hash.update(`${snapshot.scope}\0${snapshot.provider}\0${snapshot.kind}\0${snapshot.path}\0${snapshot.sha256}\n`);
	}
	return hash.digest("hex");
}

export function adoptionSnapshotsHash(snapshots: ReadonlyArray<AdoptionSourceSnapshot>): string {
	return sourceSetHash([...snapshots].sort((a, b) => a.path.localeCompare(b.path)));
}

export function scanAgentConfigs(options: AdoptionScanOptions): AdoptionScanResult {
	const cwd = resolve(options.cwd);
	const home = resolve(options.homeDir ?? homedir());
	const includeGlobal = options.includeGlobal === true;
	const sources: AdoptionSource[] = [];
	const rejected: AdoptionRejectedSource[] = [];
	for (const spec of discoverCandidateSpecs(cwd, home, includeGlobal)) {
		const result = readCandidate(spec, cwd, home);
		if (!result) continue;
		if ("content" in result) sources.push(result);
		else rejected.push(result);
	}
	sources.sort((a, b) => {
		const scopeDelta = (a.scope === "project" ? 0 : 1) - (b.scope === "project" ? 0 : 1);
		return scopeDelta !== 0 ? scopeDelta : a.order - b.order;
	});
	const plan = buildImportPlan(sources);
	const sourceSnapshots = sources.map((source) => ({
		path: source.path,
		scope: source.scope,
		provider: source.provider,
		kind: source.kind,
		sha256: source.contentSha256,
	}));
	return {
		cwd,
		homeDir: home,
		includeGlobal,
		sources,
		rejected,
		importedRules: plan.importedRules,
		conflicts: plan.conflicts,
		sourceHash: sourceSetHash(sourceSnapshots),
		sourceSnapshots,
	};
}

function renderSourceList(paths: ReadonlyArray<string>): string {
	if (paths.length <= 3) return paths.map((path) => `\`${path}\``).join(", ");
	return `${paths
		.slice(0, 3)
		.map((path) => `\`${path}\``)
		.join(", ")} +${paths.length - 3} more`;
}

function quoteShort(text: string): string {
	const cleaned = text.replace(/\s+/g, " ").trim();
	return `“${cleaned.length > 120 ? `${cleaned.slice(0, 117).trimEnd()}…` : cleaned}”`;
}

export function renderImportedAgentContext(scan: AdoptionScanResult): string {
	if (scan.sources.length === 0 && scan.rejected.length === 0) return "";
	const lines: string[] = [
		"Conflict policy: CLIO.md conventions and hard invariants are canonical; project-local imports win over explicit global imports; duplicate rules are merged by normalized text.",
		"",
		"### Adopted rules",
		"",
	];
	if (scan.importedRules.length === 0) {
		lines.push("- No project-specific rules were adopted from external agent configs.");
	} else {
		for (const rule of scan.importedRules) {
			lines.push(`- ${rule.text} Sources: ${renderSourceList(rule.sources)}.`);
		}
	}

	lines.push("", "### Source provenance", "");
	for (const source of scan.sources) {
		const adopted = source.itemCount === 1 ? "1 candidate" : `${source.itemCount} candidates`;
		lines.push(`- ${source.providerLabel} ${source.kindLabel} (${source.scope}): \`${source.displayPath}\`; ${adopted}.`);
	}
	if (scan.sources.length === 0) lines.push("- No supported project-local agent config files were found.");

	if (scan.conflicts.length > 0) {
		lines.push("", "### Skipped conflicts", "");
		for (const conflict of scan.conflicts) {
			for (const skipped of conflict.skipped) {
				lines.push(
					`- ${quoteShort(skipped.text)} from \`${skipped.source}\` conflicted with ${renderSourceList(conflict.keptSources)} on ${conflict.key}; kept ${quoteShort(conflict.kept)}.`,
				);
			}
		}
	}

	if (scan.rejected.length > 0) {
		lines.push("", "### Rejected sources", "");
		for (const rejected of scan.rejected.slice(0, 8)) {
			const provider = rejected.provider ? `${PROVIDER_LABELS[rejected.provider]} ` : "";
			lines.push(`- ${provider}\`${rejected.displayPath}\`: skipped ${rejected.reason}.`);
		}
		if (scan.rejected.length > 8) lines.push(`- ${scan.rejected.length - 8} more rejected sources omitted.`);
	}
	return lines.join("\n");
}

export function adoptionSourcesChanged(snapshots: ReadonlyArray<AdoptionSourceSnapshot>): boolean {
	for (const snapshot of snapshots) {
		if (!maybeFile(snapshot.path)) return true;
		let content: string;
		try {
			content = normalizeText(readFileSync(snapshot.path, "utf8"));
		} catch {
			return true;
		}
		if (sha256(content) !== snapshot.sha256) return true;
	}
	return false;
}
