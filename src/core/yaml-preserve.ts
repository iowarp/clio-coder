/**
 * Render a new value into an existing YAML document without rewriting the
 * parts that did not change. Settings writers produce a whole plain object;
 * re-stringifying it re-indented lists, folded long strings and turned the
 * quoted `'on'` of a YAML 1.1 file into a bare `on` (p6/R1: 100+ diff lines
 * for a 5-line change). Here the delta between the saved document and the
 * new value is applied to the parsed Document node by node, so untouched
 * nodes keep their quoting, comments, blank lines and flow style.
 */

import type { Node } from "yaml";
import { Document, isAlias, isMap, isScalar, isSeq, parse, parseDocument, visit } from "yaml";

/** Scalars a YAML 1.1 reader would resolve to a boolean. */
const YAML11_BOOLEAN = /^(?:y|yes|n|no|on|off|true|false)$/iu;

interface RenderOptions {
	indentSeq: boolean;
	lineWidth: number;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deepEqual(a: unknown, b: unknown): boolean {
	if (a === b) return true;
	if (Array.isArray(a) || Array.isArray(b)) {
		if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
		return a.every((entry, index) => deepEqual(entry, b[index]));
	}
	if (!isPlainObject(a) || !isPlainObject(b)) return false;
	const keys = Object.keys(a);
	if (keys.length !== Object.keys(b).length) return false;
	return keys.every((key) => Object.hasOwn(b, key) && deepEqual(a[key], b[key]));
}

/**
 * Lists under a key sit at the key's indent in some files and one level in under
 * it in others, and a document renders with a single choice. The majority of
 * the file's own lists decides it so the fewest lines move.
 */
function detectIndentSeq(text: string | null): boolean {
	if (text === null) return true;
	let indented = 0;
	let flush = 0;
	for (const match of text.matchAll(/^( *)[^\s#-][^\n]*:[ \t]*(?:#[^\n]*)?\n( *)- /gmu)) {
		if ((match[2]?.length ?? 0) > (match[1]?.length ?? 0)) indented += 1;
		else flush += 1;
	}
	return indented >= flush;
}

/** Quote strings that YAML 1.1 tools would read back as booleans. */
function protectStrings<T extends Node | null>(node: T): T {
	visit(node, {
		Scalar(_key, scalar) {
			if (typeof scalar.value === "string" && YAML11_BOOLEAN.test(scalar.value)) scalar.type = "QUOTE_SINGLE";
		},
	});
	return node;
}

function freshText(next: unknown, options: RenderOptions): string {
	const document = new Document(next);
	protectStrings(document.contents);
	return document.toString(options);
}

function setNode(document: Document, path: ReadonlyArray<string | number>, value: unknown): void {
	if (path.length === 0) {
		document.contents = protectStrings(document.createNode(value)) as Document["contents"];
		return;
	}
	const existing = document.getIn(path, true);
	// A scalar keeps its comment and quote style when only its value moves.
	if (isScalar(existing) && (value === null || ["string", "number", "boolean"].includes(typeof value))) {
		existing.value = value;
		delete existing.tag;
		if (typeof value === "string" && YAML11_BOOLEAN.test(value)) existing.type = "QUOTE_SINGLE";
		return;
	}
	document.setIn(path, protectStrings(document.createNode(value)));
}

function applyDelta(document: Document, path: ReadonlyArray<string | number>, before: unknown, after: unknown): void {
	if (deepEqual(before, after)) return;
	const node = path.length === 0 ? document.contents : document.getIn(path, true);
	if (isPlainObject(before) && isPlainObject(after) && isMap(node)) {
		for (const [key, value] of Object.entries(after)) {
			if (Object.hasOwn(before, key)) applyDelta(document, [...path, key], before[key], value);
			else setNode(document, [...path, key], value);
		}
		for (const key of Object.keys(before)) {
			if (!Object.hasOwn(after, key)) document.deleteIn([...path, key]);
		}
		return;
	}
	if (Array.isArray(before) && Array.isArray(after) && isSeq(node)) {
		const shared = Math.min(before.length, after.length);
		for (let index = 0; index < shared; index += 1) applyDelta(document, [...path, index], before[index], after[index]);
		for (let index = shared; index < after.length; index += 1) setNode(document, [...path, index], after[index]);
		for (let index = before.length - 1; index >= after.length; index -= 1) document.deleteIn([...path, index]);
		return;
	}
	setNode(document, path, after);
}

function hasAlias(document: Document): boolean {
	let found = false;
	visit(document, {
		Alias() {
			found = true;
			return visit.BREAK;
		},
	});
	return found || isAlias(document.contents);
}

/**
 * YAML text for `next`, edited into `existing` when that text parses cleanly
 * as a mapping. An absent, unparseable, aliased or non-mapping document is
 * rendered fresh, because there is no layout worth keeping.
 */
export function renderYamlPreservingLayout(existing: string | null | undefined, next: unknown): string {
	const text = existing !== undefined && existing !== null && existing.trim().length > 0 ? existing : null;
	const options: RenderOptions = { indentSeq: detectIndentSeq(text), lineWidth: 0 };
	if (text === null) return freshText(next, options);
	const document = parseDocument(text);
	if (document.errors.length > 0 || !isMap(document.contents) || !isPlainObject(next) || hasAlias(document)) {
		return freshText(next, options);
	}
	applyDelta(document, [], document.toJS(), next);
	const rendered = document.toString(options);
	return deepEqual(parse(rendered), next) ? rendered : freshText(next, options);
}
