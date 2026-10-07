# Sales reliability (DigitalTwin)

Canonical findings live in the Pi repo:

`../intelipump-fdc/docs/sales/sales-reliability-findings.md`

Stage-1 cloud/dashboard changes in this repo:

- Hangup / equal-value sale handling (UI + consumer)
- Integrity conflict detection on completed sales
- Optional `SALE_COMMITTED` application ACK publish after PostgreSQL commit
- Read-only dedupe preflight script
- LAB acceptance notes under `docs/sales-lab-acceptance.md`

Do not deploy stage-1 to SAO until LAB acceptance passes. Preserve unrelated local backend RBAC/edge-device edits.
