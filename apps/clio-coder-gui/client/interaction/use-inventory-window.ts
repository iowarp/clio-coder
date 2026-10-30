import { useState } from "react";

export const INVENTORY_PAGE_SIZE = 48;

/** Search and filters apply to the complete inventory; only rendering is paged. */
export function useInventoryWindow(key: string) {
	const [page, setPage] = useState({ key, limit: INVENTORY_PAGE_SIZE });
	const limit = page.key === key ? page.limit : INVENTORY_PAGE_SIZE;
	return { limit, more: () => setPage({ key, limit: limit + INVENTORY_PAGE_SIZE }) };
}
