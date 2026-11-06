# Life-science pack

Three skills that answer questions from public life-science databases through
Clio's `web_fetch`. Each answer carries the identifier and version it came
from. The skills need no API key and declare no MCP server, and the pack
stores no credential.

```bash
clio-coder library install plugin:life-science --project
```

| Skill | Source | What it does |
| --- | --- | --- |
| `pdb-structures` | RCSB PDB Data and Search APIs | Entry metadata, method, resolution, revision, entities and their UniProt mapping, ligands, full-text search, and coordinate file URLs |
| `uniprot-proteins` | UniProt REST API | Entries by accession, field-selected search, FASTA, and cross-references such as PDB IDs, stamped with the entry version and UniProt release date |
| `pubchem-compounds` | PubChem PUG REST | Name or SMILES to CID, computed properties, and synonyms, paced inside PubChem's limits |

The skills point at each other: a PDB entity's UniProt accession, a UniProt
entry's PDB IDs, and a PDB ligand's chemistry in PubChem.

## Offline behavior

Every lookup is a live GET request. Offline, `web_fetch` fails, and each skill
says the source could not be reached instead of answering from memory. Nothing
is cached between sessions. A coordinate file the user asked to download stays
on disk, with its sha256 and the entry revision recorded beside it.

## Data sources and their terms

| Source | Terms, as each source states them |
| --- | --- |
| RCSB Protein Data Bank (`data.rcsb.org`, `search.rcsb.org`, `files.rcsb.org`) | "Data files contained in the PDB archive are available under the CC0 1.0 Universal (CC0 1.0) Public Domain Dedication", and "all data provided by RCSB PDB programmatic APIs are available under the same license." Users are encouraged to attribute the original authors of a structure. See https://www.rcsb.org/pages/usage-policy. |
| UniProt (`rest.uniprot.org`) | CC BY 4.0 "to all copyrightable parts of our databases"; cite UniProt as its help pages describe. UniProt makes no warranty of correctness and cannot grant rights that patents or other claims cover; medical or genetic information is for research and education only. See https://www.uniprot.org/help/license. |
| PubChem (`pubchem.ncbi.nlm.nih.gov`) | PubChem's usage policy for programmatic access: no more than five requests per second, 400 per minute, and 300 seconds of running time per minute. Violations can block access temporarily (Kim et al., "An update on PUG-REST", Nucleic Acids Res. 2018, PMC6030920). NCBI "places no restrictions on the use or distribution of the data", but submitters may hold intellectual property claims that NCBI cannot assess. NCBI's scripting guideline asks for at most three requests per second. See https://www.ncbi.nlm.nih.gov/home/about/policies/. |

The pack itself is Apache-2.0 and bundles no third-party code or data.
