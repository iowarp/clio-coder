---
name: pdb-structures
description: "Looks up macromolecular structures in the RCSB Protein Data Bank over its public REST APIs with web_fetch: entry metadata, method and resolution, entities and their UniProt mapping, ligands, full-text search, and coordinate file URLs, each answer stamped with the entry's revision. Not for modeling or docking."
---

# PDB structures (RCSB)

Answer structure questions from the RCSB PDB's own records, with the entry ID
and revision behind every number. Every call is a `web_fetch` GET to a public,
key-free API. Responses are JSON unless stated otherwise.

## Lookups

| Question | GET |
| --- | --- |
| Entry: title, method, resolution, release, revisions | `https://data.rcsb.org/rest/v1/core/entry/<ID>` |
| One polymer entity: sequence, chains, source organism | `https://data.rcsb.org/rest/v1/core/polymer_entity/<ID>/<entity id>` |
| The UniProt accession(s) an entity maps to | `https://data.rcsb.org/rest/v1/core/uniprot/<ID>/<entity id>` |
| A ligand or chemical component (`HEM`, `ATP`) | `https://data.rcsb.org/rest/v1/core/chemcomp/<comp id>` |
| Full-text search | `https://search.rcsb.org/rcsbsearch/v2/query?json=<URL-encoded query>` |

From an entry record, read these fields:

- `struct.title`
- `exptl[0].method`
- `rcsb_entry_info.resolution_combined` (in Å; absent for NMR)
- `rcsb_accession_info.initial_release_date`
- `rcsb_entry_container_identifiers.polymer_entity_ids`
- the last element of `pdbx_audit_revision_history` (`major_revision`, `minor_revision`, `revision_date`)

The entity IDs from `polymer_entity_ids` are what the entity and UniProt calls
take.

A search query for the `json` parameter, before URL encoding:

```json
{"query": {"type": "terminal", "service": "full_text", "parameters": {"value": "hemoglobin"}},
 "return_type": "entry", "request_options": {"paginate": {"start": 0, "rows": 10}}}
```

The result carries `total_count` and a `result_set` of `identifier` and `score`
rows. Fetch the entry records only for the few IDs you will report.

## Coordinate files

`https://files.rcsb.org/download/<ID>.cif` (mmCIF, always available) and
`https://files.rcsb.org/header/<ID>.cif` (header only). The legacy `.pdb`
format does not exist for every large structure. Do not pull a coordinate file
into the conversation. When the user wants it on disk, download it with `bash`
(`curl -fsSL -o <path> <url>`), then record its `sha256sum` and the entry's
revision next to the path.

## Cross-references

For an entity's UniProt accession, use the uniprot-proteins skill to describe
the protein. For a ligand's chemistry beyond its component record, use the
pubchem-compounds skill.

## Offline

Every lookup needs network. Offline, `web_fetch` fails. Say the PDB could not
be reached, and give no structure facts from memory. A coordinate file
downloaded earlier stays usable on disk.

## Final answer

Quote each fact with its entry ID and the revision it came from, for example
`4HHB rev 4.3, 2026-08-12`. For a search, state the query and its
`total_count`.
