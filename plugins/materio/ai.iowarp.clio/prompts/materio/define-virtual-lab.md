---
description: "Interview to map all available lab resources; equipment, HPC, software, collaborations; into a VIRTUAL-LAB.md that guides feasible task planning"
---

<clio_execution>
Read ${component:resource:clio-execution} before acting. It defines argument parsing,
research state helpers, interview ownership, readback, and optional recording.
</clio_execution>

<clio_dispatch>
Select the named recipe with dispatch({agent:"materio-...", task:"assignment with
full context and exact permitted outputs", intent:{write_roots:["exact/output"]}}).
Replace the illustrative recipe/path with those stated in this command. Use the
registered dispatch fields shown here.
Read the recipe's bound skill references and inline required templates, domain
sections, answers and selected state into the worker task. Each dispatch starts
fresh: re-dispatch with the full original context, prior candidates/outputs and
the new selection, corrections, revisions or resume answer. Use monitor if the
returned run is still active. Do not infer a resumed transcript from a run ID.
Honor admission refusals instead of broadening write scope.

Agent returns are mutation-report JSON. Route on the beginning of summary using
the status branches below. For checkpoints, distinguish
`needs_input: checkpoint:decision`, `needs_input: checkpoint:human-action`, and `needs_input: checkpoint:human-verify`;
ask the exact question(s), collect the answer and re-dispatch. No new top-level
status fields are allowed. A conforming JSON result is not proof of completion.
After EVERY dispatch that wrote, use ls and read on every reported output and on
the command's required files, including loop_back and partial checkpoint returns.
Verify nonempty content and the promised changes before presenting success or
continuing; re-dispatch with any missing/incorrect file named. Treat actual failed
validation or execution as failure even when summary claims completion.
</clio_dispatch>

<execution_context>
@.research/RESEARCH.md
@.research/LITERATURE.md
@${pluginRoot}/assets/templates/VIRTUAL-LAB.md
@${pluginRoot}/assets/references/research-domains.md
</execution_context>

<objective>
Build a complete map of the researcher's available resources. The resulting VIRTUAL-LAB.md is used by define-research-tasks and execute-task to ensure workflow steps are feasible and protocols match available equipment.

**Orchestrator role:** Load research context, run the resource interview (quick dump or guided by category, with questions targeted to the methods the field uses), spawn the materio-lab-definer agent to structure and gap-analyze, present the summary and gaps for verification, re-dispatch the agent with corrections, record.

**Why the interview lives here:** These worker roles return questions to the orchestrator. The agent gets a fresh context for the cross-referencing that benefits from it: matching what the researcher has against what the literature says the field uses, and building the resource-to-task mapping.
</objective>

<context>
No arguments. Reads .research/RESEARCH.md and LITERATURE.md to ask targeted resource questions.
</context>

<process>

Worker write scope: .research/VIRTUAL-LAB.md.


## 1. Validate Environment

```bash
[ ! -f .research/RESEARCH.md ] && echo "ERROR: No RESEARCH.md. Run /materio:identify-research first." && exit 1
[ -f .research/VIRTUAL-LAB.md ] && echo "WARN: VIRTUAL-LAB.md already exists; running again will update it."
cat .research/RESEARCH.md
grep -A 12 "Methodological Landscape" .research/LITERATURE.md 2>/dev/null
```

Extract the methods the field uses from the Methodological Landscape table (or, if LITERATURE.md is missing, from the domain's common methods in research-domains.md). These drive which equipment and software you ask about.

## 2. Quick Mode vs Guided Interview

Use ask_user:
- header: "Virtual Lab Setup"
- question: "I'll map your available research resources. How would you like to proceed?\n\n**Quick**: Paste or describe all your resources in one response (I'll structure it)\n**Guided**: I'll interview you by category (equipment, computing, software, collaborations)\n\nI'll cross-reference with the methods commonly used in your field ([domain from RESEARCH.md]: [methods]) to make sure I ask about the most relevant tools."
- options: "Quick; I'll describe everything at once" | "Guided interview by category"

## 3. Run the Interview

**Quick mode:** If the researcher's answer already contains the description, use it. Otherwise ask one free-form ask_user ("Describe your equipment, computing, software licenses, external facilities, budget, and people. Anything goes; I'll structure it.").

**Guided mode:** Three batched questions. Fill the bracketed lists from the field's methods so the researcher only sees relevant instruments.

Category 1:
- header: "Experimental Equipment"
- question: "What experimental equipment do you have access to?\n\nBased on your field ([domain/sub-field]), the most relevant categories are:\n\n**Characterization** (common in your field: [e.g., XRD, SEM, TEM]):\nFor each: in-house or external? Booking required? Key limitations?\n\n**Mechanical/Physical Testing** (if applicable):\n[tensile testing, fatigue, hardness, DMA; as relevant to domain]\n\n**Processing/Synthesis** (if applicable):\n[furnaces, deposition, arc melting, electrochemistry; as relevant]\n\n**Other**: Any specialized equipment not in these categories?"
- options: "Provided details" | "Mostly computational; minimal experimental equipment" | "External facilities only"

Category 2:
- header: "Computational Resources"
- question: "What computational resources do you have?\n\n1. **HPC systems**: Cluster name, cores available per job, scheduler (SLURM/PBS), key software installed ([VASP, LAMMPS, Abaqus; as relevant]), queue wait times?\n2. **Local machines**: CPU/GPU specs for smaller calculations?\n3. **Cloud compute**: AWS, GCP, Google Colab, XSEDE/ACCESS allocation?\n4. **Software licenses** (beyond HPC): VASP, Thermo-Calc, Abaqus, MATLAB, OriginPro; which do you have?\n\nNote: Open-source tools (LAMMPS, QE, Python, VESTA) assumed available; only mention if there are access issues."
- options: "Provided details" | "No computational resources; experimental only" | "Primarily computational"

Category 3:
- header: "External Facilities & Collaborations"
- question: "Do you have access to resources outside your direct lab?\n\n1. **User facilities**: National labs (APS, NSLS-II, ORNL, etc.), synchrotron access, neutron sources; proposal-based or through collaborator?\n2. **Core facilities**: University-level shared equipment (TEM center, nanofab, etc.); fee-for-service?\n3. **Industry/national lab collaborators**: Anyone providing materials, measurements, or compute?\n4. **Budget**: Rough estimate for experiments ($/month or total project)?\n5. **Timeline constraints**: Any equipment booking backlogs, seasonal access issues, or certifications not yet held?"
- options: "Provided details" | "No external access" | "Primarily internal resources"

Assemble all answers verbatim into `<resource_input>`.

## 4. Spawn materio-lab-definer Agent

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 Materio ► DEFINING VIRTUAL LAB
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

Use dispatch with `agent: "materio-lab-definer"` and a task containing the assignment and full context. The prompt carries:
- `<research>`; full RESEARCH.md (domain, prompt, scope)
- `<literature>`; LITERATURE.md methodological landscape section, or "not available"
- `<resource_input>`; the interview transcript from Step 3
- `<lab_path>`; `.research/VIRTUAL-LAB.md`

## 5. Verify with the Researcher

**`virtual_lab_defined:`:**

```bash
test -s .research/VIRTUAL-LAB.md && echo OK || echo "ERROR: VIRTUAL-LAB.md missing"
```
If missing, re-dispatch the agent and say so.

Use ask_user:
- header: "Verify Virtual Lab"
- question: "Here's your lab profile summary:\n\n**Experimental**: [N items; key equipment list]\n**Computational**: [HPC + local + cloud summary]\n**Software**: [key licenses]\n**External**: [N facilities]\n\n**Gaps flagged** ([N]):\n- [method]: [reason] → [alternative]\n\n**Details that would sharpen feasibility** (optional):\n- [equipment]: [missing detail]\n\nLook accurate? Anything to correct or add?"
- options: "Looks good; save it" | "I need to correct something" | "I have answers to the follow-ups"

If corrections or follow-up answers: re-dispatch the agent with a `<corrections>` block (or re-spawn with the full `<resource_input>` plus `<corrections>`), then re-verify the file.

**`needs_input: checkpoint:decision`, `needs_input: checkpoint:human-action`, or `needs_input: checkpoint:human-verify`:** A gap makes the current prompt infeasible. Present the options via ask_user, then re-dispatch the agent with the decision. If the researcher narrows the prompt, note the decision in STATE.md.

## 6. Record

```bash
python3 "${component:script:research-state}" record --message "research: virtual lab defined; [N] equipment, [N] compute resources" --files "${CHANGED_FILES[@]}"
```

</process>

<offer_next>

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 Materio ► VIRTUAL LAB DEFINED ✓
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Lab profile: .research/VIRTUAL-LAB.md

Experimental:  [N] equipment items ([key ones])
Computational: [HPC systems] + [local/cloud]
Software:      [key licenses]
External:      [N] facilities/collaborations
Gaps flagged:  [N] → [e.g., "No TEM access; external core lab, 2–3 weeks"]

───────────────────────────────────────────

## ▶ Next Up

**Build your research workflow**
(now resource-aware; tasks will only use available equipment)

`/materio:define-research-tasks`

<sub>Each dispatch starts with fresh worker context.</sub>

───────────────────────────────────────────

**Also available:**
- `/materio:upload-data`; register existing datasets before planning tasks
- `/materio:literature-review`; continue reviewing if not complete

</offer_next>

<success_criteria>
- [ ] Every question to the researcher was asked by this command, not by the agent
- [ ] Questions targeted to the field's methods (from LITERATURE.md), not a generic checklist
- [ ] Both experimental AND computational resources captured
- [ ] Software licenses documented
- [ ] External facilities and collaborations recorded
- [ ] Gaps and follow-up details presented for verification before saving
- [ ] Resource-to-task mapping table populated
- [ ] VIRTUAL-LAB.md verified on disk; commit only if commit_research is true
</success_criteria>
