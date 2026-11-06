---
name: pubchem-compounds
description: "Looks up small molecules in PubChem over PUG REST with web_fetch: name or SMILES to CID, computed properties (formula, weight, SMILES, InChIKey, IUPAC name), synonyms, with request pacing inside PubChem's usage limits. Not for property prediction or synthesis planning."
---

# PubChem compounds

Resolve a compound to its PubChem CID, and read the properties PubChem
computed for it. Every call is a `web_fetch` GET under
`https://pubchem.ncbi.nlm.nih.gov/rest/pug/`, which is public and needs no key.

## Lookups

| Question | GET |
| --- | --- |
| Name to CID | `compound/name/<name>/cids/JSON` |
| SMILES to CID | `compound/smiles/cids/JSON?smiles=<URL-encoded SMILES>` |
| Properties of one or more CIDs | `compound/cid/<cid,cid>/property/MolecularFormula,MolecularWeight,SMILES,ConnectivitySMILES,InChIKey,IUPACName/JSON` |
| Synonyms | `compound/cid/<cid>/synonyms/JSON` |

Prefix each path with `https://pubchem.ncbi.nlm.nih.gov/rest/pug/`.
Properties come back under `PropertyTable.Properties`. `SMILES` includes
stereochemistry and isotopes. `ConnectivitySMILES` omits them. PubChem renamed
these properties, and a request for the older `CanonicalSMILES` now returns
`ConnectivitySMILES`. `MolecularWeight` is a string in g/mol.

A name can map to several CIDs, for example a mixture and a parent compound.
Report every CID the lookup returns, and say which one you describe. An
unknown name returns HTTP 404 with `Fault.Code` `PUGREST.NotFound`. That means
PubChem has no such name, not that the compound does not exist.

## Pacing

PubChem's usage policy allows at most five requests per second, 400 per
minute, and 300 seconds of server time per minute. NCBI's general scripting
guideline is at most three requests per second. Batch CIDs in one property call
(comma-separated) instead of one call each, and stay under three requests per
second. An `HTTP 503` or a red `X-Throttling-Control` status means stop.
Do not retry in a loop.

## Offline

Every lookup needs network. Offline, `web_fetch` fails. Say PubChem could not
be reached, and give no structure or property from memory.

## Final answer

Name each compound with its CID and the PubChem property names you quote. When
a value came from a depositor record rather than PubChem's computation, say so.
