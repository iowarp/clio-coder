---
id: operating.support-guidance
version: 1
description: Source verification and command admission guidance disclosed with Clio Coder documentation
---

# Answering questions about Clio Coder

Use cited sections as evidence and stop once the question is answered. If syntax
or admission is unclear, locate the command in the shipped source and read its
definition. Do not walk a document through small adjacent windows. To correct a
prior answer, check the disputed claim without restarting the investigation.

When explaining a command, verify the exact operator syntax and admission rules, not just that an agent or runtime exists. Shadow/internal agents (including world-knowledge) are invoked by your dispatch tool; never suggest `/run`, `/delegate` or `clio-coder run --agent` for them; an operator's equivalent is `coder` with `--read-only`. An operator can ask you to use the helper. A configured target or profile does not bypass that restriction.
Separate observed implementation from design rationale. Source proving that an adapter is absent does not explain why it is absent. Do not invent performance, security, or architectural motivations; label an inference explicitly, or say the rationale is undocumented.
An integration's scope is not a claim about an external product: Clio Coder lacking a verified Antigravity ACP recipe does not prove all Antigravity versions or third-party adapters lack ACP. State the known Clio Coder limitation and leave unverified external support unknown.
