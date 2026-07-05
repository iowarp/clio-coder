document.addEventListener("DOMContentLoaded", () => {
	initCopyButtons();
	initTableOfContents();
	initActiveSectionHighlighting();
});

// Clipboard copier for all pre blocks
function initCopyButtons() {
	const codeBlocks = document.querySelectorAll("pre");
	codeBlocks.forEach((block) => {
		// Skip if copy button already exists
		if (block.querySelector(".copy-btn")) return;

		// Make pre block keyboard focusable
		block.setAttribute("tabindex", "0");

		const button = document.createElement("button");
		button.type = "button";
		button.className = "copy-btn";
		button.innerText = "Copy";
		button.setAttribute("aria-label", "Copy code snippet");

		button.addEventListener("click", () => {
			const code = block.querySelector("code") || block;
			let text = code.innerText;
			// Strip out the "Copy" button text itself if it got selected
			if (text.startsWith("Copy\n")) {
				text = text.replace("Copy\n", "");
			}

			navigator.clipboard
				.writeText(text.trim())
				.then(() => {
					button.innerText = "Copied!";
					button.style.color = "var(--color-emerald)";
					setTimeout(() => {
						button.innerText = "Copy";
						button.style.color = "var(--text-muted)";
					}, 2000);
				})
				.catch(() => {
					button.innerText = "Failed";
					button.style.color = "var(--color-rose)";
				});
		});

		block.appendChild(button);
	});
}

// Automatically generate table of contents from h2/h3 tags
function initTableOfContents() {
	const tocList = document.querySelector(".toc-list");
	if (!tocList) return;

	// Clear existing static items if any
	tocList.innerHTML = "";

	const headings = document.querySelectorAll("main h2, main h3, .tab-pane h2, .tab-pane h3");
	if (headings.length === 0) {
		const sidebar = document.querySelector(".sidebar");
		if (sidebar) sidebar.style.display = "none";
		// Adjust layout if sidebar is hidden
		const layout = document.querySelector(".page-layout-grid");
		if (layout) layout.style.gridTemplateColumns = "1fr";
		return;
	}

	headings.forEach((heading, idx) => {
		// Generate id if not present
		if (!heading.id) {
			heading.id = heading.textContent
				.toLowerCase()
				.replace(/[^a-z0-9]+/g, "-")
				.replace(/(^-|-$)/g, "");
			if (!heading.id) heading.id = `heading-${idx}`;
		}

		const li = document.createElement("li");
		li.style.paddingLeft = heading.tagName.toLowerCase() === "h3" ? "1rem" : "0";

		const a = document.createElement("a");
		a.href = `#${heading.id}`;
		a.className = "toc-link";
		a.innerText = heading.textContent.replace(/[\u2192\u2022]/g, "").trim(); // strip arrow/bullet glyphs if any

		li.appendChild(a);
		tocList.appendChild(li);
	});
}

// Highlight active TOC item on scroll
function initActiveSectionHighlighting() {
	const tocLinks = document.querySelectorAll(".toc-link");
	if (tocLinks.length === 0) return;

	const headings = Array.from(document.querySelectorAll("main h2, main h3, .tab-pane h2, .tab-pane h3")).filter(
		(h) => h.id,
	);

	window.addEventListener("scroll", () => {
		let currentId = "";
		const scrollPosition = window.scrollY + 100;

		for (const heading of headings) {
			if (heading.offsetTop <= scrollPosition) {
				currentId = heading.id;
			}
		}

		tocLinks.forEach((link) => {
			link.classList.remove("active");
			if (currentId && link.getAttribute("href") === `#${currentId}`) {
				link.classList.add("active");
			}
		});
	});
}

// Standard Tab Switcher
function switchTab(tabId) {
	// Deactivate all
	document.querySelectorAll(".tab-btn").forEach((btn) => {
		btn.classList.remove("active");
	});
	document.querySelectorAll(".tab-pane").forEach((pane) => {
		pane.classList.remove("active");
	});

	// Find active button
	const activeBtn = document.querySelector(`.tab-btn[onclick*="${tabId}"]`);
	if (activeBtn) activeBtn.classList.add("active");

	const activePane = document.getElementById(`pane-${tabId}`) || document.getElementById(tabId);
	if (activePane) activePane.classList.add("active");

	// Re-initialize TOC in case new tab contains different headings
	initTableOfContents();
}

// Make sure switchTab is globally accessible
window.switchTab = switchTab;
window._switchTab = switchTab;
