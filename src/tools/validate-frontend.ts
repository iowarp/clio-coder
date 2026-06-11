import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Script } from "node:vm";
import { Type } from "typebox";
import {
	combineSafeOutput,
	runCommandVector,
	SAFE_EXEC_DEFAULT_MAX_OUTPUT_BYTES,
	SAFE_EXEC_DEFAULT_TIMEOUT_MS,
} from "../core/safe-exec.js";
import { ToolNames } from "../core/tool-names.js";
import { resolveReadPath } from "./path-utils.js";
import type { ToolResult, ToolResultDetails, ToolSpec } from "./registry.js";
import { stringEnum } from "./string-enum.js";
import { truncateUtf8 } from "./truncate-utf8.js";

const BROWSER_MODES = ["auto", "required", "off"] as const;
type BrowserMode = (typeof BROWSER_MODES)[number];

type CheckStatus = "pass" | "warn" | "fail" | "skip";

interface FrontendCheck {
	name: string;
	status: CheckStatus;
	message: string;
	path?: string;
}

interface ValidationOptions {
	timeoutMs: number;
	maxOutputBytes: number;
	signal?: AbortSignal;
}

const VOID_HTML_TAGS = new Set([
	"area",
	"base",
	"br",
	"col",
	"embed",
	"hr",
	"img",
	"input",
	"link",
	"meta",
	"param",
	"source",
	"track",
	"wbr",
]);
const RAW_TEXT_TAGS = new Set(["script", "style", "textarea", "title"]);
const JAVASCRIPT_TYPES = new Set([
	"",
	"module",
	"text/javascript",
	"application/javascript",
	"application/ecmascript",
	"text/ecmascript",
]);

export const validateFrontendTool: ToolSpec = {
	name: ToolNames.ValidateFrontend,
	description:
		"Validate an HTML, CSS, or JavaScript artifact without shell access: structure, local references, syntax, and an optional headless-browser load.",
	parameters: Type.Object({
		path: Type.String({ description: "File under the workspace root." }),
		browser: Type.Optional(stringEnum(BROWSER_MODES, "Headless browser check (default auto).")),
		timeout_ms: Type.Optional(Type.Number({ description: "Timeout ms per subprocess." })),
	}),
	baseActionClass: "execute",
	executionMode: "sequential",
	async run(args, options) {
		return runValidateFrontend(args, options);
	},
};

async function runValidateFrontend(
	args: Record<string, unknown>,
	options?: { signal?: AbortSignal },
): Promise<ToolResult> {
	const pathArg = typeof args.path === "string" ? args.path.trim() : "";
	if (pathArg.length === 0) return { kind: "error", message: "validate_frontend: missing path argument" };

	let artifactPath: string;
	try {
		artifactPath = resolveReadPath(pathArg);
	} catch (err) {
		return { kind: "error", message: `validate_frontend: ${err instanceof Error ? err.message : String(err)}` };
	}
	if (!isInsideWorkspace(artifactPath)) {
		return { kind: "error", message: `validate_frontend: path escapes workspace root: ${artifactPath}` };
	}

	if (!existsSync(artifactPath)) return { kind: "error", message: `validate_frontend: file not found: ${artifactPath}` };
	if (!statSync(artifactPath).isFile())
		return { kind: "error", message: `validate_frontend: not a file: ${artifactPath}` };

	const browserMode = browserModeArg(args.browser);
	const validateOptions: ValidationOptions = {
		timeoutMs: timeoutArg(args),
		maxOutputBytes: maxOutputArg(args),
	};
	if (options?.signal !== undefined) validateOptions.signal = options.signal;

	const checks: FrontendCheck[] = [];
	try {
		await validateArtifact(artifactPath, checks, browserMode, validateOptions);
	} catch (err) {
		checks.push({
			name: "validation",
			status: "fail",
			message: err instanceof Error ? err.message : String(err),
			path: artifactPath,
		});
	}

	const failed = checks.filter((check) => check.status === "fail");
	const details = resultDetails(artifactPath, browserMode, checks);
	const output = renderChecks(artifactPath, checks);
	if (failed.length > 0) {
		return {
			kind: "error",
			message: `validate_frontend: ${failed.length} check${failed.length === 1 ? "" : "s"} failed\n${output}`,
			details,
		};
	}
	return { kind: "ok", output, details };
}

