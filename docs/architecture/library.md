# Library architecture

> **Visual blueprint:** See the [Library architecture visual reference](../html/library_blueprint.html) in the source checkout.

Clio uses **library** for the collection and **package** for a distributable item. This name covers both local authoring and indexed distribution without suggesting a remote store or a purchase. CLI `library`, slash `/library`, the Library overlay and the bundled `library/registry.yaml` describe the same collection. The Pi API snapshot does not contain the retired command names, so top-level `plugins`, top-level `skills`, and `/resources` are removed rather than retained as aliases. `/skill` remains an activation action.

## Invariants

1. **One identity.** A package has a portable root `plugin.json`, one lowercase portable name and one explicit bounded Semantic Version. Its kind is `extensions["ai.iowarp.clio"].kind`, defaulting to `plugin`. Kinds are `plugin`, `skill`, `agent`, `prompt`, and `fleet`. One name owns one installation directory per scope; changing kind requires removal.
2. **One envelope.** Plugins may bundle many public resources. Single-resource kinds declare exactly one public component of their kind, expose exactly that file in their resource root, and can carry private supporting files. Skills normally use `skills/`; a standalone skill package may use `resources.skills: "."` with a root `SKILL.md`.
3. **One integrity rule.** The package digest covers every file and directory, including manifests, scripts, references and eval suites. Links must remain contained; hard links and special files are refused. Staging and publication recheck the digest. Neither force nor pin silently approves a changed indexed source. Installed drift revokes resource admission.
4. **One durable state.** The existing plugin engine owns complete packages at user and project scope. State records kind, source, origin, trust, time and digest. Atomic staging, state locking, preimage checks and recovery copies apply to every kind. There is no library-specific installer or per-kind pin store.
5. **One workspace picture.** Library discovery combines the bundled, user, project and explicitly selected indexes with installed state. The list and overlay show disabled, damaged and shadowed copies. Effective loading uses the existing project-over-user plugin precedence. Explicit scope always selects exactly one copy.
6. **One dependency rule.** Manifest and index package requirements agree, are typed, and form a finite acyclic graph. Only enabled, verified packages satisfy dependencies. Install can plan missing dependencies with explicit inclusion; existing inactive dependencies require repair. Atomicity is per package, not a transaction across a dependency graph.
7. **Trust follows origin.** `installLibraryPackage({kind, sourcePath, scope, origin, trust, ...})` is exported from `src/domains/plugins/index.ts`. Interop supplies a reviewed prepared tree, `{kind: "interop", host, source: absoluteOriginalPath}`, and `trust: "foreign"`. Skill and prompt loaders honor foreign trust at either scope. Generic updates and forced replacement of adopted content refuse until explicit removal and reviewed re-adoption.
8. **Eval is an explicit action.** Named evals are contained suite files in the manifest. Installation does not execute them. `eval validate/run --package` resolves a local package or an active verified installation and includes package identity in suite provenance. Evals can execute authored commands in the declared workspace; validation alone does not execute them.
9. **Operator authority remains separate from autonomy.** Recognized model shell calls cannot install, update, enable, disable or remove package content through the library. Read-only inspection and install/update dry-runs remain available. Interop adoption with `--yes` is likewise an operator action. Runtime offers and overlays commit only through their bound approval paths.

## Identity at runtime

Package identity, component identity and invocation identity are distinct. The package reference is `kind:name`. A component reference such as `${component:agent:researcher}` is local to one package and resolves a contained file. It does not rename the agent. Prompt invocation names derive from paths beneath the prompt root, agent IDs derive from recipe filenames, and fleets use their authored names. Authors must choose unique runtime names, normally with their package prefix. Installation does not add an automatic colon namespace to agents or fleets.

This is a deliberate refinement of the earlier sprint proposal for automatic namespaces. It preserves Materio's `materio-*` agents and fleets, `/materio:*` prompts, and the WTF-P bridge targets `/wtfp:new-paper`, `/wtfp:map-project`, and `/wtfp:create-outline`. Runtime collisions continue to use each resource loader's documented precedence and diagnostics.

## Owners and boundaries

`src/domains/plugins` remains the internal engine name because it implements the portable manifest, filesystem integrity, installation state and enabled resource roots. `src/domains/resources/library.ts` composes discovery, registration, requirements and reviewed install plans. CLI and TUI consume those functions. The resources domain handles loader-specific schemas, trust and activation; it does not establish a second managed package lifecycle.

Unmanaged local resource files remain discoverable in established Clio and foreign roots. The worker's bounded raw-skill preparation helper and authoring audits are not library installations. Their normalized skill-body hashes describe activation/provenance evidence, not installable package integrity. Maintainer `skills:check` validates authored skill metadata and audit records; the release's distribution integrity rule is `library:check` over full package trees.

Harness extensions remain a separate executable integration contract for command tools and hook declarations. They cannot own domain resource roots. No new framework, registry server or installer is introduced by the library.
