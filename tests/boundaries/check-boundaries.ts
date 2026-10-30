import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

export interface BoundaryCheckResult {
	violations: string[];
}

/** Provider usage in messages/ledger payloads is immutable outside engine adapters (#434). */
export function checkLedgerUsageMutation(file: string, source: string): string[] {
	if (file.startsWith("src/engine/")) return [];
	const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
	const aliases = new Set<string>();
	const wholeAliases = new Set<string>();
	const unwrap = (node: ts.Expression): ts.Expression => {
		while (
			ts.isAsExpression(node) ||
			ts.isTypeAssertionExpression(node) ||
			ts.isParenthesizedExpression(node) ||
			ts.isNonNullExpression(node)
		)
			node = node.expression;
		return node;
	};
	const property = (node: ts.Expression): string | undefined => {
		node = unwrap(node);
		return ts.isPropertyAccessExpression(node)
			? node.name.text
			: ts.isElementAccessExpression(node) && ts.isStringLiteral(node.argumentExpression)
				? node.argumentExpression.text
				: undefined;
	};
	const providerUsage = (input: ts.Expression): boolean => {
		const node = unwrap(input);
		if (ts.isIdentifier(node)) return aliases.has(node.text);
		if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken)
			return providerUsage(node.left);
		if (!ts.isPropertyAccessExpression(node) && !ts.isElementAccessExpression(node)) return false;
		return (
			(property(node) === "usage" && /message|payload|\braw\b/i.test(node.expression.getText(tree))) ||
			providerUsage(node.expression)
		);
	};
	const collect = (node: ts.Node): void => {
		if (
			ts.isVariableDeclaration(node) &&
			ts.isIdentifier(node.name) &&
			node.initializer &&
			providerUsage(node.initializer)
		) {
			aliases.add(node.name.text);
			const value = unwrap(node.initializer);
			if (property(value) === "usage" || (ts.isIdentifier(value) && wholeAliases.has(value.text)))
				wholeAliases.add(node.name.text);
		}
		if (
			ts.isVariableDeclaration(node) &&
			ts.isObjectBindingPattern(node.name) &&
			node.initializer &&
			/message|payload|\braw\b/i.test(node.initializer.getText(tree))
		) {
			for (const binding of node.name.elements) {
				if (ts.isIdentifier(binding.name) && (binding.propertyName?.getText(tree) ?? binding.name.text) === "usage") {
					aliases.add(binding.name.text);
					wholeAliases.add(binding.name.text);
				}
			}
		}
		ts.forEachChild(node, collect);
	};
	collect(tree);
	const violations: string[] = [];
	const report = (node: ts.Node) =>
		violations.push(
			`rule12: ${file}:${tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1} mutates provider usage; keep Clio accounting beside the raw usage and link the call journal`,
		);
	const visit = (node: ts.Node): void => {
		if (
			ts.isBinaryExpression(node) &&
			node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
			node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
		) {
			const target = unwrap(node.left);
			if ((ts.isPropertyAccessExpression(target) || ts.isElementAccessExpression(target)) && providerUsage(target)) {
				// The P0 never-sent contract stores null; direct copies preserve provider bytes (#434).
				const copy =
					property(target) === "usage" &&
					node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
					(node.right.kind === ts.SyntaxKind.NullKeyword ||
						(property(node.right) === "usage" && providerUsage(node.right)) ||
						(ts.isIdentifier(unwrap(node.right)) && wholeAliases.has(unwrap(node.right).getText(tree))));
				if (!copy) report(node);
			}
		}
		if (
			(ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
			(node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken) &&
			providerUsage(node.operand)
		)
			report(node);
		if (
			ts.isCallExpression(node) &&
			node.expression.getText(tree) === "Object.assign" &&
			node.arguments[0] &&
			/message|payload|\braw\b/i.test(node.arguments[0].getText(tree))
		) {
			for (const argument of node.arguments.slice(1)) {
				if (
					ts.isObjectLiteralExpression(argument) &&
					argument.properties.some(
						(field) =>
							ts.isPropertyAssignment(field) &&
							field.name.getText(tree).replace(/["']/g, "") === "usage" &&
							field.initializer.kind !== ts.SyntaxKind.NullKeyword,
					)
				)
					report(argument);
			}
		}
		if (ts.isDeleteExpression(node) && providerUsage(node.expression)) report(node);
		if (
			ts.isCallExpression(node) &&
			node.expression.getText(tree) === "Object.assign" &&
			node.arguments[0] &&
			providerUsage(node.arguments[0])
		)
			report(node);
		ts.forEachChild(node, visit);
	};
	visit(tree);
	return violations;
}

/** A key that counts tokens, prices them or annotates their accounting; the provider's own `usage` is not one. */
const USAGE_SHAPED_KEY = /^(?:usage.+|tokens?|cost.*|usd|.+(?:Usage|Tokens|TokenCount|Cost|Usd|Accounting))$/;
/** The modules that build session-ledger message payloads. */
const LEDGER_PAYLOAD_ROOTS = ["src/session-control/", "src/domains/session/"];

/** The ledger is the conversation record and the journal owns usage, so no payload gains a usage-shaped key (#434 §5.1, §5.3). */
export function checkLedgerUsageKeys(file: string, source: string): string[] {
	if (!LEDGER_PAYLOAD_ROOTS.some((root) => file.startsWith(root))) return [];
	const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
	const payloadLike = (node: ts.Node) => /payload/i.test(node.getText(tree));
	const keyOf = (name: ts.Node): string | undefined =>
		ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNoSubstitutionTemplateLiteral(name) ? name.text : undefined;
	const violations: string[] = [];
	const report = (node: ts.Node, key: string) =>
		violations.push(
			`rule12: ${file}:${tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1} puts usage-shaped ${key} on a ledger payload; the ledger is the conversation record and the call journal owns usage`,
		);
	const literalKeys = (literal: ts.ObjectLiteralExpression) => {
		for (const field of literal.properties) {
			const key = field.name && keyOf(field.name);
			if (key !== undefined && USAGE_SHAPED_KEY.test(key)) report(field, key);
		}
	};
	const visit = (node: ts.Node): void => {
		// payload.key = ... and payload["key"] = ...
		if (
			ts.isBinaryExpression(node) &&
			node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
			(ts.isPropertyAccessExpression(node.left) || ts.isElementAccessExpression(node.left)) &&
			payloadLike(node.left.expression)
		) {
			const key = ts.isPropertyAccessExpression(node.left) ? node.left.name.text : keyOf(node.left.argumentExpression);
			if (key !== undefined && USAGE_SHAPED_KEY.test(key)) report(node, key);
		}
		// payload: { key: ... } and const payload = { key: ... }
		if (
			(ts.isPropertyAssignment(node) || ts.isVariableDeclaration(node)) &&
			node.initializer &&
			ts.isObjectLiteralExpression(node.initializer) &&
			payloadLike(node.name)
		)
			literalKeys(node.initializer);
		// Object.assign(payload, { key: ... })
		if (
			ts.isCallExpression(node) &&
			node.expression.getText(tree) === "Object.assign" &&
			node.arguments[0] &&
			payloadLike(node.arguments[0])
		)
			for (const argument of node.arguments.slice(1)) if (ts.isObjectLiteralExpression(argument)) literalKeys(argument);
		// for (const key of ["usage", ...]) payload[key] = ...: the copy list names the keys a payload keeps.
		if (
			ts.isForOfStatement(node) &&
			ts.isArrayLiteralExpression(node.expression) &&
			ts.isVariableDeclarationList(node.initializer)
		) {
			const loopKey = node.initializer.declarations[0]?.name.getText(tree);
			const copies = (child: ts.Node): boolean =>
				(ts.isElementAccessExpression(child) &&
					payloadLike(child.expression) &&
					child.argumentExpression.getText(tree) === loopKey) ||
				ts.forEachChild(child, copies) === true;
			if (loopKey !== undefined && copies(node.statement))
				for (const element of node.expression.elements)
					if (ts.isStringLiteral(element) && USAGE_SHAPED_KEY.test(element.text)) report(element, element.text);
		}
		ts.forEachChild(node, visit);
	};
	visit(tree);
	return violations;
}

/** Applied to the producer's complete local value-import closure, including helper modules (#434). */
export function checkTelemetryProducer(file: string, source: string): string[] {
	const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
	const violations: string[] = [];
	const visit = (node: ts.Node): void => {
		if (ts.isImportDeclaration(node) && !node.importClause?.isTypeOnly && ts.isStringLiteral(node.moduleSpecifier)) {
			const specifier = node.moduleSpecifier.text;
			if (
				/^(?:node:)?(?:fs(?:\/promises)?|sqlite)$/.test(specifier) ||
				/state-file-lock|safe-resource-write/.test(specifier)
			) {
				violations.push(`rule13: ${file} imports persistence on the telemetry producer path (${specifier})`);
			}
		}
		if (
			(ts.isCallExpression(node) || ts.isNewExpression(node)) &&
			/^(?:JSON\.stringify|(?:\w+\.)?(?:appendFileSync|writeSync|DatabaseSync))$/.test(node.expression.getText(tree))
		) {
			violations.push(`rule13: ${file} serializes or performs synchronous I/O on the telemetry producer path`);
		}
		ts.forEachChild(node, visit);
	};
	visit(tree);
	return violations;
}

/** A journal segment, a session's objects/, the trace index or <stateDir>/telemetry/, as a path expression spells it. */
const TELEMETRY_PATH =
	/[/"'`](calls\.(?:[^"'`/\s]*\.)?jsonl|events\.(?:[^"'`/\s]*\.)?ndjson|trace\.sqlite[^"'`/\s]*|objects|telemetry)(?=[/"'`])/;
/** The write call and which of its arguments name a path it writes, creates, moves or removes. */
const PATH_WRITES = new Map<string, number[]>([
	...["writeFile", "appendFile", "createWriteStream", "rm", "rmdir", "unlink", "truncate", "mkdir"].flatMap(
		(name): [string, number[]][] => [
			[name, [0]],
			[`${name}Sync`, [0]],
		],
	),
	...["rename", "copyFile", "cp", "symlink", "link"].flatMap((name): [string, number[]][] => [
		[name, [0, 1]],
		[`${name}Sync`, [0, 1]],
	]),
	["safeResourceWrite", [0]],
	["safeResourceWriteAsync", [0]],
]);

/** Only the observability domain writes under the telemetry paths; every other module goes through its writers (#434 §5.1). */
export function checkTelemetryWrites(file: string, source: string): string[] {
	if (file.startsWith("src/domains/observability/")) return [];
	const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
	// A path is usually built a step or two before the write, so a name expands to what this file assigns it.
	const definitions = new Map<string, ts.Node[]>();
	const define = (name: string, node: ts.Node) => definitions.set(name, [...(definitions.get(name) ?? []), node]);
	const collect = (node: ts.Node): void => {
		if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer)
			define(node.name.text, node.initializer);
		if (ts.isFunctionDeclaration(node) && node.name && node.body) define(node.name.text, node.body);
		ts.forEachChild(node, collect);
	};
	collect(tree);
	const expand = (node: ts.Node, seen: Set<string>): string => {
		let text = node.getText(tree);
		const visit = (child: ts.Node): void => {
			if (ts.isIdentifier(child) && !seen.has(child.text) && seen.size < 8) {
				seen.add(child.text);
				for (const definition of definitions.get(child.text) ?? []) text += ` ${expand(definition, seen)}`;
			}
			ts.forEachChild(child, visit);
		};
		visit(node);
		return text;
	};
	const violations: string[] = [];
	const visit = (node: ts.Node): void => {
		let paths: ts.Expression[] = [];
		if (ts.isCallExpression(node)) {
			const callee = node.expression;
			const name = ts.isPropertyAccessExpression(callee) ? callee.name.text : callee.getText(tree);
			const positions = PATH_WRITES.get(name);
			if (positions) paths = positions.flatMap((index) => node.arguments[index] ?? []);
			// open() writes only with a flag that is not read-only.
			const flags = node.arguments[1];
			if (
				(name === "open" || name === "openSync") &&
				flags &&
				!(ts.isStringLiteral(flags) && /^rs?$/.test(flags.text)) &&
				!/RDONLY/.test(flags.getText(tree))
			)
				paths = [node.arguments[0] as ts.Expression];
		}
		if (
			ts.isNewExpression(node) &&
			node.expression.getText(tree) === "DatabaseSync" &&
			node.arguments?.[0] &&
			!/readOnly:\s*true/.test(node.arguments[1]?.getText(tree) ?? "")
		)
			paths = [node.arguments[0]];
		for (const target of paths) {
			const match = TELEMETRY_PATH.exec(expand(target, new Set()));
			if (!match) continue;
			const line = tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1;
			violations.push(
				`rule11: ${file}:${line} writes under a telemetry path (${match[1]}) outside the observability domain; go through the observability writers`,
			);
			break;
		}
		ts.forEachChild(node, visit);
	};
	visit(tree);
	return violations;
}

/** Guard monetary presentation without confusing token/duration precision or shell dollars (#434). */
export function checkCostRendering(file: string, source: string): string[] {
	if (file === "src/core/telemetry/render.ts") return [];
	const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
	const violations: string[] = [];
	const monetary = /cost|usd|price|spend|amount|dollars|ceiling|budget/i;
	const visit = (node: ts.Node) => {
		let bypass = false;
		if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
			const method = node.expression;
			bypass =
				["toFixed", "toPrecision", "toLocaleString"].includes(method.name.text) &&
				monetary.test(
					ts.isPropertyAccessExpression(method.expression) ? method.expression.name.text : method.expression.getText(tree),
				) &&
				!/tokens|calls|bytes|percent|ms$/i.test(method.expression.getText(tree));
		}
		if (ts.isTemplateExpression(node)) {
			let prefix = node.head.text;
			for (const span of node.templateSpans) {
				const expression = span.expression.getText(tree);
				if (
					prefix.endsWith("$") &&
					(monetary.test(expression) || /\.(?:toFixed|toPrecision|toLocaleString)\(/.test(expression))
				)
					bypass = true;
				prefix = span.literal.text;
			}
		}
		if (
			ts.isPropertyAssignment(node) &&
			node.name.getText(tree) === "style" &&
			ts.isStringLiteral(node.initializer) &&
			node.initializer.text === "currency"
		)
			bypass = true;
		if (ts.isStringLiteral(node) && (/^\$\d+\.\d+(?: local)?$/.test(node.text) || /^cost unknown$/i.test(node.text)))
			bypass = true;
		if (bypass) {
			const line = tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1;
			violations.push(
				`rule10: ${file}:${line} formats money outside core/telemetry/render.ts; use the canonical renderer (renderCostAggregate/renderCostAmount or a DTO display), or a server-rendered GUI display string`,
			);
		}
		ts.forEachChild(node, visit);
	};
	visit(tree);
	return [...new Set(violations)];
}

/** The surfaces whose token and cost figures must be the read model's folds (#434 §11.3). */
const SURFACE_TOTAL_ROOTS = ["src/interactive/", "src/engine/acp/", "src/cli/"];
/**
 * Functions on those surfaces that still fold token or cost fields, each with the reason it may. An exemption that
 * no longer matches a fold fails, so the list only shrinks.
 */
const SURFACE_TOTAL_EXEMPTIONS: ReadonlyArray<{ file: string; functions: readonly string[]; reason: string }> = [
	{
		file: "src/engine/acp/server.ts",
		functions: ["handleChatEvent"],
		reason: "an ACP prompt's output tokens over its generation time make its tok/s rate, a division over measured facts",
	},
	{
		file: "src/engine/acp/adapter.ts",
		functions: ["mergeUsage"],
		reason: "the producer side of a delegated run: it folds the peer's reported deltas into the run's run.usage snapshot",
	},
	{
		file: "src/interactive/status/summary.ts",
		functions: ["foldMessageIntoRunTally"],
		reason:
			"the run's own reasoning count and chars/4 estimate behind the reasoning chip and the receipt, which the call journal does not record; its token fields only pick between a live and a rebuilt summary, and every token display reads the read model",
	},
	{
		file: "src/interactive/session-last-turn.ts",
		functions: ["lastTurnSummaryFromLedger"],
		reason: "rebuilds that same run tally from the ledger on resume, for the reasoning chip the call journal cannot feed",
	},
	{
		file: "src/cli/fleet-board-model.ts",
		functions: ["applyEvent"],
		reason: "the fleet board's live per-run token count follows the run feed's message_end lines as they stream",
	},
	{
		file: "src/cli/modes/print.ts",
		functions: ["addRunUsage"],
		reason:
			"a headless run folds its own calls into the main-agent receipt it seals and the --max-cost-usd cap it enforces",
	},
	{
		file: "src/cli/wiki-generate.ts",
		functions: ["attemptsBreakdown", "invocationUsage"],
		reason: "the wiki generator's footer totals its own workers' sealed receipts for the run it just made",
	},
];

const USAGE_FIELD = /^(?:input|output|cacheRead|cacheWrite|cacheWrite1h|reasoning)$/;
const TOTAL_NAME = /^(?:tokens|tokenCount|usd)$|(?:Tokens|TokenCount|Usd)$/;

/**
 * A surface sums no token or cost field: no `+=`, self-adding assignment, `field: prev.field + x` fold or `.reduce`
 * over one (#434 §11.3). A bare `input`/`output` identifier is not a field, so string building does not trip it.
 */
export function checkSurfaceTotals(file: string, source: string, used?: Set<string>): string[] {
	if (!SURFACE_TOTAL_ROOTS.some((root) => file.startsWith(root))) return [];
	const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
	const violations: string[] = [];
	const unwrap = (node: ts.Expression): ts.Expression => {
		while (
			ts.isAsExpression(node) ||
			ts.isParenthesizedExpression(node) ||
			ts.isNonNullExpression(node) ||
			(ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken)
		)
			node = ts.isBinaryExpression(node) ? node.left : node.expression;
		return node;
	};
	const field = (node: ts.Node): string | undefined =>
		ts.isPropertyAccessExpression(node)
			? node.name.text
			: ts.isElementAccessExpression(node) && ts.isStringLiteral(node.argumentExpression)
				? node.argumentExpression.text
				: undefined;
	const total = (input: ts.Expression): boolean => {
		const node = unwrap(input);
		const name = field(node);
		if (name !== undefined) return TOTAL_NAME.test(name) || USAGE_FIELD.test(name);
		return ts.isIdentifier(node) && TOTAL_NAME.test(node.text);
	};
	const readsTotal = (node: ts.Node): boolean => {
		const name = field(node);
		if (name !== undefined && (TOTAL_NAME.test(name) || USAGE_FIELD.test(name))) return true;
		return ts.forEachChild(node, (child) => readsTotal(child) || undefined) === true;
	};
	const owner = (node: ts.Node): string => {
		for (let at: ts.Node | undefined = node.parent; at; at = at.parent) {
			if ((ts.isFunctionDeclaration(at) || ts.isMethodDeclaration(at)) && at.name) return at.name.getText(tree);
			if ((ts.isArrowFunction(at) || ts.isFunctionExpression(at)) && ts.isVariableDeclaration(at.parent))
				return at.parent.name.getText(tree);
		}
		return "<module>";
	};
	const report = (node: ts.Node) => {
		const fn = owner(node);
		const exemption = SURFACE_TOTAL_EXEMPTIONS.find((entry) => entry.file === file && entry.functions.includes(fn));
		if (exemption) {
			used?.add(`${file}#${fn}`);
			return;
		}
		const line = tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1;
		violations.push(
			`rule14: ${file}:${line} sums a token or cost field in ${fn}; show the read model's quantity display instead, or exempt the function with its reason in SURFACE_TOTAL_EXEMPTIONS`,
		);
	};
	const adds = (node: ts.Expression, target: (operand: ts.Expression) => boolean): boolean => {
		const sum = unwrap(node);
		return (
			ts.isBinaryExpression(sum) &&
			sum.operatorToken.kind === ts.SyntaxKind.PlusToken &&
			(target(sum.left) || target(sum.right) || adds(sum.left, target))
		);
	};
	// `a[k] = (a[k] ?? 0) + (b[k] ?? 0)` folds one record into another field by field under a key no name test can
	// read, as a loop over a list of usage fields does (#434).
	const mergesComputedKey = (target: ts.Expression, sum: ts.Expression): boolean => {
		const left = unwrap(target);
		if (!ts.isElementAccessExpression(left) || ts.isStringLiteral(left.argumentExpression)) return false;
		const key = left.argumentExpression.getText(tree);
		const receiver = left.expression.getText(tree);
		return adds(sum, (operand) => {
			const read = unwrap(operand);
			return (
				ts.isElementAccessExpression(read) &&
				read.argumentExpression.getText(tree) === key &&
				read.expression.getText(tree) !== receiver
			);
		});
	};
	const visit = (node: ts.Node): void => {
		if (ts.isBinaryExpression(node)) {
			const kind = node.operatorToken.kind;
			if (kind === ts.SyntaxKind.PlusEqualsToken && (total(node.left) || readsTotal(node.right))) report(node);
			const target = node.left.getText(tree);
			if (
				kind === ts.SyntaxKind.EqualsToken &&
				(total(node.left) || mergesComputedKey(node.left, node.right)) &&
				adds(node.right, (operand) => unwrap(operand).getText(tree) === target)
			)
				report(node);
		}
		if (ts.isPropertyAssignment(node)) {
			const name = node.name.getText(tree).replace(/["']/g, "");
			if (
				(TOTAL_NAME.test(name) || USAGE_FIELD.test(name)) &&
				adds(node.initializer, (operand) => field(unwrap(operand)) === name)
			)
				report(node);
		}
		if (
			ts.isCallExpression(node) &&
			ts.isPropertyAccessExpression(node.expression) &&
			node.expression.name.text === "reduce" &&
			node.arguments.some((argument) => readsTotal(argument))
		)
			report(node);
		ts.forEachChild(node, visit);
	};
	visit(tree);
	return [...new Set(violations)];
}

const jsSuffixRegex = /\.m?jsx?$/;
const piPackagePrefix = "@earendil-works/pi-";
// Since the 0.83.0 engine-boundary rework, no file outside src/engine/** may
// import @earendil-works/* at all, type-only included. Domains take erased
// engine shapes (EngineModel, Api, Model) from src/engine/types.ts.
const allowedPiTypeImportSpecifiersOutsideEngine = new Set<string>();

function walk(dir: string): string[] {
	let entries: import("node:fs").Dirent[];
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		return [];
	}
	const files: string[] = [];
	for (const entry of entries) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			files.push(...walk(full));
			continue;
		}
		if (entry.isFile() && (full.endsWith(".ts") || full.endsWith(".tsx") || full.endsWith(".mts"))) {
			files.push(full);
		}
	}
	return files;
}

function isWithin(child: string, parent: string): boolean {
	const rel = path.relative(parent, child);
	return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function stripComments(source: string): string {
	let out = source.replace(/\/\*[\s\S]*?\*\//g, "");
	out = out.replace(/(^|[^:/])\/\/.*$/gm, (_match, prefix) => prefix);
	return out;
}

function extractReferenceDirectives(source: string): { kind: "path" | "types"; specifier: string }[] {
	const directives: { kind: "path" | "types"; specifier: string }[] = [];
	const regex = /^\s*\/\/\/\s*<reference\s+(path|types)\s*=\s*["']([^"']+)["']\s*\/?>/gm;
	for (const match of source.matchAll(regex)) {
		const kind = match[1] as "path" | "types";
		const specifier = match[2];
		if (specifier) directives.push({ kind, specifier });
	}
	return directives;
}

interface ExtractedSpecifier {
	specifier: string;
	typeOnly: boolean;
	dynamic: boolean;
}

function isTypeOnlyImportOrExportClause(clause: string): boolean {
	return clause.trim().startsWith("type ");
}

function extractSpecifiers(source: string): ExtractedSpecifier[] {
	const stripped = stripComments(source);
	const specifiers: ExtractedSpecifier[] = [];

	const fromRegex = /\b(import|export)\b([\s\S]*?)\bfrom\s*["']([^"']+)["']/g;
	for (const match of stripped.matchAll(fromRegex)) {
		const clause = match[2] ?? "";
		const specifier = match[3];
		if (!specifier) continue;
		const typeOnly = isTypeOnlyImportOrExportClause(clause);
		specifiers.push({ specifier, typeOnly, dynamic: false });
	}

	const dynRegex = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;
	for (const match of stripped.matchAll(dynRegex)) {
		const specifier = match[1];
		if (specifier) specifiers.push({ specifier, typeOnly: false, dynamic: true });
	}

	return specifiers;
}

function resolveRelativeImport(fromFile: string, specifier: string): string {
	const candidate = path.resolve(path.dirname(fromFile), specifier);
	const tsRewrites: string[] = [];
	if (jsSuffixRegex.test(candidate)) {
		const stripped = candidate.replace(jsSuffixRegex, "");
		tsRewrites.push(`${stripped}.ts`, `${stripped}.tsx`, `${stripped}.mts`);
	}
	const candidates = [
		candidate,
		`${candidate}.ts`,
		`${candidate}.tsx`,
		`${candidate}.mts`,
		path.join(candidate, "index.ts"),
		path.join(candidate, "index.tsx"),
		path.join(candidate, "index.mts"),
		...tsRewrites,
	];
	for (const item of candidates) {
		try {
			if (statSync(item).isFile()) return item;
		} catch {
			// skip
		}
	}
	return candidate;
}

/**
 * The chat loop's turn state machine and its single-owner turn modules in
 * src/session-control. The interactive composition root in index.ts
 * legitimately knows about entry-level wiring; these do not.
 */
function isChatLoopTurnModule(filePath: string): boolean {
	const base = path.basename(filePath);
	return base === "chat-loop.ts" || (base.startsWith("turn-") && base.endsWith(".ts"));
}

/**
 * The instant shell's Stage 0 owner. `tests/contracts/instant-shell-import-graph.test.ts`
 * walks the built chunk that contains this module and holds its static closure
 * to 32 chunks, 1,400,000 total bytes and 350,000 Clio source bytes, because that closure is what a cold
 * `clio-coder` start pays before it can draw anything.
 */
const STAGE_0_OWNER = path.join("src", "interactive", "terminal-lease.ts");

/**
 * Modules an external runtime reacher may enter inside `src/interactive/**`,
 * `src/session-control/**` or `src/engine/**`. The session-control tree holds
 * the turn engine that used to live in `src/interactive/**`, so it keeps the
 * same protection: its chunk membership is part of what Stage 0 is measured on.
 *
 * The first two Stage 0 splits came from `src/cli/**`; the third came from
 * `src/domains/mux/**`. Esbuild responds to both identically: when a module in
 * the instant shell's closure gains a second, disjoint reacher, it peels that
 * module out of the neighbours it used to share a chunk with. Rule 6 therefore
 * guards every value importer outside the computed Stage 0 closure and the two
 * protected trees, not one directory that happened to contain earlier bugs.
 *
 * Every existing edge is declared here with its architectural reason. A seam
 * still fails the closure walk unless it stays off Stage 0. The only explicit
 * overlap exceptions are the Stage 1 composition-root edges that assemble the
 * complete interactive application and already own those dependencies.
 */
interface Stage0Seam {
	/** Project-relative module path, POSIX-separated. */
	module: string;
	/** Why an external runtime reacher legitimately enters through this module. */
	reason: string;
	/** Existing composition roots allowed to overlap Stage 0 through this seam. */
	allowStage0OverlapFrom?: readonly string[];
}

const ORCHESTRATOR = "src/entry/orchestrator.ts";

const STAGE0_SEAMS: ReadonlyArray<Stage0Seam> = [
	{
		module: "src/session-control/index.ts",
		reason:
			"the composition root and transports share permission, restore and model decisions through one render-free in-process contract.",
		allowStage0OverlapFrom: [ORCHESTRATOR],
	},
	{
		module: "src/session-control/turn-outcome-collector.ts",
		reason:
			"the composition root registers a surface-neutral observer whose value closure contains only core, pure turn-control, and tool-call shapes, never terminal rendering.",
	},
	{
		module: "src/interactive/terminal-lease.ts",
		reason:
			"the Stage 0 owner itself. src/cli/clio.ts is the surface that opens the instant shell, so this edge is the budget rather than a leak, and the closure guard below skips it.",
	},
	{
		module: "src/session-control/slash-commands.ts",
		reason:
			"one slash parser and one registry-membership source for both surfaces. The headless refusal in src/cli/run.ts and the TUI editor must agree on which tokens name a command, and a second copy of the parser would drift. The registry's own imports are what the closure guard below watches.",
	},
	{
		module: "src/session-control/chat-loop.ts",
		reason: "the Stage 1 composition root creates the chat loop; CLI event-shape imports are type-only and erase.",
		allowStage0OverlapFrom: [ORCHESTRATOR],
	},
	{
		module: "src/session-control/chat-loop-messages.ts",
		reason:
			"sumRunUsage, the one usage fold both the CLI modes and the TUI report from. Its value closure stays on domains and engine/ai, off the render graph.",
	},
	{
		module: "src/engine/tui-primitives.ts",
		reason:
			"a pure re-export of the three pi-tui symbols src/cli/fleet-view.ts needs. It has no relative imports at all, and boundaries rule1 forbids the CLI importing pi-tui directly, so this module is why fleet-view does not touch the engine tui barrel.",
	},
	{
		module: "src/engine/clipboard.ts",
		reason:
			"the confirmed system clipboard copy (#437) the fullscreen CLI views (fleet view, workers board, extension dock) hand pi-tui as copySelection, so they never flash Copied! for a bare OSC 52. Reached only by dynamic import on the first copy. It has no relative imports at all: its static imports are node built-ins, and pi-tui's native clipboard loads lazily on darwin and win32.",
	},
	{
		module: "src/engine/types.ts",
		reason:
			"the erased engine shapes (AgentMessage, ImageContent) domains and the CLI both take. Type-only at every call site.",
	},
	{
		module: "src/engine/oauth.ts",
		reason:
			"OAuth provider registration for `auth`/`configure` and the prompt shape `oauth-select` renders. Reaches only alcf-oauth, none of it terminal rendering.",
	},
	{
		module: "src/engine/session.ts",
		reason:
			"the canonical session path, atomic-write, and JSONL persistence substrate shared by lifecycle, dispatch, session domains, the CLI, and the Stage 1 composition root; its closure stays off terminal rendering.",
	},
	{
		module: "src/engine/pi-mono-names.ts",
		reason: "the dependency-name table package-root and lifecycle version reporting inspect; a constant-only leaf.",
	},
	{
		module: "src/engine/truncate.ts",
		reason: "surface-neutral byte and display truncation shared by context markers and tools.",
	},
	{
		module: "src/engine/acp/adapter.ts",
		reason: "dispatch translates worker results through the engine-owned ACP protocol adapter.",
	},
	{
		module: "src/engine/acp/server.ts",
		reason: "the Stage 1 composition root owns the ACP server surface.",
	},
	{
		module: "src/engine/acp/deferred-boot.ts",
		reason:
			"the ACP CLI keeps its transport open while the first workspace request selects a root; deferred boot depends only on ACP protocol leaves.",
	},
	{
		module: "src/engine/acp/commands.ts",
		reason:
			"the Stage 1 composition root binds the operator-command control the ACP server takes by structure. The projection value-imports the slash registry, which the root already reaches directly, so it enters the Stage 0 overlap through the same door it already owns rather than through the ACP server seam.",
		allowStage0OverlapFrom: [ORCHESTRATOR],
	},
	{
		module: "src/engine/acp/host-members.ts",
		reason:
			"the ACP host's members for /share, /oracle and /council: the worker-run fold and the oracle briefing the terminal also uses, and the host-made dispatch call. Only the Stage 1 composition root reaches it, the same root that already overlaps Stage 0 through the chat loop.",
		allowStage0OverlapFrom: [ORCHESTRATOR],
	},
	{
		module: "src/engine/acp/transport.ts",
		reason: "the Stage 1 composition root owns ACP stdio transport construction.",
	},
	{
		module: "src/engine/antigravity/subprocess-runtime.ts",
		reason: "dispatch maps autonomy policy into the engine-owned Antigravity subprocess runtime.",
	},
	{
		module: "src/engine/claude/subprocess-runtime.ts",
		reason: "dispatch maps autonomy policy into the engine-owned Claude subprocess runtime.",
	},
	{
		module: "src/engine/claude/tool-safety.ts",
		reason: "dispatch classifies Claude's canonical tool names through the engine adapter that owns them.",
	},
	{
		module: "src/engine/worker-runtime-capabilities.ts",
		reason: "dispatch reads the engine worker's static mediation capability contract.",
	},
	{
		module: "src/engine/env-api-keys.ts",
		reason: "provider authentication uses the engine's environment-key lookup ladder.",
	},
	{
		module: "src/engine/ai.ts",
		reason:
			"provider, session, and tool surfaces use the engine-owned model bridge and error classifiers; its closure is deliberately terminal-free.",
	},
	{
		module: "src/engine/apis/index.ts",
		reason: "the provider extension registers engine API implementations at the domain composition boundary.",
	},
	{
		module: "src/engine/api-registry.ts",
		reason: "the provider plugin loader activates the engine-owned external API bridge.",
	},
	{
		module: "src/engine/prompt-templates.ts",
		reason: "resource loaders share the engine's argument parser and substitution semantics.",
	},
	{
		module: "src/engine/strip-tokenizer-sentinels.ts",
		reason: "session previews reuse the engine's pure tokenizer-sentinel normalizer.",
	},
	{
		module: "src/engine/apis/residency.ts",
		reason: "the orchestrator and worker entry points share engine model-residency policy.",
	},
	{
		module: "src/engine/loop-guard.ts",
		reason: "the Stage 1 composition root wires the engine-owned loop guard.",
	},
	{
		module: "src/engine/worker-runtime.ts",
		reason: "the worker entry point boots the engine-owned worker runtime.",
	},
	{
		module: "src/engine/worker-tools.ts",
		reason: "the worker entry point installs the engine-owned worker tool bridge.",
	},
	{
		module: "src/interactive/index.ts",
		reason: "the Stage 1 composition root assembles the complete interactive application.",
		allowStage0OverlapFrom: [ORCHESTRATOR],
	},
	{
		module: "src/interactive/keybinding-manager.ts",
		reason: "the Stage 1 composition root supplies the keybinding manager to the application it assembles.",
		allowStage0OverlapFrom: [ORCHESTRATOR],
	},
	{
		module: "src/session-control/loop-guard-interrupt.ts",
		reason: "the Stage 1 composition root connects engine loop-guard stops to interactive cancellation.",
	},
	{
		module: "src/session-control/model-session-replay.ts",
		reason: "the Stage 1 composition root projects persisted turns back into interactive model messages.",
		allowStage0OverlapFrom: [ORCHESTRATOR],
	},
	{
		module: "src/interactive/panes-runtime.ts",
		reason: "the panes composition root (src/entry/with-panes.ts) creates the optional interactive panes runtime.",
	},
	{
		module: "src/interactive/mux-bridge.ts",
		reason:
			"the panes composition root (src/entry/with-panes.ts) supplies the dispatch-to-pane bridge factory; it loads only behind the --with-panes dynamic import.",
	},
	{
		module: "src/interactive/yazi-bridge.ts",
		reason:
			"the panes composition root (src/entry/with-panes.ts) supplies the file-pane bridge factory; it loads only behind the --with-panes dynamic import.",
	},
	{
		module: "src/interactive/watch-pane.ts",
		reason:
			"the panes composition root (src/entry/with-panes.ts) supplies the workers-view watch-pane factory; it loads only behind the --with-panes dynamic import.",
	},
	{
		module: "src/interactive/tool-prose-registration.ts",
		reason: "the Stage 1 composition root registers interactive prose renderers for tool results.",
	},
	{
		module: "src/session-control/watchdog-run.ts",
		reason: "the Stage 1 composition root wires watchdog review into the complete interactive application.",
		allowStage0OverlapFrom: [ORCHESTRATOR],
	},
];

const STAGE0_SEAMS_BY_MODULE = new Map(STAGE0_SEAMS.map((seam) => [seam.module, seam]));

/**
 * The value-import closure of `entry`. Type-only imports are skipped because
 * they erase before the bundler sees them; dynamic imports are followed because
 * they are exactly what splits a chunk.
 */
function valueImportClosure(entry: string): Set<string> {
	const seen = new Set<string>();
	const stack = [entry];
	while (stack.length > 0) {
		const file = stack.pop();
		if (file === undefined || seen.has(file)) continue;
		let source: string;
		try {
			source = readFileSync(file, "utf8");
		} catch {
			continue;
		}
		seen.add(file);
		for (const { specifier, typeOnly } of extractSpecifiers(source)) {
			if (typeOnly) continue;
			if (!(specifier.startsWith(".") || specifier.startsWith("/"))) continue;
			const resolved = resolveRelativeImport(file, specifier);
			if (!seen.has(resolved)) stack.push(resolved);
		}
	}
	return seen;
}

function domainOf(filePath: string, domainsRoot: string): string | null {
	if (!isWithin(filePath, domainsRoot)) return null;
	const rel = path.relative(domainsRoot, filePath);
	const first = rel.split(path.sep)[0];
	return first ?? null;
}

function isAllowedWorkerProviderValueImport(resolved: string, providersDomainRoot: string): boolean {
	const allowedFiles = new Set([
		path.join(providersDomainRoot, "plugins.ts"),
		path.join(providersDomainRoot, "registry.ts"),
		path.join(providersDomainRoot, "runtimes", "builtins.ts"),
	]);
	return allowedFiles.has(resolved);
}

/**
 * Enforce the static isolation rules:
 *   1. Only src/engine/** may import @earendil-works/pi-* at all. Since the
 *      0.83.0 engine-boundary rework there is no type-only exception either:
 *      domains take erased engine shapes from src/engine/types.ts.
 *   2. src/worker/** never value-imports src/domains/** EXCEPT the worker-safe
 *      provider runtime registry, builtin descriptors, and plugin loader used
 *      to rehydrate runtime descriptors from stdin. Type-only imports are
 *      allowed because they erase at compile time.
 *   3. src/domains/<x> never imports src/domains/<y>/extension.ts for y != x.
 *   7. src/domains/turn-control/** imports no interactive, engine, tools or
 *      worker modules, and reaches other domains only through index.ts.
 *   4. src/tools/** never imports src/interactive/**. The tool substrate is
 *      surface-agnostic: headless, interactive, ACP, and worker runs share it,
 *      so a tool reaching into TUI code would make one surface's presentation
 *      a dependency of every surface's execution.
 *   5. The chat loop's turn modules (src/session-control/turn-*.ts,
 *      chat-loop.ts) never import src/entry/**. Composition flows one way: the
 *      entry point composes the loop, never the reverse.
 *   8. src/session-control/** never imports src/interactive/**, type-only
 *      included. It is the one session contract the TUI, headless run and the
 *      ACP server all call, so a render module in its graph would make the
 *      terminal a dependency of every surface.
 *  10. Root and GUI monetary display uses core/telemetry/render.ts;
 *      browser code consumes display strings rendered by the server.
 *  14. src/interactive/**, src/engine/acp/** and src/cli/** sum no token or
 *      cost field: their figures are the read model's quantity displays,
 *      except the functions SURFACE_TOTAL_EXEMPTIONS names with a reason.
 *   9. src/engine/** never imports src/interactive/**, type-only included.
 *      The ACP server reaches session behavior through src/session-control.
 *   6. Any value importer outside the computed Stage 0 closure and its
 *      src/interactive/**, src/session-control/** and src/engine/** trees
 *      reaches those trees only
 *      through a declared seam in STAGE0_SEAMS. A seam may not lead back into
 *      Stage 0 unless that existing composition-root overlap is explicitly
 *      declared. CLI type edges retain the older declaration requirement.
 *      Both halves protect the instant shell's cold-start chunk graph, pinned by
 *      tests/contracts/instant-shell-import-graph.test.ts.
 */
export function runBoundaryCheck(projectRoot: string): BoundaryCheckResult {
	const srcRoot = path.join(projectRoot, "src");
	const engineRoot = path.join(srcRoot, "engine");
	const workerRoot = path.join(srcRoot, "worker");
	const domainsRoot = path.join(srcRoot, "domains");
	const providersDomainRoot = path.join(domainsRoot, "providers");
	const toolsRoot = path.join(srcRoot, "tools");
	const interactiveRoot = path.join(srcRoot, "interactive");
	const sessionControlRoot = path.join(srcRoot, "session-control");
	const entryRoot = path.join(srcRoot, "entry");
	const cliRoot = path.join(srcRoot, "cli");
	const stage0Owner = path.join(projectRoot, STAGE_0_OWNER);
	const stage0Closure = valueImportClosure(stage0Owner);

	const violations: string[] = [];
	/** Runtime importers by declared seam, so rule 6b can disposition each reacher. */
	const valueReachedSeams = new Map<string, Set<string>>();
	const usedSurfaceExemptions = new Set<string>();

	for (const filePath of walk(srcRoot)) {
		const source = readFileSync(filePath, "utf8");
		violations.push(...checkCostRendering(path.relative(projectRoot, filePath).split(path.sep).join("/"), source));
		violations.push(...checkLedgerUsageMutation(path.relative(projectRoot, filePath).split(path.sep).join("/"), source));
		violations.push(...checkTelemetryWrites(path.relative(projectRoot, filePath).split(path.sep).join("/"), source));
		violations.push(...checkLedgerUsageKeys(path.relative(projectRoot, filePath).split(path.sep).join("/"), source));
		violations.push(
			...checkSurfaceTotals(path.relative(projectRoot, filePath).split(path.sep).join("/"), source, usedSurfaceExemptions),
		);
		const specifiers = extractSpecifiers(source);
		const references = extractReferenceDirectives(source);

		const inEngine = isWithin(filePath, engineRoot);
		const inInteractive = isWithin(filePath, interactiveRoot);
		const inWorker = isWithin(filePath, workerRoot);
		const fromDomain = domainOf(filePath, domainsRoot);
		const inTools = isWithin(filePath, toolsRoot);
		const inSessionControl = isWithin(filePath, sessionControlRoot);
		const isChatLoopModule = inSessionControl && isChatLoopTurnModule(filePath);
		const inCli = isWithin(filePath, cliRoot);
		const inStage0Closure = stage0Closure.has(filePath);

		const evaluate = (specifier: string, typeOnly: boolean, kind: "import" | "reference") => {
			if (specifier.startsWith(piPackagePrefix)) {
				if (!inEngine && !typeOnly) {
					violations.push(
						`rule1: ${path.relative(projectRoot, filePath)} ${kind} ${specifier} outside src/engine (value import)`,
					);
				}
				if (!inEngine && typeOnly && !allowedPiTypeImportSpecifiersOutsideEngine.has(specifier)) {
					violations.push(
						`rule1: ${path.relative(projectRoot, filePath)} ${kind} ${specifier} outside src/engine (type-only import is not explicitly allowed)`,
					);
				}
				return;
			}

			if (!(specifier.startsWith(".") || specifier.startsWith("/"))) return;
			const resolved = resolveRelativeImport(filePath, specifier);
			const targetDomain = domainOf(resolved, domainsRoot);
			if (
				fromDomain === "turn-control" &&
				(isWithin(resolved, interactiveRoot) ||
					isWithin(resolved, engineRoot) ||
					isWithin(resolved, toolsRoot) ||
					isWithin(resolved, workerRoot) ||
					(targetDomain !== null &&
						targetDomain !== fromDomain &&
						resolved !== path.join(domainsRoot, targetDomain, "index.ts")))
			) {
				const qualifier = typeOnly ? " (type-only)" : "";
				violations.push(
					`rule7: ${path.relative(projectRoot, filePath)} ${kind}${qualifier} ${specifier}; turn-control is pure and other domains are accessed only through index.ts`,
				);
				return;
			}

			if (inWorker && isWithin(resolved, domainsRoot)) {
				if (!typeOnly && !isAllowedWorkerProviderValueImport(resolved, providersDomainRoot)) {
					violations.push(
						`rule2: ${path.relative(projectRoot, filePath)} ${kind} ${specifier} which resolves inside src/domains (worker value imports are limited to provider runtime rehydration modules)`,
					);
				}
				return;
			}

			if (inTools && isWithin(resolved, interactiveRoot)) {
				const qualifier = typeOnly ? " (type-only)" : "";
				violations.push(
					`rule4: ${path.relative(projectRoot, filePath)} ${kind}${qualifier} ${specifier} which resolves inside src/interactive; the tool substrate is surface-agnostic`,
				);
				return;
			}

			if ((inSessionControl || inEngine) && isWithin(resolved, interactiveRoot)) {
				const qualifier = typeOnly ? " (type-only)" : "";
				const rule = inSessionControl ? "rule8" : "rule9";
				const owner = inSessionControl ? "the session contract" : "the engine";
				violations.push(
					`${rule}: ${path.relative(projectRoot, filePath)} ${kind}${qualifier} ${specifier} which resolves inside src/interactive; ${owner} is shared by every surface and never depends on terminal rendering`,
				);
				return;
			}

			const protectedTarget =
				isWithin(resolved, interactiveRoot) || isWithin(resolved, sessionControlRoot) || isWithin(resolved, engineRoot);
			const externalRuntimeReacher = !typeOnly && !inInteractive && !inSessionControl && !inEngine && !inStage0Closure;
			if (protectedTarget && (inCli || externalRuntimeReacher)) {
				const seamPath = path.relative(projectRoot, resolved).split(path.sep).join("/");
				const seam = STAGE0_SEAMS_BY_MODULE.get(seamPath);
				if (seam === undefined) {
					const qualifier = typeOnly ? " (type-only)" : "";
					violations.push(
						`rule6: ${path.relative(projectRoot, filePath)} ${kind}${qualifier} ${specifier} which resolves to ${seamPath}; runtime importers outside the computed Stage 0 closure and its src/interactive/** and src/engine/** trees may enter those protected trees only through a seam declared in STAGE0_SEAMS (tests/boundaries/check-boundaries.ts). A new disjoint reacher makes esbuild split the merged chunk the instant shell's Stage 0 closure sits on. That closure is held to 32 chunks, 1,400,000 total bytes and 350,000 Clio source bytes by tests/contracts/instant-shell-import-graph.test.ts, which only fails after a full build. Move the needed value into a leaf seam, route through an existing seam, or declare a legitimate edge with its reason.`,
					);
				} else if (!typeOnly) {
					const importers = valueReachedSeams.get(resolved) ?? new Set<string>();
					importers.add(filePath);
					valueReachedSeams.set(resolved, importers);
				}
				return;
			}

			if (isChatLoopModule && isWithin(resolved, entryRoot)) {
				const qualifier = typeOnly ? " (type-only)" : "";
				violations.push(
					`rule5: ${path.relative(projectRoot, filePath)} ${kind}${qualifier} ${specifier} which resolves inside src/entry; the entry point composes the chat loop, never the reverse`,
				);
				return;
			}

			if (fromDomain) {
				const toDomain = domainOf(resolved, domainsRoot);
				if (toDomain && toDomain !== fromDomain && resolved.endsWith(`${path.sep}extension.ts`)) {
					const qualifier = typeOnly ? " (type-only)" : "";
					violations.push(
						`rule3: ${path.relative(projectRoot, filePath)} ${kind}${qualifier} reaches into src/domains/${toDomain}/extension.ts; use the contract exported from src/domains/${toDomain}/index.ts instead`,
					);
				}
			}
		};

		for (const { specifier, typeOnly } of specifiers) {
			evaluate(specifier, typeOnly, "import");
		}

		for (const ref of references) {
			if (ref.kind === "types") {
				evaluate(ref.specifier, true, "reference");
			} else {
				const spec = ref.specifier.startsWith(".") || ref.specifier.startsWith("/") ? ref.specifier : `./${ref.specifier}`;
				evaluate(spec, true, "reference");
			}
		}
	}

	// rule6, second half. Declaring a seam is not enough: the imported module
	// drags its own closure along, and that is how the first CLI splits happened.
	// A seam may reach domains, core, and the
	// non-terminal half of the engine freely; what it may not reach is anything
	// the Stage 0 owner already reaches, because that is precisely the set whose
	// chunk membership the instant shell is measured on. The owner itself is the
	// reference point, so its own seam edge is skipped rather than special-cased.
	for (const seam of [...valueReachedSeams.keys()].sort()) {
		if (seam === stage0Owner) continue;
		const reached = [...valueImportClosure(seam)]
			.filter((file) => file !== seam && stage0Closure.has(file))
			.filter(
				(file) => isWithin(file, interactiveRoot) || isWithin(file, sessionControlRoot) || isWithin(file, engineRoot),
			)
			.map((file) => path.relative(projectRoot, file).split(path.sep).join("/"))
			.sort();
		if (reached.length === 0) continue;
		const seamPath = path.relative(projectRoot, seam).split(path.sep).join("/");
		const declaration = STAGE0_SEAMS_BY_MODULE.get(seamPath);
		const allowedOverlapImporters = new Set(declaration?.allowStage0OverlapFrom ?? []);
		const importers = [...(valueReachedSeams.get(seam) ?? [])]
			.map((file) => path.relative(projectRoot, file).split(path.sep).join("/"))
			.filter((file) => !allowedOverlapImporters.has(file))
			.sort();
		if (importers.length === 0) continue;
		violations.push(
			`rule6: seam ${seamPath}, reached by ${importers.join(", ")}, value-imports its way into the Stage 0 closure (${reached.join(", ")}); an external seam must stay off the modules ${STAGE_0_OWNER} already reaches, or its importer becomes a second reacher and esbuild splits their merged chunk. That closure is held to 32 chunks, 1,400,000 total bytes and 350,000 Clio source bytes by tests/contracts/instant-shell-import-graph.test.ts, which only fails after a full build. Move the value the seam needs into a leaf module instead of importing the render module that happens to hold it.`,
		);
	}

	for (const exemption of SURFACE_TOTAL_EXEMPTIONS)
		for (const fn of exemption.functions)
			if (!usedSurfaceExemptions.has(`${exemption.file}#${fn}`))
				violations.push(
					`rule14: SURFACE_TOTAL_EXEMPTIONS exempts ${exemption.file}#${fn}, which no longer sums a token or cost field; remove the exemption`,
				);

	for (const directory of ["client", "server"]) {
		for (const file of walk(path.join(projectRoot, "apps/clio-coder-gui", directory))) {
			const relative = path.relative(projectRoot, file).split(path.sep).join("/");
			const source = readFileSync(file, "utf8");
			violations.push(...checkCostRendering(relative, source));
			if (directory === "server") violations.push(...checkTelemetryWrites(relative, source));
		}
	}
	for (const file of valueImportClosure(path.join(projectRoot, "src/core/telemetry/producer.ts"))) {
		violations.push(...checkTelemetryProducer(path.relative(projectRoot, file), readFileSync(file, "utf8")));
	}
	return { violations };
}