async function validateArtifact(
	artifactPath: string,
	checks: FrontendCheck[],
	browserMode: BrowserMode,
	options: ValidationOptions,
): Promise<void> {
	const ext = path.extname(artifactPath).toLowerCase();
	const content = readFileSync(artifactPath, "utf8");
	if (ext === ".html" || ext === ".htm") {
		await validateHtml(artifactPath, content, checks, browserMode, options);
		return;
	}
	if (ext === ".css") {
		validateCss(content, `${artifactPath}`, checks, artifactPath);
		return;
	}
	if (isJavaScriptPath(artifactPath)) {
		await validateJavaScriptFile(artifactPath, content, checks, options);
		return;
	}
	checks.push({
		name: "artifact type",
		status: "fail",
		message: "expected an .html, .htm, .css, .js, .mjs, or .cjs artifact",
		path: artifactPath,
	});
}

async function validateHtml(
	artifactPath: string,
	content: string,
	checks: FrontendCheck[],
	browserMode: BrowserMode,
	options: ValidationOptions,
): Promise<void> {
	validateHtmlStructure(content, checks, artifactPath);
	await validateHtmlScripts(artifactPath, content, checks, options);
	validateHtmlStyles(artifactPath, content, checks);
	await validateBrowserLoad(artifactPath, browserMode, checks, options);
}

function validateHtmlStructure(content: string, checks: FrontendCheck[], artifactPath: string): void {
	const tagRe = /<\/?\s*([a-zA-Z][\w:-]*)(?:\s[^<>]*)?>/g;
	const stack: Array<{ tag: string; line: number }> = [];
	for (let match = tagRe.exec(content); match !== null; match = tagRe.exec(content)) {
		const raw = match[0];
		if (/^<!|^<\?/u.test(raw)) continue;
		const tag = (match[1] ?? "").toLowerCase();
		const isClosing = /^<\//u.test(raw);
		const selfClosing = /\/\s*>$/u.test(raw) || VOID_HTML_TAGS.has(tag);
		if (isClosing) {
			const last = stack.pop();
			if (!last || last.tag !== tag) {
				const expected = last ? ` expected </${last.tag}> from line ${last.line}` : "";
				checks.push({
					name: "html structure",
					status: "fail",
					message: `unexpected </${tag}> on line ${lineAt(content, match.index)}${expected}`,
					path: artifactPath,
				});
				return;
			}
			continue;
		}
		if (selfClosing) continue;
		if (RAW_TEXT_TAGS.has(tag)) {
			const closeRe = new RegExp(`</\\s*${escapeRegExp(tag)}\\s*>`, "giu");
			closeRe.lastIndex = tagRe.lastIndex;
			const close = closeRe.exec(content);
			if (!close) {
				checks.push({
					name: "html structure",
					status: "fail",
					message: `missing </${tag}> for opening tag on line ${lineAt(content, match.index)}`,
					path: artifactPath,
				});
				return;
			}
			tagRe.lastIndex = close.index + close[0].length;
			continue;
		}
		stack.push({ tag, line: lineAt(content, match.index) });
	}
	const unclosed = stack.pop();
	if (unclosed) {
		checks.push({
			name: "html structure",
			status: "fail",
			message: `missing </${unclosed.tag}> for opening tag on line ${unclosed.line}`,
			path: artifactPath,
		});
		return;
	}
	checks.push({ name: "html structure", status: "pass", message: "tag structure is balanced", path: artifactPath });
}

async function validateHtmlScripts(
	artifactPath: string,
	content: string,
	checks: FrontendCheck[],
	options: ValidationOptions,
): Promise<void> {
	const scriptRe = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/giu;
	let count = 0;
	for (let match = scriptRe.exec(content); match !== null; match = scriptRe.exec(content)) {
		count += 1;
		const attrs = parseAttributes(match[1] ?? "");
		const type = normalizeScriptType(attrs.type);
		const src = attrs.src;
		if (src !== undefined) {
			if (!JAVASCRIPT_TYPES.has(type)) {
				checks.push({ name: "script reference", status: "skip", message: `non-JavaScript script type skipped: ${type}` });
				continue;
			}
			const local = resolveLocalReference(artifactPath, src);
			if (local === null) {
				checks.push({
					name: "script reference",
					status: "skip",
					message: `external or root-relative script skipped: ${src}`,
				});
				continue;
			}
			if (!isInsideWorkspace(local)) {
				checks.push({
					name: "script reference",
					status: "fail",
					message: `script escapes workspace root: ${src}`,
					path: local,
				});
				continue;
			}
			if (!existsSync(local)) {
				checks.push({ name: "script reference", status: "fail", message: `script not found: ${src}`, path: local });
				continue;
			}
			await validateJavaScriptFile(local, readFileSync(local, "utf8"), checks, options);
			continue;
		}
		if (!JAVASCRIPT_TYPES.has(type)) {
			checks.push({ name: "inline script", status: "skip", message: `non-JavaScript script type skipped: ${type}` });
			continue;
		}
		const source = (match[2] ?? "").trim();
		if (source.length === 0) {
			checks.push({ name: "inline script", status: "skip", message: `inline script ${count} is empty` });
			continue;
		}
		await validateJavaScript(
			source,
			type === "module" ? "module" : "script",
			`${artifactPath} inline script ${count}`,
			checks,
			options,
			artifactPath,
		);
	}
	if (count === 0)
		checks.push({ name: "script validation", status: "skip", message: "no script tags found", path: artifactPath });
}

