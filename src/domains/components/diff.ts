import type {
	ChangedHarnessComponent,
	ComponentDiff,
	ComponentFieldName,
	ComponentSnapshot,
	HarnessComponent,
} from "./types.js";

const COMPONENT_FIELDS: ReadonlyArray<ComponentFieldName> = [
	"id",
	"kind",
	"path",
	"ownerDomain",
	"mutable",
	"authority",
	"reloadClass",
	"contentHash",
	"description",
];

export function diffComponentSnapshots(from: ComponentSnapshot, to: ComponentSnapshot): ComponentDiff {
	const fromById = indexComponents(from.components, "from");
	const toById = indexComponents(to.components, "to");
	const added: HarnessComponent[] = [];
	const removed: HarnessComponent[] = [];
	const changed: ChangedHarnessComponent[] = [];
	let unchanged = 0;

	for (const before of from.components) {
		const after = toById.get(before.id);
		if (!after) {
			removed.push(before);
			continue;
		}
		const changedFields = changedComponentFields(before, after);
		if (changedFields.length === 0) {
			unchanged += 1;
			continue;
		}
		changed.push({ id: before.id, before, after, changedFields });
	}

	for (const after of to.components) {
		if (!fromById.has(after.id)) added.push(after);
	}

	return {
		version: 1,
		from: {
			root: from.root,
			generatedAt: from.generatedAt,
			componentCount: from.components.length,
		},
		to: {
			root: to.root,
			generatedAt: to.generatedAt,
			componentCount: to.components.length,
		},
		summary: {
			added: added.length,
			removed: removed.length,
			changed: changed.length,
			unchanged,
		},
		added: sortComponents(added),
		removed: sortComponents(removed),
		changed: changed.sort((a, b) => a.id.localeCompare(b.id)),
	};
}

function indexComponents(
	components: ReadonlyArray<HarnessComponent>,
	label: "from" | "to",
): Map<string, HarnessComponent> {
	const map = new Map<string, HarnessComponent>();
	for (const component of components) {
		if (map.has(component.id)) {
			throw new Error(`component diff ${label} snapshot has duplicate id: ${component.id}`);
		}
		map.set(component.id, component);
	}
	return map;
}

function changedComponentFields(before: HarnessComponent, after: HarnessComponent): ComponentFieldName[] {
	const changed: ComponentFieldName[] = [];
	for (const field of COMPONENT_FIELDS) {
		if (before[field] !== after[field]) changed.push(field);
	}
	return changed;
}

function sortComponents(components: ReadonlyArray<HarnessComponent>): HarnessComponent[] {
	return [...components].sort((a, b) => {
		const idOrder = a.id.localeCompare(b.id);
		if (idOrder !== 0) return idOrder;
		return a.path.localeCompare(b.path);
	});
}
