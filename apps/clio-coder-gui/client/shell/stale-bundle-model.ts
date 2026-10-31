/**
 * Whether this window runs a bundle built for another Clio Coder version than the server it talks to: an open tab
 * keeps its old bundle across an upgrade, and an old bundle misreads the new server's answers. Null when the two
 * match or either is unknown, so a build that stamped no version never prompts.
 */
export function staleBundle(
	bundle: string | null,
	server: string | null | undefined,
): { title: string; detail: string } | null {
	if (!bundle || !server || bundle === server) return null;
	return {
		title: `This window runs Clio Coder ${bundle}, and the server runs ${server}.`,
		detail: "Reload this window to use the version the server runs. It does not reload on its own.",
	};
}