function validateHtmlStyles(artifactPath: string, content: string, checks: FrontendCheck[]): void {
	const styleRe = /<style\b[^>]*>([\s\S]*?)<\/style\s*>/giu;
	let styleCount = 0;
	for (let styleMatch = styleRe.exec(content); styleMatch !== null; styleMatch = styleRe.exec(content)) {
		styleCount += 1;
		validateCss(styleMatch[1] ?? "", `${artifactPath} inline style ${styleCount}`, checks, artifactPath);
	}

	const linkRe = /<link\b([^>]*)>/giu;
	let stylesheetCount = 0;
	for (let linkMatch = linkRe.exec(content); linkMatch !== null; linkMatch = linkRe.exec(content)) {
		const attrs = parseAttributes(linkMatch[1] ?? "");
		if (!isStylesheetLink(attrs)) continue;
		stylesheetCount += 1;
		const href = attrs.href;
		if (href === undefined) {
			checks.push({
				name: "stylesheet reference",
				status: "fail",
				message: "stylesheet link is missing href",
				path: artifactPath,
			});
			continue;
		}
		const local = resolveLocalReference(artifactPath, href);
		if (local === null) {
			checks.push({
				name: "stylesheet reference",
				status: "skip",
				message: `external or root-relative stylesheet skipped: ${href}`,
			});
			continue;
		}
		if (!isInsideWorkspace(local)) {
			checks.push({
				name: "stylesheet reference",
				status: "fail",
				message: `stylesheet escapes workspace root: ${href}`,
				path: local,
			});
			continue;
		}
		if (!existsSync(local)) {
			checks.push({ name: "stylesheet reference", status: "fail", message: `stylesheet not found: ${href}`, path: local });
			continue;
		}
		validateCss(readFileSync(local, "utf8"), `${local}`, checks, local);
	}

	if (styleCount === 0 && stylesheetCount === 0) {
		checks.push({
			name: "style validation",
			status: "skip",
			message: "no style tags or stylesheet links found",
			path: artifactPath,
		});
	}
}

async function validateJavaScriptFile(
	filePath: string,
	content: string,
	checks: FrontendCheck[],
	options: ValidationOptions,
): Promise<void> {
	const ext = path.extname(filePath).toLowerCase();
	if (ext === ".mjs") {
		await validateJavaScript(content, "module", filePath, checks, options, filePath);
		return;
	}
	if (ext === ".cjs") {
		await validateJavaScript(content, "script", filePath, checks, options, filePath);
		return;
	}
	const scriptCheck = checkClassicJavaScript(content, filePath);
	if (scriptCheck === null) {
		checks.push({ name: "javascript syntax", status: "pass", message: "classic script syntax is valid", path: filePath });
		return;
	}
	const moduleCheck = await checkModuleJavaScript(content, filePath, options);
	if (moduleCheck === null) {
		checks.push({ name: "javascript syntax", status: "pass", message: "module syntax is valid", path: filePath });
		return;
	}
	checks.push({
		name: "javascript syntax",
		status: "fail",
		message: `script parse failed: ${scriptCheck}; module parse failed: ${moduleCheck}`,
		path: filePath,
	});
}

async function validateJavaScript(
	source: string,
	mode: "script" | "module",
	label: string,
	checks: FrontendCheck[],
	options: ValidationOptions,
	filePath?: string,
): Promise<void> {
	const error =
		mode === "module" ? await checkModuleJavaScript(source, label, options) : checkClassicJavaScript(source, label);
	if (error === null) {
		checks.push({
			name: "javascript syntax",
			status: "pass",
			message: `${mode} syntax is valid: ${label}`,
			...(filePath !== undefined ? { path: filePath } : {}),
		});
		return;
	}
	checks.push({
		name: "javascript syntax",
		status: "fail",
		message: `${mode} syntax error in ${label}: ${error}`,
		...(filePath !== undefined ? { path: filePath } : {}),
	});
}

