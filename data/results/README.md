# Experiment results

All files are generated; do not hand-edit them. Record the Git commit used.

| Command | Files |
|---|---|
| `npm run experiment` | `scenario-results.csv`, `gas-results.csv` |
| `npm run experiment:atomic-gas` | `atomic-gas-raw.csv`, `atomic-gas-summary.csv`, `atomic-gas-comparison.csv` |
| `npm run experiment:real` | `real-replay-summary.csv`, `real-replay-gas.csv`, `real-replay-daily-baseline.csv` (26 configurations, including ablation A1-A3, encumbrance sweep, accrual and persistence variants) |
| `npm test` (smoke replay) | `real-replay-smoke.csv`, `real-replay-gas-smoke.csv` |
| `npm run experiment:real-positions` | `real-position-snapshot.json`, `real-position-policy.csv`, `real-position-challenges.csv`, `real-position-reconciliation.csv` |
| `npm run experiment:fobxx-flows` | `fobxx-daily-replay.csv`, `fobxx-daily-replay-summary.csv` |
| `npm run experiment:trust` | `trust-model-results.csv` |

Column notes for `real-replay-summary.csv`: `subscription_days` and
`redemption_requests` count *inferred* net-inflow and net-outflow days;
`v1_unsafe_mints` counts inferred mints that would satisfy the
*reconstructed* v1 rule while the post-mint BCR is below the threshold (the
v1 contract itself is executed only in `test/V2ReviewFixes.ts`);
`attestation` is `role-scoped` or `single`; `liquidity_policy=false` means
every redemption is instant while the snapshot is fresh; `persistent=true`
means one controller for all 1,043 days; `liability_conservation_violations`
is checked in persistent mode.
