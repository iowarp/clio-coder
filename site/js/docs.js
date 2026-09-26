(() => {
	const article = document.querySelector("#doc");
	if (!article) return;
	const search = document.querySelector("#doc-search");
	const hits = document.querySelector("#search-hits");
	const menu = document.querySelector(".docs-menu");
	const status = document.querySelector("#search-status");
	if (menu) {
		const compact = matchMedia("(max-width: 850px)");
		menu.open = !compact.matches;
		compact.addEventListener("change", (event) => {
			menu.open = !event.matches;
		});
	}
	let index = [];
	let unavailable = false;
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
			unavailable = true;
			if (hits) hits.textContent = "Search is unavailable. Browse the documentation links below.";
		});
	if (search && hits) {
		search.addEventListener("keydown", (event) => {
			if (event.key === "ArrowDown" && hits.querySelector("a")) {
				event.preventDefault();
				hits.querySelector("a").focus();
			} else if (event.key === "Escape") {
				search.value = "";
				hits.replaceChildren();
				if (status) status.textContent = "";
			}
		});
		hits.addEventListener("keydown", (event) => {
			const links = [...hits.querySelectorAll("a")];
			const current = links.indexOf(document.activeElement);
			if (current < 0) return;
			if (event.key === "ArrowDown" || event.key === "ArrowUp") {
				event.preventDefault();
				const next = current + (event.key === "ArrowDown" ? 1 : -1);
				(next < 0 ? search : links[Math.min(next, links.length - 1)]).focus();
			} else if (event.key === "Escape") {
				event.preventDefault();
				search.focus();
				search.value = "";
				hits.replaceChildren();
				if (status) status.textContent = "";
			}
		});
		search.addEventListener("input", async () => {
			await ready;
			if (unavailable) return;
			const query = search.value.trim().toLowerCase();
			hits.replaceChildren();
			if (query.length < 2) {
				if (status) status.textContent = "";
				return;
			}
			const rank = (item) => {
				const title = item.title.toLowerCase();
				return (
					(title === query ? 100 : title.startsWith(query) ? 60 : title.includes(query) ? 40 : 0) +
					(item.path.toLowerCase().includes(query) ? 30 : 0) +
					((item.headings || []).join(" ").toLowerCase().includes(query) ? 10 : 0) +
					(item.path.startsWith("guide/") ? 5 : 0)
				);
			};
			const found = index
				.filter((item) =>
					`${item.title} ${item.excerpt} ${(item.headings || []).join(" ")} ${item.path}`.toLowerCase().includes(query),
				)
				.sort((a, b) => rank(b) - rank(a))
				.slice(0, 10);
			if (status) status.textContent = `${found.length ? `Found ${found.length} guides` : "No matching guides"}.`;
			for (const item of found) {
				const row = document.createElement("li"),
					link = document.createElement("a"),
					path = document.createElement("small");
				link.href = item.url;
				const match = item.title.toLowerCase().indexOf(query);
				if (match >= 0) {
					const mark = document.createElement("mark");
					mark.textContent = item.title.slice(match, match + query.length);
					link.append(item.title.slice(0, match), mark, item.title.slice(match + query.length));
				} else link.textContent = item.title;
				path.textContent = item.group;
				link.append(path);
				row.append(link);
				hits.append(row);
			}
			if (!found.length) {
				const row = document.createElement("li");
				row.textContent = "No guide matches. Try a model, command, or task name.";
				hits.append(row);
			}
		});
	}
	const headings = [...article.querySelectorAll("h2[id]")];
	const toc = [...document.querySelectorAll(".docs-toc a, .doc-toc-mobile a")];
	if (headings.length && toc.length && "IntersectionObserver" in window) {
		let queued = false;
		let active;
		const update = () => {
			queued = false;
			const header =
				parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--header")) *
					parseFloat(getComputedStyle(document.documentElement).fontSize) +
				40;
			let current = headings[0];
			for (const heading of headings) {
				if (heading.getBoundingClientRect().top > header) break;
				current = heading;
			}
			if (current.id === active) return;
			active = current.id;
			for (const link of toc) {
				if (link.hash === `#${active}`) link.setAttribute("aria-current", "location");
				else link.removeAttribute("aria-current");
			}
		};
		const schedule = () => {
			if (queued) return;
			queued = true;
			requestAnimationFrame(update);
		};
		// The article is static; one animation-frame update keeps both table-of-contents views in sync.
		window.addEventListener("scroll", schedule, { passive: true });
		window.addEventListener("resize", schedule);
		update();
	}
})();
