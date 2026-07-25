/** Native recipes and ACP delegation agents share the operator-facing id namespace. */
export function assertAgentIdNamespace(
	nativeRecipes: ReadonlyArray<{ id: string }>,
	acpDelegates: ReadonlyArray<{ id: string }>,
): void {
	const native = new Set(nativeRecipes.map((recipe) => recipe.id));
	const collision = acpDelegates.find((delegate) => native.has(delegate.id));
	if (collision !== undefined) {
		throw new Error(
			`agent id collision: native recipe '${collision.id}' and ACP delegation agent '${collision.id}' share one namespace`,
		);
	}
}
