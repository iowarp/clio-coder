import type { ResourceSourceInfo } from "../domains/resources/collision.js";

/**
 * The package a prompt came from, in the words the operator installed it by.
 * A plugin root's source is `plugin:<scope>:<id>`; the rest are Clio's own
 * roots and the foreign roots it reads, which carry the agent kind and scope.
 * A leaf on purpose: the slash registry names the source in a card and must
 * stay off the render graph.
 */
export function promptSourceLabel(sourceInfo: Pick<ResourceSourceInfo, "source" | "scope">): string {
	const source = sourceInfo.source;
	if (source === undefined) return `${sourceInfo.scope} prompts`;
	const plugin = /^plugin:(?:[^:]+):(.+)$/u.exec(source);
	if (plugin?.[1]) return `plugin ${plugin[1]}`;
	if (source === "config") return "user prompts";
	if (source === "project") return "project prompts";
	if (source === "library") return "library";
	const foreign = /^([a-z0-9-]+)-(user|project)$/u.exec(source);
	if (foreign?.[1] && foreign[2]) return `${foreign[1]} ${foreign[2]} prompts`;
	return source;
}
