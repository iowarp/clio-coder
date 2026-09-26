(() => {
	const article = document.querySelector("#doc");
	if (!article) return;
	const search = document.querySelector("#doc-search");
	const hits = document.querySelector("#search-hits");
	const menu = document.querySelector(".docs-menu");
	if (menu) menu.open = !matchMedia("(max-width: 980px)").matches;
	let index = [];
	const requested = new URLSearchParams(location.search).get("d");
	const ready = fetch("/content/index.json")
		.then((response) => {
			if (!response.ok) throw new Error("Search index is unavailable");
			return response.json();
		})
		.then((data) => {
			index = data;
			const legacy = requested && index.find((item) => item.path === requested);
			if (legacy && `${location.pathname}${location.search}` !== legacy.url)
				location.replace(`${legacy.url}${location.hash}`);
		})
		.catch(() => {
			if (hits) hits.textContent = "Search is unavailable. Browse the documentation links below.";
		});
	if (search && hits) {
		search.addEventListener("input", async () => {
			await ready;
			const query = search.value.trim().toLowerCase();
			hits.replaceChildren();
			if (query.length < 2) return;
			const found = index
				.filter((item) =>
					`${item.title} ${item.excerpt} ${(item.headings || []).join(" ")} ${item.path}`.toLowerCase().includes(query),
				)
				.slice(0, 10);
			for (const item of found) {
				const row = document.createElement("li"),
					link = document.createElement("a"),
					path = document.createElement("small");
				link.href = item.url;
				link.textContent = item.title;
				path.textContent = item.path;
				link.append(path);
				row.append(link);
				hits.append(row);
			}
			if (!found.length) {
				const row = document.createElement("li");
				row.textContent = "No page in this snapshot matches.";
				hits.append(row);
			}
		});
	}
	if (hits) hits.setAttribute("aria-live", "polite");
})();
