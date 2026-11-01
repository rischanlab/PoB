# Reproducibility

Every number in the IET Blockchain manuscript (v3.0, release v2.2.0) comes
from a CSV file in `data/results/`, produced by the commands below.

## Environment used for the reported results

| Item | Version |
|---|---|
| Node.js | 22.23.4 |
| npm | 10.9.9 |
| Hardhat | 3.11.1 (`@nomicfoundation/hardhat-toolbox-viem` 5.0.7, viem 2.55.10) |
| Solidity | 0.8.28 (solc-js, EVM target cancun) |
| OpenZeppelin | contracts 5.6.1, merkle-tree 1.0.8 |
| Python (data preparation, plot) | 3.x with matplotlib |

Record yours with `node --version`, `npm --version`, `npx hardhat --version`,
and `npm list --depth=0`.

If the Solidity compiler download is blocked, point Hardhat at a local solc:
`SOLC_PATH=$(pwd)/node_modules/solc/soljson.js npm test` (after
`npm install --no-save solc@0.8.28`).

## Reproduce all outputs

```bash
npm ci
npm run build
npm run generate:data          # synthetic positions, seed 42
npm run validate:treasury      # 4,864 identity checks on the bill-rate files
npm run reconcile:franklin     # off-chain leaf/aggregate/filing reconciliation
npm test                       # 62 tests (Hardhat prints 63: it counts test/helpers.ts)
npm run experiment:real        # full 1,043-day replay, 26 configurations (~6.5 min)
python3 scripts/plot-real-replay.py figures/real-replay-baseline.pdf
```

`npm test` also writes the scenario, gas, real-position, reconciliation,
FOBXX daily-flow, and trust-model CSVs, and the 70-day smoke replay.

## Which command produces which table

| Manuscript item | Command | Output |
|---|---|---|
| Table 2 (threats), Section 6.7 (trust cases) | `npm run experiment:trust` | `trust-model-results.csv` |
| Table 4 (changes and tests), test counts | `npm test` | test log |
| Table 6, Figure 2 (simulated replay) | `npm run experiment:real` | `real-replay-summary.csv`, `real-replay-daily-baseline.csv` |
| Table 7 (encumbrance sweep), accrual and persistence paragraphs | `npm run experiment:real` | `real-replay-summary.csv` |
| Table 8 (ablation) | `npm run experiment:real`, `npm run experiment:trust` | `real-replay-summary.csv`, `real-replay-gas.csv`, `trust-model-results.csv` |
| Table 9 (FOBXX snapshot) | `npm run experiment:real-positions`, `npm run experiment:fobxx-flows` | `real-position-*.csv/json`, `fobxx-daily-replay*.csv` |
| Table 10 (reconciliation) | `npm run experiment:real-positions`, `npm run reconcile:franklin` | `real-position-reconciliation.csv` |
| Table 11 (controlled scenarios), Table 12 (gas) | `npm run experiment` | `scenario-results.csv`, `gas-results.csv` |
| Atomic-issuance gas | `npm run experiment:atomic-gas` | `atomic-gas-*.csv` |

Run a subset of replay configurations with
`RWA_POB_CONFIGS=baseline,persistent npm run experiment:real` (writes
`*-subset.csv`).

## Test inventory (62 tests)

| File | Tests |
|---|---|
| `PoBPolicyController.ts` | 7 |
| `AtomicControllerToken.ts` | 23 |
| `InvariantStateMachine.ts` (128 seeded transitions, seed 42) | 1 |
| `ExperimentResults.ts` | 1 |
| `AtomicGasResults.ts` | 1 |
| `V2ReviewFixes.ts` | 14 |
| `RealPositionSnapshot.ts` | 5 |
| `FobxxDailyFlows.ts` | 1 |
| `PersistentController.ts` | 1 |
| `TrustModel.ts` | 7 |
| `RealDataReplay.ts` (smoke by default; full with `RWA_POB_REAL_REPLAY=1`) | 1 |

Tests check specified behaviour. They are not formal verification or an
audit.

## Determinism

- Synthetic reserve seed `42`, 100 positions; model-based test seed `42`.
- The replay uses no random numbers; the same inputs give the same decisions.
- Gas values vary by a few tens of gas between runs because EIP-712
  signatures depend on block timestamps. Gas is local EVM execution only.
- Versions are pinned by `package-lock.json`.

## Datasets and vintages

| Dataset | File | Meaning | Vintage |
|---|---|---|---|
| USDY Bridged Token Value (Dollar), RWA.xyz | `data/raw/rwa-xyz-usdy-market-caps-2026-11-01.csv`, `data/input/usdy-observed-token-value.csv` | Bridged token supply x issuer-reported NAV, summed over 12 chains. A proxy for holders' claims, not issuer liability records | Downloaded 1 Nov 2026; 18 Sep 2023 - 26 Jul 2026 |
| U.S. Treasury Daily Treasury Bill Rates | `data/raw/treasury/` | Official bank-discount and coupon-equivalent rates, 4-52 weeks | Aug 2023 - Jul 2026, 750 business days |
| FOBXX Form N-MFP3 | `data/raw/franklin/fobxx-nmfp3-2026-09-30.xml` | Positions, totals, daily flows and liquid assets as filed | Report date 30 Sep 2026 |
| Ondo USDY composition | parameters in `test/RealDataReplay.ts` | Published reserve mix | 29 Oct 2026 (after the replay window: retrospective calibration) |

## Data interpretation

Observed, inferred, modelled, and synthetic inputs are listed in
`data/input/README.md` and Table 5 of the manuscript. Daily USDY flows are
inferred from the token-value series and are not observed subscriptions or
redemptions. The repository does not reconstruct or audit USDY's reserves.
