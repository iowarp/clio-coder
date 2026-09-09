import { realpathSync } from "node:fs";
import path from "node:path";
import { readPluginManifest } from "../plugins/index.js";

export interface PackageReferenceContext {
	rootPath?: string;
	/** Only plugin-owned content interprets package references. */
	plugin?: boolean;
}

/** Prose markers with a portable, space-free slash suffix. */
const REFERENCE_PATTERN = /\$\{(pluginRoot|component:([^}]+))\}(\/[A-Za-z0-9._~%+@/-]*)?/g;
/** The same reference occupying an entire argv/data value, spaces and Unicode included. */
const COMPLETE_REFERENCE = /^\$\{(pluginRoot|component:([^}]+))\}(\/[\s\S]*)?$/u;

function referenceResolver(context: PackageReferenceContext & { rootPath: string }) {
	const root = realpathSync(context.rootPath);
	let components: Map<string, string> | undefined;
	return (reference: string, _token: string, ref: string | undefined, suffix: string | undefined): string => {
		if (suffix && /[\\\0\r\n]/u.test(suffix)) throw new Error(`unsupported package path syntax: ${reference}`);
		let relative = "";
		if (ref !== undefined) {
			if (!components) {
				const candidate = readPluginManifest(root);
				if (!candidate.valid || !candidate.manifest) throw new Error("plugin manifest unavailable for component reference");
				components = new Map(
					candidate.manifest.clio.components.map((component) => [`${component.kind}:${component.id}`, component.path]),
				);
			}
			const componentPath = components.get(ref);
			if (componentPath === undefined) throw new Error(`unresolved component reference: ${ref}`);
			relative = componentPath;
		}
		const target = path.resolve(root, relative + (suffix ?? ""));
		const contained = (value: string): boolean => {
			const rel = path.relative(root, value);
			return rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
		};
		try {
			// A root token's slash suffix is package-relative, never filesystem-absolute.
			const resolved = ref === undefined ? path.resolve(root, `.${suffix ?? ""}`) : target;
			if (!contained(resolved) || !contained(realpathSync(resolved))) throw new Error("outside package");
			return resolved;
		} catch {
			throw new Error(`unresolved or escaping package reference: ${reference}`);
		}
	};
}

/**
 * Expand prose markers with portable, space-free slash suffixes. Surrounding
 * prose is not a filesystem path; data arguments use the complete-path parser.
 */
export function resolvePackageReferences(body: string, context: PackageReferenceContext): string {
	if (!context.rootPath || !context.plugin || !body.includes("${")) return body;
	return body.replace(REFERENCE_PATTERN, referenceResolver({ ...context, rootPath: context.rootPath }));
}

/** Resolve an entire argv/data path, including spaces and Unicode, before use. */
export function resolvePackagePathReference(value: string, context: PackageReferenceContext): string {
	if (!context.rootPath || !context.plugin || !/\$\{(?:pluginRoot|component:)/u.test(value)) return value;
	const match = COMPLETE_REFERENCE.exec(value);
	if (!match || match[3]?.includes("${"))
		throw new Error("package path references must occupy one complete argument with no embedded expressions");
	return referenceResolver({ ...context, rootPath: context.rootPath })(value, match[1] ?? "", match[2], match[3]);
}
