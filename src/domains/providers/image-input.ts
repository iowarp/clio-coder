/** One conservative image-input decision for routed capabilities and model transport metadata. */
export function acceptsImageInput(input: {
	vision?: boolean | undefined;
	modelInput?: ReadonlyArray<"text" | "image"> | undefined;
	runtimeId?: string | undefined;
}): boolean {
	// These runtimes receive a text work order through a CLI/SDK bridge. Their
	// underlying model may have vision, but the bridge has no image-block path.
	if (input.runtimeId === "claude-code" || input.runtimeId === "claude-sdk" || input.runtimeId === "antigravity-code") {
		return false;
	}
	if (input.vision !== undefined) return input.vision === true;
	return input.modelInput?.includes("image") === true;
}
