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
npm test                       # 67 tests (Hardhat prints 68: it counts test/helpers.ts)
npm run experiment:real        # full 1,043-day replay, 39 configurations (~12 min)
python3 scripts/plot-real-replay.py figures/real-replay-supply.pdf data/results/real-replay-daily-supply.csv
python3 scripts/plot-real-replay.py figures/real-replay-baseline.pdf
```

Optional data rebuilds (outputs are committed):

```bash
npm run prepare:usdy-supply    # needs the RWA.xyz NAV export in data/raw/ (not redistributed)
npm run build:franklin-monthly # four monthly N-MFP3 XMLs -> data/input/franklin-fobxx-monthly/
```

`npm test` also writes the scenario, gas, real-position, reconciliation,
FOBXX daily-flow and monthly, variable-price ledger, and trust-model CSVs,
and the 70-day smoke replay.

## Which command produces which table

| Manuscript item | Command | Output |
|---|---|---|
| Table 2 (threats), Section 6.7 (trust cases) | `npm run experiment:trust` | `trust-model-results.csv` |
| Table 4 (changes and tests), test counts | `npm test` | test log |
| Section 6.1 (redemption price) | `npm run test:price` | `variable-price-ledger.csv` |
| Table 6, Figure 2 (supply-mode replay, price lag) | `npm run experiment:real` | `real-replay-summary.csv` (rows `supply-*`), `real-replay-daily-supply.csv` |
| Table 7 (inferred-flow replay) | `npm run experiment:real` | `real-replay-summary.csv`, `real-replay-daily-baseline.csv` |
| Table 8 (encumbrance sweep), accrual and persistence paragraphs | `npm run experiment:real` | `real-replay-summary.csv` |
| Table 9 (ablation) | `npm run experiment:real`, `npm run experiment:trust` | `real-replay-summary.csv`, `real-replay-gas.csv`, `trust-model-results.csv` |
| Table 10 (FOBXX snapshot) | `npm run experiment:real-positions`, `npm run experiment:fobxx-flows` | `real-position-*.csv/json`, `fobxx-daily-replay*.csv` |
| Table 11 (reconciliation) | `npm run experiment:real-positions`, `npm run reconcile:franklin` | `real-position-reconciliation.csv` |
| Table 12 (FOBXX five months) | `npm run experiment:fobxx-monthly` | `fobxx-monthly.csv` |
| Table 13 (controlled scenarios), Table 14 (gas) | `npm run experiment` | `scenario-results.csv`, `gas-results.csv` |
| Atomic-issuance gas, persistent-controller gas | `npm run experiment:atomic-gas`, `npm run experiment:real` | `atomic-gas-*.csv`, `real-replay-gas.csv` |

Run a subset of replay configurations with
`RWA_POB_CONFIGS=baseline,supply-baseline npm run experiment:real` (writes
`*-subset.csv`).

## Test inventory (67 tests)

| File | Tests |
|---|---|
| `PoBPolicyController.ts` | 7 |
| `AtomicControllerToken.ts` | 23 |
| `InvariantStateMachine.ts` (128 seeded transitions, seed 42) | 1 |
| `ExperimentResults.ts` | 1 |
| `AtomicGasResults.ts` | 1 |
| `V2ReviewFixes.ts` | 14 |
| `VariablePrice.ts` | 4 |
| `RealPositionSnapshot.ts` | 5 |
| `FobxxDailyFlows.ts` | 1 |
| `FobxxMonthly.ts` | 1 |
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
| USDY Bridged Token Value (Dollar), RWA.xyz | `data/input/usdy-observed-token-value.csv` (raw export not redistributed) | Bridged token supply x issuer-reported NAV, summed over 12 chains. A proxy for holders' claims, not issuer liability records | Downloaded 1 Nov 2026; 18 Sep 2023 - 26 Jul 2026 |
| USDY Net Asset Value (Dollar), RWA.xyz | `data/input/usdy-observed-supply.csv` (column `nav_usd`; raw export not redistributed) | Issuer-reported NAV per token; supply = value / NAV | Downloaded 1 Nov 2026; 1,140 days to 31 Oct 2026, 1,043 used |
| U.S. Treasury Daily Treasury Bill Rates | `data/raw/treasury/` | Official bank-discount and coupon-equivalent rates, 4-52 weeks | Aug 2023 - Jul 2026, 750 business days |
| FOBXX Form N-MFP3 | `data/raw/franklin/fobxx-nmfp3-2026-0{5-31,6-30,7-31,8-31,9-30}.xml` | Positions, totals, daily flows and liquid assets as filed | Report dates 31 May - 30 Sep 2026 (five filings) |
| Ondo USDY composition | parameters in `test/RealDataReplay.ts` | Published reserve mix | 29 Oct 2026 (after the replay window: retrospective calibration) |

## Data interpretation

Observed, inferred, modelled, and synthetic inputs are listed in
`data/input/README.md` and Table 5 of the manuscript. In the primary
(supply) mode, daily USDY flows are net changes of bridged supply (value /
NAV); in the sensitivity (inferred) mode they are inferred from the token
value with an accrual estimate. Neither is an observed primary-market
subscription or redemption record. The repository does not reconstruct or audit USDY's reserves.
