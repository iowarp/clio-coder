---
description: Inspect or update research network, checkpoint, and commit settings.
---

Read ${component:resource:clio-execution}. Run
`python3 "${component:script:research-state}" config` and display effective values:
web_search (default false, controls provided-URL fetching and Crossref queries),
auto_checkpoint (default true), and commit_research (default false).
Model and target selection belongs to Clio's configured targets; no plugin setting
silently changes host models. Supplied data lives at `.research/data/`.

Ask with ask_user which settings to change. Preserve unrelated existing config
fields. Write only actual boolean values in .research/config.json, then run the
config helper again and read the file back. Malformed configuration needs repair
before dependent work. An existing authorization remains valid; do not repeatedly
ask to reconfirm the same choice. Report the effective values and implications.