function checkClassicJavaScript(source: string, label: string): string | null {
	try {
		new Script(source, { filename: label });
		return null;
	} catch (err) {
		return err instanceof Error ? err.message : String(err);
	}
}

async function checkModuleJavaScript(
	source: string,
	label: string,
	options: ValidationOptions,
): Promise<string | null> {
	const dir = mkdtempSync(path.join(tmpdir(), "clio-frontend-check-"));
	const file = path.join(dir, "module.mjs");
	try {
		writeFileSync(file, source, "utf8");
		const result = await runCommandVector(process.execPath, ["--check", file], {
			timeoutMs: options.timeoutMs,
			maxOutputBytes: options.maxOutputBytes,
			...(options.signal !== undefined ? { signal: options.signal } : {}),
		});
		if (result.exitCode === 0 && !result.timedOut && !result.aborted && !result.outputCapped) return null;
		return `${label}: ${truncateUtf8(combineSafeOutput(result).trim(), 600, " [truncated]") || "node --check failed"}`;
	} catch (err) {
		return err instanceof Error ? err.message : String(err);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

function validateCss(source: string, label: string, checks: FrontendCheck[], filePath: string): void {
	let depth = 0;
	let quote: "'" | '"' | null = null;
	let escaped = false;
	let inComment = false;
	for (let index = 0; index < source.length; index += 1) {
		const char = source[index];
		const next = source[index + 1];
		if (inComment) {
			if (char === "*" && next === "/") {
				inComment = false;
				index += 1;
			}
			continue;
		}
		if (quote !== null) {
			if (escaped) {
				escaped = false;
				continue;
			}
			if (char === "\\") {
				escaped = true;
				continue;
			}
			if (char === quote) quote = null;
			continue;
		}
		if (char === "/" && next === "*") {
			inComment = true;
			index += 1;
			continue;
		}
		if (char === "'" || char === '"') {
			quote = char;
			continue;
		}
		if (char === "{") depth += 1;
		if (char === "}") {
			if (depth === 0) {
				checks.push({
					name: "css syntax",
					status: "fail",
					message: `unexpected } in ${label} on line ${lineAt(source, index)}`,
					path: filePath,
				});
				return;
			}
			depth -= 1;
		}
	}
	if (inComment) {
		checks.push({ name: "css syntax", status: "fail", message: `unterminated comment in ${label}`, path: filePath });
		return;
	}
	if (quote !== null) {
		checks.push({ name: "css syntax", status: "fail", message: `unterminated string in ${label}`, path: filePath });
		return;
	}
	if (depth !== 0) {
		checks.push({ name: "css syntax", status: "fail", message: `unclosed { block in ${label}`, path: filePath });
		return;
	}
	checks.push({ name: "css syntax", status: "pass", message: `balanced CSS syntax: ${label}`, path: filePath });
}

async function validateBrowserLoad(
	artifactPath: string,
	browserMode: BrowserMode,
	checks: FrontendCheck[],
	options: ValidationOptions,
): Promise<void> {
	if (browserMode === "off") {
		checks.push({ name: "browser load", status: "skip", message: "browser check disabled", path: artifactPath });
		return;
	}
	const browser = findBrowserExecutable();
	if (browser === null) {
		checks.push({
			name: "browser load",
			status: browserMode === "required" ? "fail" : "warn",
			message: "no supported headless browser executable found on PATH",
			path: artifactPath,
		});
		return;
	}
	const result = await runCommandVector(
		browser,
		[
			"--headless=new",
			"--disable-gpu",
			"--no-sandbox",
			"--disable-dev-shm-usage",
			"--dump-dom",
			pathToFileURL(artifactPath).href,
		],
		{
			timeoutMs: options.timeoutMs,
			maxOutputBytes: options.maxOutputBytes,
			...(options.signal !== undefined ? { signal: options.signal } : {}),
		},
	);
	if (result.exitCode === 0 && !result.timedOut && !result.aborted && !result.outputCapped) {
		checks.push({
			name: "browser load",
			status: "pass",
			message: `loaded with ${path.basename(browser)}`,
			path: artifactPath,
		});
		return;
	}
	const output = truncateUtf8(combineSafeOutput(result).trim(), 800, " [truncated]");
	checks.push({
		name: "browser load",
		status: "fail",
		message: `headless browser exited with ${result.exitCode ?? result.signal ?? "unknown"}${output ? `: ${output}` : ""}`,
		path: artifactPath,
	});
}

function parseAttributes(source: string): Record<string, string> {
	const attrs: Record<string, string> = {};
	const attrRe = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
	for (let match = attrRe.exec(source); match !== null; match = attrRe.exec(source)) {
		const name = (match[1] ?? "").toLowerCase();
		if (name.length === 0) continue;
		attrs[name] = match[2] ?? match[3] ?? match[4] ?? "";
	}
	return attrs;
}

function normalizeScriptType(value: string | undefined): string {
	if (value === undefined) return "";
	const normalized = value.split(";")[0]?.trim().toLowerCase() ?? "";
	return normalized === "text/javascript" ? "text/javascript" : normalized;
}

function isStylesheetLink(attrs: Record<string, string>): boolean {
	const rel = attrs.rel?.toLowerCase().split(/\s+/u) ?? [];
	return rel.includes("stylesheet");
}

function resolveLocalReference(baseFile: string, raw: string): string | null {
	const trimmed = raw.trim();
	if (trimmed.length === 0 || trimmed.startsWith("#")) return null;
	if (/^(?:[a-z][a-z0-9+.-]*:)?\/\//iu.test(trimmed)) return null;
	if (/^(?:data|mailto|tel|javascript):/iu.test(trimmed)) return null;
	if (trimmed.startsWith("/")) return null;
	const withoutFragment = trimmed.split("#")[0] ?? "";
	const withoutQuery = withoutFragment.split("?")[0] ?? "";
	if (withoutQuery.length === 0) return null;
	try {
		return path.resolve(path.dirname(baseFile), decodeURIComponent(withoutQuery));
	} catch {
		return path.resolve(path.dirname(baseFile), withoutQuery);
	}
}

function isJavaScriptPath(filePath: string): boolean {
	const ext = path.extname(filePath).toLowerCase();
	return ext === ".js" || ext === ".mjs" || ext === ".cjs";
}

function isInsideWorkspace(filePath: string): boolean {
	const rel = path.relative(process.cwd(), filePath);
	return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function browserModeArg(value: unknown): BrowserMode {
	return typeof value === "string" && (BROWSER_MODES as ReadonlyArray<string>).includes(value)
		? (value as BrowserMode)
		: "auto";
}

function timeoutArg(args: Record<string, unknown>): number {
	return typeof args.timeout_ms === "number" && args.timeout_ms > 0
		? Math.floor(args.timeout_ms)
		: SAFE_EXEC_DEFAULT_TIMEOUT_MS;
}

function maxOutputArg(args: Record<string, unknown>): number {
	return typeof args.max_output_bytes === "number" && args.max_output_bytes > 0
		? Math.floor(args.max_output_bytes)
		: SAFE_EXEC_DEFAULT_MAX_OUTPUT_BYTES;
}

function resultDetails(
	artifactPath: string,
	browserMode: BrowserMode,
	checks: ReadonlyArray<FrontendCheck>,
): ToolResultDetails {
	return {
		action: "validate_frontend",
		path: artifactPath,
		browserMode,
		status: checks.some((check) => check.status === "fail") ? "failed" : "passed",
		checks: checks.map((check) => ({ ...check })),
	};
}

function renderChecks(artifactPath: string, checks: ReadonlyArray<FrontendCheck>): string {
	const lines = [
		`validate_frontend: ${checks.some((check) => check.status === "fail") ? "failed" : "ok"}`,
		`artifact: ${artifactPath}`,
		"checks:",
	];
	for (const check of checks) {
		const location = check.path ? ` (${check.path})` : "";
		lines.push(`- ${check.status} ${check.name}${location}: ${check.message}`);
	}
	return `${lines.join("\n")}\n`;
}

function findBrowserExecutable(): string | null {
	const candidates = ["chromium", "chromium-browser", "google-chrome", "google-chrome-stable", "microsoft-edge"];
	const pathEnv = process.env.PATH ?? "";
	for (const dir of pathEnv.split(path.delimiter)) {
		if (dir.length === 0) continue;
		for (const candidate of candidates) {
			const full = path.join(dir, candidate);
			if (existsSync(full)) return full;
		}
	}
	return null;
}

function lineAt(text: string, index: number): number {
	let line = 1;
	for (let i = 0; i < index; i += 1) {
		if (text.charCodeAt(i) === 10) line += 1;
	}
	return line;
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
