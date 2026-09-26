# Clio Coder site

Public draft for **coder.iowarp.ai**. Static files. No build step.

Preview:

```bash
python3 -m http.server 4173 --directory site
```

Open http://127.0.0.1:4173/ . Do not open the HTML files directly; the docs reader fetches markdown.

`clio.iowarp.ai` can redirect here. Keep the product name **Clio Coder** either way.

Refresh the hosted docs from the repository:

```bash
python3 site/sync-docs.py
```

Add a YouTube recording by setting `id` in `site/content/recordings.json`. Leave it empty until the film exists.

Post copy and images: `share.html`. Attach `assets/social-square.png` until the domain resolves. After that, posting `https://coder.iowarp.ai` unfurls `assets/social-card.png`.

Regenerate the cards, after a font or copy change:

```bash
google-chrome --headless=new --disable-gpu --hide-scrollbars \
  --force-device-scale-factor=2 --window-size=1200,630 \
  --screenshot=site/assets/social-card.png \
  file://$PWD/site/cards/link.html
```

Container, when you want one: `docker compose up --build` in this directory. It listens on 127.0.0.1:8096. Wiring it to Traefik is a deploy step, not part of this draft.
