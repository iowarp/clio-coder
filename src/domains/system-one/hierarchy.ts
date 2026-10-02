/**
 * Bounded grouping of an open catalog by the catalog's own categories, shared
 * by relevance ranking and the turn site's recipe pick.
 *
 * A model with a declared option bound cannot read a catalog of any size in one
 * question, and cutting the catalog into name-ordered chunks would present an
 * arbitrary partition as a semantic one. So a catalog is grouped only by
 * categories its entries already carry, each described by the catalog's own
 * statement of that category's purpose. An entry with no category, a category
 * with no purpose, or a catalog that does not split into a bounded number of
 * groups is not grouped at all, and the caller abstains or keeps its baseline.
 *
 * Categories run coarse to fine. A group too large for one request is replaced
 * by its finer categories when every member has one, to a fixed depth; one
 * that still cannot be refined stays whole and is marked oversized, so a
 * selection of it abstains explicitly instead of ranking part of it.
 */

/** One catalog category, described by the catalog that owns it. */
export interface CatalogCategory {
	readonly id: string;
	readonly label: string;
	/** What entries in this category are for, in the catalog's words. */
	readonly purpose: string;
}

export interface Categorized {
	readonly id: string;
	/** The entry's categories, coarsest first. */
	readonly categories?: ReadonlyArray<CatalogCategory>;
}

export interface CategoryGroup<T> {
	/** Category ids joined by `/`, coarsest first: the question key a selection answers under. */
	readonly key: string;
	readonly category: CatalogCategory;
	readonly members: ReadonlyArray<T>;
	/** More members than one request may carry, with no finer category to split by. */
	readonly oversized: boolean;
}

/** Category levels a grouping may descend. */
export const HIERARCHY_MAX_DEPTH = 2;

export interface GroupingBounds {
	/** Groups one selection may offer. */
	readonly maxGroups: number;
	/** Members one group's request may carry. */
	readonly maxMembers: number;
}

export type Grouping<T> = { readonly groups: ReadonlyArray<CategoryGroup<T>> } | { readonly abstain: string };

function usable(category: CatalogCategory | undefined): category is CatalogCategory {
	return (
		category !== undefined &&
		category.id.trim().length > 0 &&
		!category.id.includes("/") &&
		category.id !== "__proto__" &&
		category.purpose.trim().length > 0
	);
}

function split<T extends Categorized>(
	items: ReadonlyArray<T>,
	depth: number,
	prefix: string,
): Map<string, CategoryGroup<T>> {
	const groups = new Map<string, { category: CatalogCategory; members: T[] }>();
	for (const item of items) {
		const category = item.categories?.[depth] as CatalogCategory;
		const key = prefix.length > 0 ? `${prefix}/${category.id}` : category.id;
		const held = groups.get(key);
		if (held === undefined) groups.set(key, { category, members: [item] });
		else held.members.push(item);
	}
	return new Map([...groups].map(([key, group]) => [key, { key, ...group, oversized: false }]));
}

/** The catalog's groups within `bounds`, or why it cannot be grouped honestly. */
export function groupByCategory<T extends Categorized>(items: ReadonlyArray<T>, bounds: GroupingBounds): Grouping<T> {
	const bare = items.find((item) => !usable(item.categories?.[0]));
	if (bare !== undefined) return { abstain: `entry ${bare.id} has no described catalog category` };
	let groups = [...split(items, 0, "").values()];
	for (let depth = 1; depth < HIERARCHY_MAX_DEPTH; depth += 1) {
		const next: CategoryGroup<T>[] = [];
		for (const group of groups) {
			const finer =
				group.members.length > bounds.maxMembers && group.members.every((item) => usable(item.categories?.[depth]))
					? [...split(group.members, depth, group.key).values()]
					: [];
			if (finer.length >= 2) next.push(...finer);
			else next.push(group);
		}
		groups = next;
	}
	groups = groups.map((group) => ({ ...group, oversized: group.members.length > bounds.maxMembers }));
	if (groups.length < 2) return { abstain: "the catalog has a single category" };
	if (groups.length > bounds.maxGroups) {
		return { abstain: `${groups.length} categories; one selection offers at most ${bounds.maxGroups}` };
	}
	return { groups };
}

/** One line a selection question shows for a group: its label, size and purpose, bounded. */
export function representative(group: CategoryGroup<unknown>, maxChars: number): string {
	const text = `${group.category.label} (${group.members.length} entries): ${group.category.purpose}`
		.replace(/\s+/g, " ")
		.trim();
	const points = [...text];
	return points.length <= maxChars ? text : `${points.slice(0, maxChars - 1).join("")}…`;
}
