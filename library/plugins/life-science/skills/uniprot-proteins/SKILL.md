---
name: uniprot-proteins
description: "Looks up proteins in UniProtKB over the UniProt REST API with web_fetch: entries by accession, field-selected search, FASTA sequences, and cross-references such as PDB IDs, each answer stamped with the UniProt release and entry version. Not for sequence alignment or structure prediction."
---

# UniProt proteins

Answer protein questions from UniProtKB, with the accession, entry version and
UniProt release behind every fact. Every call is a `web_fetch` GET to
`https://rest.uniprot.org`, which is public and needs no key.

## Lookups

| Question | GET |
| --- | --- |
| One entry, complete | `https://rest.uniprot.org/uniprotkb/<accession>.json` |
| The sequence | `https://rest.uniprot.org/uniprotkb/<accession>.fasta` |
| Search, selected columns | `https://rest.uniprot.org/uniprotkb/search?query=<query>&fields=<fields>&format=tsv&size=<n>` |

Query syntax joins `field:value` terms with `AND`, `OR` and `NOT`. Examples:
`gene:HBA1 AND organism_id:9606 AND reviewed:true`, or `accession:P69905`.
`reviewed:true` limits results to Swiss-Prot, the manually reviewed entries.
Useful `fields` are `accession`, `protein_name`, `gene_names`,
`organism_name`, `length` and `xref_pdb`, the list of PDB IDs. Ask for `tsv`
with only the fields you need. A whole entry JSON is large, so fetch it only
for an accession you will describe.

From an entry record, read these fields:

- `primaryAccession`
- `proteinDescription.recommendedName.fullName.value`
- `genes`
- `organism.scientificName`
- `sequence.length`
- `entryAudit.entryVersion`
- `entryAudit.lastAnnotationUpdateDate`
- `comments`, for function, subcellular location and disease

`web_fetch` does not return response headers, so it cannot see UniProt's
`X-UniProt-Release` header. To find the current release, GET
`https://rest.uniprot.org/release-notes/search?query=*&size=3&sort=release_date%20desc`,
skip the `forthcoming-changes` row, and take the newest dated row, for example
`2026-11-04-release`. Quote that release date when the user needs to reproduce
an answer.

## Cross-references

A PDB ID from `xref_pdb` goes to the pdb-structures skill for its structure.
Going the other way, the PDB's `core/uniprot/<ID>/<entity>` record names the
accession. UniProt's ID mapping service takes POST requests, which need
outward approval. Prefer `xref_pdb` and other `xref_*` search fields, which are
GET.

## Offline

Every lookup needs network. Offline, `web_fetch` fails. Say UniProt could not
be reached, and give no annotation from memory.

## Final answer

Quote each fact with its accession and entry version, plus the UniProt release
date (for example `P69905 v220, release of 2026-11-04`). Say whether the entry is reviewed
(Swiss-Prot) or unreviewed (TrEMBL).
