#!/usr/bin/env python3
"""Check a hypothesis slate and screen its experiments for hazards, offline.

A slate is the JSON record the hypothesis-workflow skill writes before the
operator chooses: the question, the cited literature, the council's
hypotheses with their testability, the ranking, and the smallest experiment
for each top hypothesis. This script validates that record, runs a fixed
biological, chemical and radiological term screen over every hypothesis and
experiment, and prints the ranked options.

What it enforces:
- every literature statement names at least one source or says
  `"unsourced": true`; a hypothesis that cites grounding names only
  statements the slate holds;
- every hypothesis is falsifiable (a non-empty `prediction`), carries the
  testability fields, and has status `proposed`, the only status a slate may
  hold (a later claims record moves it to tested, supported or refuted);
- the ranking orders every hypothesis exactly once and is advice;
- the slate records no choice. A key such as `selected`, `chosen` or
  `choice` anywhere in it is an error: the operator's choice exists only as
  their own `ask_user` answer on the session decision board.

The term screen is a floor, not a judgment: a hypothesis the slate flags
itself, or the screen matches, needs the operator's explicit confirmation
before the choice. The script never contacts a network service and never
writes a file.

Exit codes: 0 valid, 1 the slate has errors, 2 the file could not be read
or is not JSON.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

SCHEMA = "clio-coder.hypothesis-slate.v1"
STATUSES_ALLOWED = {"proposed"}
CRITERION_KINDS = {"reproduce", "numeric-compare", "command", "manual"}
CHOICE_KEYS = re.compile(r"^(selected|selection|chosen|choice|operator_?choice|winner|picked?|accepted)$", re.IGNORECASE)
HYPOTHESIS_ID = re.compile(r"^H[0-9]+$")
TOP_N = 3

# Word-boundary patterns, matched case-insensitively. Broad on purpose: a
# false flag costs the operator one confirmation, a missed one costs more.
HAZARD_TERMS: dict[str, list[str]] = {
    "biological": [
        r"pathogen\w*", r"select agents?", r"BSL-?[34]", r"biosafety level [34]", r"gain[- ]of[- ]function",
        r"transmissib\w+", r"virulen\w+", r"aerosoli[sz]\w+", r"live (virus|viruses|bacteria)", r"viral (culture|passage|rescue)",
        r"bacillus anthracis", r"anthrax", r"ebola\w*", r"marburg", r"variola", r"smallpox", r"yersinia pestis", r"plague",
        r"botulinum", r"ricin", r"influenza (h5n1|h7n9)", r"h5n1", r"sars-cov\w*", r"prions?", r"toxins?",
        r"infect(ious|ed|ion) (animals?|mice|ferrets|primates)", r"dual[- ]use",
    ],
    "chemical": [
        r"nerve agents?", r"sarin", r"soman", r"tabun", r"vx", r"novichok", r"mustard gas", r"phosgene", r"chlorine gas",
        r"hydrogen cyanide", r"cyanides?", r"organophosph\w+", r"chemical weapons?", r"schedule [12] chemicals?",
        r"explosives?", r"energetic materials?", r"detonat\w+", r"azides?", r"peroxides?", r"perchlorates?",
        r"toxic gas\w*", r"pyrophoric", r"hydrofluoric acid", r"precursor synthesis",
    ],
    "radiological": [
        r"radioactiv\w+", r"radioisotopes?", r"radionuclides?", r"ionizing radiation", r"fissile", r"enriched uranium",
        r"plutonium", r"polonium", r"cesium-137", r"cobalt-60",
    ],
}
HAZARD_PATTERNS = {
    category: re.compile(r"\b(" + "|".join(terms) + r")\b", re.IGNORECASE) for category, terms in HAZARD_TERMS.items()
}


def text_of(value) -> str:
    if isinstance(value, str):
        return value
    if isinstance(value, list):
        return " ".join(text_of(item) for item in value)
    if isinstance(value, dict):
        return " ".join(text_of(item) for item in value.values())
    return ""


def screen(hypothesis: dict) -> dict[str, list[str]]:
    text = text_of({k: hypothesis.get(k) for k in ("statement", "prediction", "experiment", "testability")})
    found: dict[str, list[str]] = {}
    for category, pattern in HAZARD_PATTERNS.items():
        terms = sorted({match.group(0).lower() for match in pattern.finditer(text)})
        if terms:
            found[category] = terms
    return found


def choice_keys(value, path="$") -> list[str]:
    hits: list[str] = []
    if isinstance(value, dict):
        for key, child in value.items():
            if CHOICE_KEYS.match(str(key)):
                hits.append(f"{path}.{key}")
            hits.extend(choice_keys(child, f"{path}.{key}"))
    elif isinstance(value, list):
        for index, child in enumerate(value):
            hits.extend(choice_keys(child, f"{path}[{index}]"))
    return hits


def nonempty(value) -> bool:
    return isinstance(value, str) and value.strip() != ""


def check(slate: dict) -> dict:
    errors: list[str] = []
    warnings: list[str] = []
    if slate.get("schema") != SCHEMA:
        errors.append(f"schema must be {SCHEMA!r}")
    for hit in choice_keys(slate):
        errors.append(
            f"{hit}: a slate records no choice; the operator's choice is only their own ask_user answer (operator_only) on the decision board"
        )

    question = slate.get("question")
    if not isinstance(question, dict) or not nonempty(question.get("text")):
        errors.append("question.text is required")

    literature = slate.get("literature")
    if not isinstance(literature, list):
        errors.append("literature must be an array (empty when nothing was found)")
        literature = []
    statement_ids: set[str] = set()
    unsourced = 0
    for index, entry in enumerate(literature):
        where = f"literature[{index}]"
        if not isinstance(entry, dict):
            errors.append(f"{where} must be an object")
            continue
        entry_id = entry.get("id")
        if not nonempty(entry_id):
            errors.append(f"{where}.id is required")
        elif entry_id in statement_ids:
            errors.append(f"{where}.id {entry_id!r} is not unique")
        else:
            statement_ids.add(entry_id)
        if not nonempty(entry.get("statement")):
            errors.append(f"{where}.statement is required")
        sources = entry.get("sources") or []
        if entry.get("unsourced") is True:
            unsourced += 1
            if sources:
                errors.append(f"{where} is marked unsourced but lists sources")
        elif not isinstance(sources, list) or not sources:
            errors.append(f"{where} has no source: cite one or mark it \"unsourced\": true")
        else:
            for source_index, source in enumerate(sources):
                if not isinstance(source, dict) or not nonempty(source.get("id")):
                    errors.append(f"{where}.sources[{source_index}].id is required (a DOI, arxiv:<id>, PMID:<n> or URL)")
                elif source.get("verdict") not in ("VERIFIED", "MISMATCH", "NOT_FOUND", "UNAVAILABLE", "UNVERIFIED"):
                    errors.append(
                        f"{where}.sources[{source_index}].verdict must be VERIFIED, MISMATCH, NOT_FOUND, UNAVAILABLE or UNVERIFIED"
                    )
                elif source["verdict"] in ("MISMATCH", "NOT_FOUND"):
                    warnings.append(f"{where} cites {source['id']} with verdict {source['verdict']}")

    hypotheses = slate.get("hypotheses")
    if not isinstance(hypotheses, list) or not hypotheses:
        errors.append("hypotheses must be a non-empty array")
        hypotheses = []
    by_id: dict[str, dict] = {}
    for index, hypothesis in enumerate(hypotheses):
        where = f"hypotheses[{index}]"
        if not isinstance(hypothesis, dict):
            errors.append(f"{where} must be an object")
            continue
        hypothesis_id = hypothesis.get("id")
        if not isinstance(hypothesis_id, str) or not HYPOTHESIS_ID.match(hypothesis_id):
            errors.append(f"{where}.id must look like H1, H2, ...")
            continue
        if hypothesis_id in by_id:
            errors.append(f"{where}.id {hypothesis_id} is not unique")
            continue
        by_id[hypothesis_id] = hypothesis
        where = hypothesis_id
        for field in ("statement", "prediction"):
            if not nonempty(hypothesis.get(field)):
                errors.append(f"{where}.{field} is required" + (" (a falsifiable prediction)" if field == "prediction" else ""))
        status = hypothesis.get("status")
        if status not in STATUSES_ALLOWED:
            errors.append(f"{where}.status must be \"proposed\"; tested, supported and refuted come from later evidence")
        proposed_by = hypothesis.get("proposedBy")
        if not isinstance(proposed_by, list) or not all(nonempty(item) for item in proposed_by) or not proposed_by:
            errors.append(f"{where}.proposedBy must name the council members who proposed it")
        for ref in hypothesis.get("grounding") or []:
            if ref not in statement_ids:
                errors.append(f"{where}.grounding names {ref!r}, which is not a literature statement id")
        if not hypothesis.get("grounding"):
            warnings.append(f"{where} cites no literature statement")
        testability = hypothesis.get("testability")
        if not isinstance(testability, dict):
            errors.append(f"{where}.testability is required")
        else:
            for field in ("data", "cost", "time"):
                if not nonempty(testability.get(field)):
                    errors.append(f"{where}.testability.{field} is required")
            steps = testability.get("physicalSteps")
            if not isinstance(steps, int) or isinstance(steps, bool) or steps < 0:
                errors.append(f"{where}.testability.physicalSteps must be a non-negative integer")
        disagreements = hypothesis.get("disagreements", [])
        if not isinstance(disagreements, list):
            errors.append(f"{where}.disagreements must be an array")

    ranking = slate.get("ranking")
    order: list[str] = []
    if not isinstance(ranking, dict) or not isinstance(ranking.get("order"), list):
        errors.append("ranking.order is required: every hypothesis id, most testable first")
    else:
        order = [item for item in ranking["order"] if isinstance(item, str)]
        if sorted(order) != sorted(by_id) or len(order) != len(set(order)):
            errors.append("ranking.order must list every hypothesis id exactly once")
        if not nonempty(ranking.get("rationale")):
            errors.append("ranking.rationale is required (the same rationale recorded with decide)")

    ranked = []
    confirmations = []
    for rank, hypothesis_id in enumerate(order, start=1):
        hypothesis = by_id.get(hypothesis_id)
        if hypothesis is None:
            continue
        experiment = hypothesis.get("experiment")
        if rank <= TOP_N:
            if not isinstance(experiment, dict) or not nonempty(experiment.get("summary")):
                errors.append(f"{hypothesis_id} is ranked {rank} and needs experiment.summary")
            else:
                criterion = experiment.get("successCriterion")
                if not isinstance(criterion, dict) or criterion.get("kind") not in CRITERION_KINDS:
                    errors.append(f"{hypothesis_id}.experiment.successCriterion.kind must be one of {sorted(CRITERION_KINDS)}")
                elif not nonempty(criterion.get("statement")):
                    errors.append(f"{hypothesis_id}.experiment.successCriterion.statement is required")
                else:
                    computational = (hypothesis.get("testability") or {}).get("physicalSteps") == 0
                    if computational and criterion["kind"] == "manual":
                        warnings.append(
                            f"{hypothesis_id} needs no physical step but its success criterion is manual; write it as a reproduce or numeric-compare check"
                        )
                    if criterion["kind"] != "manual" and not nonempty(criterion.get("verifyId")):
                        errors.append(f"{hypothesis_id}.experiment.successCriterion.verifyId names the verify check it becomes")
        hazard = hypothesis.get("hazard") if isinstance(hypothesis.get("hazard"), dict) else {}
        matched = screen(hypothesis)
        flagged = hazard.get("flagged") is True or bool(matched)
        if flagged:
            confirmations.append(
                {
                    "id": hypothesis_id,
                    "flaggedBy": [name for name, on in (("slate", hazard.get("flagged") is True), ("screen", bool(matched))) if on],
                    "categories": sorted(set(matched) | set(hazard.get("categories") or [])),
                    "terms": matched,
                }
            )
        testability = hypothesis.get("testability") or {}
        ranked.append(
            {
                "rank": rank,
                "id": hypothesis_id,
                "statement": hypothesis.get("statement"),
                "prediction": hypothesis.get("prediction"),
                "proposedBy": hypothesis.get("proposedBy"),
                "disagreements": len(hypothesis.get("disagreements") or []),
                "data": testability.get("data"),
                "cost": testability.get("cost"),
                "time": testability.get("time"),
                "physicalSteps": testability.get("physicalSteps"),
                "experiment": (experiment or {}).get("summary") if isinstance(experiment, dict) else None,
                "successCriterion": ((experiment or {}).get("successCriterion") or {}).get("kind")
                if isinstance(experiment, dict)
                else None,
                "hazard": flagged,
            }
        )
    return {
        "ok": not errors,
        "errors": errors,
        "warnings": warnings,
        "literature": {"statements": len(literature), "unsourced": unsourced},
        "ranked": ranked,
        "hazardConfirmationsRequired": confirmations,
        "note": "The ranking is advice. Nothing here is a choice: the operator chooses through ask_user.",
    }


def markdown(report: dict) -> str:
    lines = [
        "| Rank | Id | Hypothesis | Prediction | Data | Cost | Time | Physical steps | Success criterion | Hazard |",
        "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ]
    for row in report["ranked"]:
        cells = [
            str(row["rank"]), row["id"], row["statement"] or "", row["prediction"] or "", row["data"] or "",
            row["cost"] or "", row["time"] or "", str(row["physicalSteps"]), row["successCriterion"] or "-",
            "flagged" if row["hazard"] else "-",
        ]
        lines.append("| " + " | ".join(str(cell).replace("|", "\\|").replace("\n", " ") for cell in cells) + " |")
    lines.append("")
    lines.append(report["note"])
    return "\n".join(lines)


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("slate", help="path to the slate JSON file")
    parser.add_argument("--markdown", action="store_true", help="also print the ranked options as a Markdown table")
    args = parser.parse_args(argv)
    try:
        slate = json.loads(Path(args.slate).read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        print(json.dumps({"ok": False, "errors": [f"cannot read {args.slate}: {error}"]}))
        return 2
    if not isinstance(slate, dict):
        print(json.dumps({"ok": False, "errors": ["the slate must be a JSON object"]}))
        return 2
    report = check(slate)
    print(json.dumps(report, indent=2))
    if args.markdown and report["ranked"]:
        print()
        print(markdown(report))
    return 0 if report["ok"] else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
