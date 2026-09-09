---
name: materials-characterization-lab-definer
description: "Structure resource interviews into a feasibility map with gaps and alternatives."
---

Interview the researcher about actual experimental and computational resources, software licenses, collaborators, people, budget, and access constraints. Write .research/VIRTUAL-LAB.md with available resources and the resource-to-task feasibility mapping. Surface blocked methods and realistic alternatives for researcher review.

Read the [shared research policy](../../assets/references/research-policy.md) for
state, provenance, execution boundaries, and advisory validation.

Read the linked references when needed. Resolve links from this skill directory.
If acting as a worker, return questions to the orchestrator; when acting as the
interactive assistant, collect the researcher answers directly using the host's
conversation facility.

- [research-domains.md](../../assets/references/research-domains.md)
- [VIRTUAL-LAB.md](../../assets/templates/VIRTUAL-LAB.md)

## Resource Maps Should Be Targeted, Not Exhaustive

A materials science researcher working on CALPHAD modeling does not need SEM sample prep rows filled in. A synthetic chemist does not need LAMMPS. Read LITERATURE.md's methodological landscape to learn which tools the field uses, and prioritize those when judging what is missing.

## Feasibility Is the Goal

VIRTUAL-LAB.md is used downstream by the workflow-planner to assign only tasks that can actually be done. Every resource entry must carry enough detail for that decision:
- "SEM available" is not enough → need: EDS capability? Max sample size? Booking lead time?
- "HPC available" is not enough → need: Which software is installed? How many cores per job? Queue wait?

When a detail is missing, write `unspecified` in the table and add the item to the follow-up list in your return. Do not invent specifications.

## Always Flag Gaps

Cross-reference available resources against what the literature says is commonly used. If a common method in the field is NOT available, flag it explicitly with alternatives:
- "No VASP license → can use Quantum ESPRESSO (free) or request time on national facility"
- "No TEM in-house → external facility available at [university] core lab (lead time: 2-3 weeks)"



For each common method in the field that is NOT available:
```
GAP: [method]; commonly used in [domain] research
  Not available: [reason]
  Alternatives:
    A. [open-source or free alternative]
    B. [external facility, if known]
    C. [collaboration route]
  Impact: [how this limits the research scope]
```

If a gap makes the stated research prompt infeasible with every listed alternative, return `needs_input: checkpoint:decision` now: the researcher must decide before planning.

## Step 4: Build Resource-to-Task Mapping

Generate the mapping table that links resource types to workflow task types. This is what the workflow-planner reads.

Common mappings:
- SEM/TEM → characterization tasks (microstructure, composition)
- XRD → structural characterization tasks
- UTM/fatigue tester → mechanical testing tasks
- VASP/QE on HPC → DFT calculation tasks
- LAMMPS on HPC → MD simulation tasks
- Thermo-Calc → CALPHAD/phase diagram tasks
- Abaqus → FEM simulation tasks
- Python + data files → data-analysis tasks
- No experimental equipment → literature + computational tasks only



## Complete action guides

Read only the guide for the requested operation; it contains its interview and
state transitions. Resolve these links from this skill directory.

- [define-virtual-lab](../../assets/actions/define-virtual-lab.md)
