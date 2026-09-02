document.addEventListener("DOMContentLoaded", () => {
	initCopyButtons();
	initTableOfContents();
	initActiveSectionHighlighting();
	initReadingProgress();
	initBlueprintIndex();
});

function copyText(text) {
	if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(text);
	return new Promise((resolve, reject) => {
		const scratch = document.createElement("textarea");
		scratch.value = text;
		scratch.setAttribute("readonly", "");
		scratch.style.position = "fixed";
		scratch.style.opacity = "0";
		document.body.appendChild(scratch);
		scratch.select();
		const copied = document.execCommand("copy");
		scratch.remove();
		if (copied) resolve();
		else reject(new Error("copy unavailable"));
	});
}

function initCopyButtons() {
	for (const block of document.querySelectorAll("pre")) {
		if (block.querySelector(".copy-btn")) continue;
		block.setAttribute("tabindex", "0");
		const button = document.createElement("button");
		button.type = "button";
		button.className = "copy-btn";
		button.textContent = "Copy";
		button.setAttribute("aria-label", "Copy code snippet");
		button.addEventListener("click", async () => {
			const code = block.querySelector("code") ?? block;
			try {
				await copyText(code.textContent?.trim() ?? "");
				button.textContent = "Copied";
				button.style.color = "var(--color-emerald)";
			} catch {
				button.textContent = "Unavailable";
				button.style.color = "var(--color-rose)";
			}
			setTimeout(() => {
				button.textContent = "Copy";
				button.style.color = "";
			}, 1800);
		});
		block.appendChild(button);
	}
}

function headingSlug(text) {
	return (
		text
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/(^-|-$)/g, "") || "section"
	);
}

function initTableOfContents() {
	const tocList = document.querySelector(".toc-list");
	if (!tocList) return;
	tocList.replaceChildren();
	const headings = document.querySelectorAll("main .reference-prose h2, main .reference-prose h3");
	if (headings.length === 0) {
		const sidebar = document.querySelector(".sidebar");
		if (sidebar) sidebar.hidden = true;
		return;
	}
	const used = new Map();
	for (const heading of headings) {
		const label = heading.textContent?.trim() ?? "Section";
		const base = heading.id || headingSlug(label);
		const seen = used.get(base) ?? 0;
		used.set(base, seen + 1);
		heading.id = seen === 0 ? base : `${base}-${seen + 1}`;

		const anchor = document.createElement("a");
		anchor.href = `#${heading.id}`;
		anchor.className = "heading-anchor";
		anchor.setAttribute("aria-label", `Link to ${label}`);
		anchor.textContent = "#";
		heading.appendChild(anchor);

		const item = document.createElement("li");
		if (heading.tagName === "H3") item.style.paddingLeft = "0.75rem";
		const link = document.createElement("a");
		link.href = `#${heading.id}`;
		link.className = "toc-link";
		link.textContent = label.replace(/[→•]/g, "").trim();
		item.appendChild(link);
		tocList.appendChild(item);
	}
}

function initActiveSectionHighlighting() {
	const links = [...document.querySelectorAll(".toc-link")];
	if (links.length === 0) return;
	const headings = links
		.map((link) => document.getElementById(link.getAttribute("href")?.slice(1) ?? ""))
		.filter(Boolean);
	let queued = false;
	const update = () => {
		queued = false;
		const marker = window.scrollY + 130;
		let current = headings[0]?.id ?? "";
		for (const heading of headings) {
			if (heading.offsetTop <= marker) current = heading.id;
			else break;
		}
		for (const link of links) link.classList.toggle("active", link.getAttribute("href") === `#${current}`);
	};
	window.addEventListener(
		"scroll",
		() => {
			if (queued) return;
			queued = true;
			window.requestAnimationFrame(update);
		},
		{ passive: true },
	);
	update();
}

function initReadingProgress() {
	const meter = document.querySelector(".reading-progress");
	if (!meter) return;
	const update = () => {
		const available = document.documentElement.scrollHeight - window.innerHeight;
		const progress = available <= 0 ? 1 : Math.min(1, Math.max(0, window.scrollY / available));
		meter.style.transform = `scaleX(${progress})`;
	};
	window.addEventListener("scroll", update, { passive: true });
	window.addEventListener("resize", update);
	update();
}

function initBlueprintIndex() {
	const input = document.querySelector("[data-doc-search]");
	const cards = [...document.querySelectorAll("[data-blueprint-card]")];
	if (!input || cards.length === 0) return;
	const buttons = [...document.querySelectorAll("[data-doc-filter]")];
	const result = document.querySelector("[data-doc-result]");
	const empty = document.querySelector("[data-doc-empty]");
	let category = "all";
	const apply = () => {
		const query = input.value.toLowerCase().trim();
		let shown = 0;
		for (const card of cards) {
			const categoryMatch = category === "all" || card.dataset.category === category;
			const queryMatch = query.length === 0 || (card.dataset.search ?? "").includes(query);
			card.hidden = !(categoryMatch && queryMatch);
			if (!card.hidden) shown += 1;
		}
		for (const group of document.querySelectorAll("[data-doc-group]")) {
			group.hidden = ![...group.querySelectorAll("[data-blueprint-card]")].some((card) => !card.hidden);
		}
		if (result) result.textContent = `${shown} of ${cards.length} blueprints visible`;
		if (empty) empty.hidden = shown !== 0;
	};
	input.addEventListener("input", apply);
	for (const button of buttons) {
		button.addEventListener("click", () => {
			category = button.dataset.docFilter ?? "all";
			for (const peer of buttons) peer.classList.toggle("active", peer === button);
			apply();
		});
	}
	apply();
}

function switchTab(tabId) {
	for (const button of document.querySelectorAll(".tab-btn")) button.classList.remove("active");
	for (const pane of document.querySelectorAll(".tab-pane")) pane.classList.remove("active");
	const button = document.querySelector(`.tab-btn[onclick*="${tabId}"]`);
	if (button) button.classList.add("active");
	const pane = document.getElementById(`pane-${tabId}`) ?? document.getElementById(tabId);
	if (pane) pane.classList.add("active");
	initTableOfContents();
}

window.switchTab = switchTab;
window._switchTab = switchTab;
