(() => {
	const root = document.querySelector("#films");
	if (!root) return;

	function escapeHtml(value) {
		return String(value).replace(/[&<>"']/g, (character) => {
			return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[character];
		});
	}

	fetch("content/recordings.json")
		.then((response) => response.json())
		.then((items) => {
			root.innerHTML = items
				.map((item) => {
					const frame = item.id
						? `<iframe src="https://www.youtube-nocookie.com/embed/${encodeURIComponent(item.id)}" title="${escapeHtml(item.title)}" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" allowfullscreen></iframe>`
						: `<p class="film-empty">No recording yet. The written lab below is the session.</p>`;
					const caption = item.lab
						? `<a href="#${escapeHtml(item.lab)}">${escapeHtml(item.title)}</a>`
						: escapeHtml(item.title);
					return `<figure class="film"><div class="film-frame">${frame}</div><figcaption>${caption}</figcaption></figure>`;
				})
				.join("");
		})
		.catch(() => {
			root.innerHTML = "<p>Recordings could not be loaded.</p>";
		});
})();
