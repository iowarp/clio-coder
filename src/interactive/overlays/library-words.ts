import { extensionOwnerLabel } from "../../domains/extensions/owner-label.js";

/**
 * A package the way the Library lists it, by name and kind (`bench-tips
 * plugin`), never by its `plugin:bench-tips` ref; an extension goes by the
 * name the owner-label resolver gives every other surface. Anything that is
 * not a `kind:name` ref (a path, a URL) is shown as it is.
 */
export function refWords(ref: string): string {
	const match = /^([a-z][a-z-]*):([^/].*)$/u.exec(ref);
	if (!match) return ref;
	const [, kind = "", name = ""] = match;
	return `${kind === "extension" ? extensionOwnerLabel(name) : name} ${kind}`;
}
