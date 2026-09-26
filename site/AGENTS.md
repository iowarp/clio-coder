# Work on the public site

Read DESIGN.md before editing. design-system.json is the sanctioned palette and copy policy. Use its shared motion tokens for consistent interactions. Do not introduce colors outside its tokens or edit generated css/brand.css directly. Run node site/tokens.mjs after an authorized token edit.

Keep primary navigation to Overview, Docs, Tutorials. Use real product imagery and accurate user-facing copy. Public documentation sources are explicitly listed in public-docs.json. Never publish internal architecture, development Wiki, audits, agent logs, or scratch records.

Use the explicitly sanctioned public footer wording: Copyright 2026 iowarp.ai. Keep root NOTICE and Apache 2.0 links. Use the product name Clio Coder; describe the local interfaces as desktop and terminal, with the desktop alpha qualifier.

Run node site/policy.mjs, python3 site/sync-docs.py --check, node site/build.mjs, python3 site/check.py, python3 site/image-variants.py --check, node site/browser-check.mjs, and node site/performance-check.mjs for material interface changes. Start node site/dev.mjs for a live local preview. Keep screenshots and review output outside published directories.
