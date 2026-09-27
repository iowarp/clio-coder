# Product articles and the personal channel

The product site helps a developer or curious newcomer understand fit, install
Clio Coder, connect a suitable model, and complete a useful first task. Lead with
what the user can do. A research institution is not a product benefit.

Anthony's personal site, akougkas.io, explains the insight, judgment, and research
direction behind the work. Its companion essays are distilled first-person
writing rather than another copy of the product guide. Link related articles in
context; give distinct pages distinct titles, descriptions, and canonical URLs.

## Article shape

Answer one concrete question in the opening. Describe the supported workflow,
relevant configuration, observable result, important limits, and a next action.
Usually 600–1200 words; keep paragraphs within DESIGN.md's 65-word limit.
Reference public user guides and release records. Distinguish documented behavior
from an independently executed demonstration. State the version scope when
commands or formats may change. Do not invent screenshots, benchmarks, costs,
adoption numbers, or testimonials.

Use existing Overview, Docs, and Tutorials navigation. The install section and
first-session tutorial are useful next actions. More articles are justified by
more answered user questions, not keyword permutations.

## First draft batch

- Choose a model for your project.
- Coordinate the coding agents you already use.
- Keep a long coding task on track.
- Check a change against your repository.
- Add skills and plugins deliberately.
- Work from a laptop with remote workers.

Manuscripts and review metadata are in `content/drafts/`. They are not registered
in `content/tutorials.json` and do not enter the normal public output. After
review, move approved Markdown to `content/tutorials/`, supply actual image
metadata and reading-time estimates, register it, and run the existing site
checks. Do not claim a tutorial was tested until its recorded workflow ran.

## Creator history and dates

Anthony's September 27, 2026 account dates the exploration to December 2023,
through early wrappers, Warpio, AWOC, and PanCode, with consolidation in the
current repository in April 2026. Distinguish the research lineage from the age
and maturity of the implementation. Credit upstream projects and contributors.
Do not manufacture dates for intermediate stages.

New writing uses its actual publication date. Historical release notes and
milestones use verified event dates. A newly authored guide about an old feature
is still newly authored. The current builder does not emit article publication
dates; do not imply a historical publishing record that it does not establish.

## Comparisons and adoption

Explain model choice, execution location, licensing, connector capabilities,
permissions, context controls, and inspection of results. Name modes and versions.
Opinion about separating model development from harness design belongs in a
clearly argued essay. Claims about better outcomes require repeatable tasks,
environments, checks, and a documented cost basis. Do not caricature other tools.

The desired outcome is a useful installed workflow. Search ranking and adoption
are hypotheses until measured. Aggregate npm downloads are a noisy proxy, not
unique installations. This site has no public telemetry; this content batch adds
no tracker or unsupported adoption claim.
