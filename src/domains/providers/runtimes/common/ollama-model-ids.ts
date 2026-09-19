// Ollama resolves an untagged name to :latest (registry ports are not tags).
export function ollamaModelIds(...ids: string[]): string[] {
	return [
		...new Set(
			ids.flatMap((id) => {
				if (id.endsWith(":latest")) return [id, id.slice(0, -7)];
				return id.slice(id.lastIndexOf("/") + 1).includes(":") ? [id] : [id, `${id}:latest`];
			}),
		),
	];
}
