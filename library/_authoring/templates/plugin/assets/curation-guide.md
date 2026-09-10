# Dataset Curation Guide

Guidelines for curating and validating scientific research datasets.

## FAIR Principles Checklist

1. **Findable**:
   - Unique persistent identifier or stable local path.
   - Comprehensive metadata descriptor (e.g. `datapackage.json` or `README.md`).
2. **Accessible**:
   - Clear retrieval instructions and standard open file formats (CSV, Parquet, NetCDF, HDF5, JSON).
3. **Interoperable**:
   - Documented vocabulary, standard units (SI), and recognized domain conventions (e.g., Climate and Forecast CF conventions).
4. **Reusable**:
   - Explicit license specification (e.g., CC-BY-4.0, CC0, Apache-2.0).
   - Data provenance and generation parameters recorded.

## Quality Invariants

- No unencoded NaN or infinite values without documented sentinel symbols.
- Timestamp formats follow ISO 8601 (`YYYY-MM-DDTHH:MM:SSZ`).
- Geospatial coordinates follow WGS84 with explicit latitude/longitude bounds.
