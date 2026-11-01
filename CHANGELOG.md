# Changelog

All notable changes to the RWA-PoB prototype. The paper version for IET
Blockchain (`rwa_pob_iet.tex`) mirrors this release: every number in the
paper comes from the CSV files listed below.

## [2.2.0] - 2026-11-01 - Major revision

Response to the major-revision brief (priorities P1-P14). The IET Blockchain
manuscript v3.0 mirrors this release.

### Added

- `contracts/test/AblationController.sol` (test only): same accounting as the
  controller, with an optional single attestor (one verifier signature over
  the full snapshot) and an optional switch-off of the liquidity policy.
  `PoBPolicyController` functions `_verifyRoleScopedSignatures`, `canMint`,
  `canMintWithReceipt`, and `redemptionDisposition` are now `virtual`.
- `RWABackedToken.issueWithReceipt(recipient, amount, receivedCash, nonce,
  signature)`: mints against a custodian receipt in the same transaction that
  credits the cash (2 new tests in `AtomicControllerToken.ts`).
- `scripts/reconcile-snapshot.mjs` (`npm run reconcile:franklin`, also in
  CI): sums Merkle leaves and compares them with the signed aggregates and
  with the filing.
- `test/RealPositionSnapshot.ts`: reconciliation cases R0-R4, the
  100/80/90 reviewer example, and a threshold sweep (100, 99.7, 99.6, 99.5,
  99.0%) with and without a receipt (5 tests).
- `test/FobxxDailyFlows.ts`: the 21 business days of disclosed September 2026
  FOBXX flows on one controller (`npm run experiment:fobxx-flows`).
- `test/PersistentController.ts`: five epochs on one deployment with partial
  settlement across boundaries, receipt replay, policy update, lower epoch,
  expiry, custodian rotation, and an independent ledger check after each step.
- `test/TrustModel.ts`: executed cases T1-T6 (absent signer, compromised key
  role-scoped vs single attestor, compromised governance, collusion, role
  reassignment, expiry) (`npm run experiment:trust`).
- Replay configurations (26 in total): ablation A1-A3 and A1 under 4%
  encumbrance; encumbrance sweep 1, 2, 2.5, 3, 3.5%; accrual 7-day, 91-day,
  and T-bill-based; persistent and persistent-encumbered; 200 bp haircut.
  Summary CSV gained `attestation`, `mint_rule`, `liquidity_policy`,
  `persistent`, `accrual`, `liability_conservation_violations`.

### Changed

- `data/input/usdy-observed-liabilities.csv` renamed to
  `usdy-observed-token-value.csv`: RWA.xyz defines the metric as bridged token
  supply x issuer NAV, so it is a proxy liability.
- `prepare-franklin-nmfp3.py` also extracts daily liquid assets and NAV;
  the Merkle root is unchanged.
- Docs: README, REPRODUCIBILITY (environment, command-to-table map, test
  inventory, dataset vintages), data READMEs (evidence types).
- Plot legend: "Observed USDY token value, RWA.xyz (proxy liability)".

### Results (all from `data/results/`)

- 62 tests pass (Hardhat prints 63 including `test/helpers.ts`).
- Replay: 0 unsafe mints in all 26 runs; 0 conservation violations in
  persistent mode. Baseline 327 of 343 inferred inflows; persistent 327.
- Ablation: A1 289 (54 BCR rejections, all 232 redemptions instant, longest
  claim 61 days), A2 214, A3 327 = full. A1 also accepts 0 under 4%
  encumbrance, so eligibility accounting alone causes that result.
  Role scoping changes no decision on honest data, prevents T2, and costs
  87,443 gas per snapshot (350,193 vs 262,750).
- Encumbrance sweep: 327, 327, 26, 12, 6, 3, 0 accepted at 0-4%.
- Accrual: 91-day 354/370, T-bill 475/492; 7-day median breaks the inference.
- FOBXX: leaves reconcile; R1-R4 accepted on-chain, flagged off-chain; a
  USD 100 m receipt mint moves BCR only 99.68 -> 99.72%; daily flows 21/21
  accepted at 99.5%, 0/21 at 100%; closing liabilities equal the filed
  USD 667.97 m.

### Not implemented

- Variable redemption price (`P_red != 1`).
- On-chain aggregate (sum) reconciliation; liquidity-class challenge.
- Several monthly N-MFP3 filings (only 30 Sep 2026 available).

## [2.1.0] - 2026-11-01 - Real reserve positions

### Added

- Real position-level reserve snapshot from the Franklin OnChain U.S.
  Government Money Fund (FOBXX) Form N-MFP3 for 30 September 2026:
  `data/raw/franklin/fobxx-nmfp3-2026-09-30.xml` (SEC EDGAR, public record),
  `scripts/prepare-franklin-nmfp3.py`, `scripts/build-franklin-snapshot.mjs`,
  `data/input/franklin-fobxx/`, `test/RealPositionSnapshot.ts` (3 tests), and
  npm scripts `prepare:franklin`, `build:franklin`,
  `experiment:real-positions`.
- 85 real positions (83 securities, cash, other assets); the 83 CUSIP/value
  pairs match the fund's holdings PDF. Liquid value uses the fund's own
  weekly-liquid-asset flag; haircuts (0/10/25/50 bps by days to final
  maturity) are a stated policy assumption.
- 49 tests in total (46 + 3).

### Results

- All 85 positions verify on-chain against the committed root
  `0x8f8a056afb9827fa9711b33b5df17010fe9aec9c7a53e7a13fd6c882d56595c1`
  (proof length 6-7). `submitSnapshot` with the real aggregates: 391,392 gas.
- Eligible reserves USD 695.75 m against USD 697.99 m of liabilities: BCR
  99.68%. Liquid within 7 days USD 486.96 m (fund-reported weekly liquid
  assets USD 487.47 m). RLC against the largest five-business-day gross
  redemptions in September 2026 (USD 24.27 m): 2,006.51%.
- With minBCR 100% the controller rejects every mint, with or without a
  receipt. With minBCR 99.5% it accepts a USD 1 m mint, and the headroom
  without new cash is USD 1.25 m. The threshold has to follow the product.
- Five tampered real positions are caught by a challenge that suspends
  minting (66,000-67,556 gas). A long-dated note reported as liquid is not
  caught: the challenge rules do not compare liquidity with maturity. A naive
  maturity rule would wrongly flag 35 of the fund's 40 weekly-liquid
  positions (USD 288.90 m, maturities up to 365 days), so detection needs the
  regulatory liquidity class in each leaf.



This release fixes the defects found in review, replaces the synthetic-only
evaluation with an on-chain replay driven by real data, and keeps the
original controlled scenarios as an illustration.

### Reviewer issues and how they are fixed

| # | Review comment | Change | Where | Regression test |
|---|---|---|---|---|
| 1 | BCR is overstated after settlement: 100 eligible / 100 liabilities, settle 20, code reports 100/80 = 125% and allows minting | `confirmSettlement` now reduces liquid, eligible, **and** gross reserves (`liquidAssetsConsumed` is subtracted in `currentEligibleReserves()` and `currentGrossReserves()`). `currentBCR` and `bcrAfterMint` use the adjusted value | `contracts/PoBPolicyController.sol` | `test/V2ReviewFixes.ts` "v1 overstates BCR at 125%..." (runs the original contract, kept as `contracts/test/PoBPolicyControllerV1.sol`) and "v2 reports 100%... blocks a mint" |
| 2 | Each role signs the same aggregate numbers; the contract does not limit a role to its fields | Role-scoped EIP-712 claims. Custodian signs `CustodyClaim` (header + grossReserves); administrator signs `LiabilityClaim` (header + token, pending, other liabilities); valuation agent signs `ValuationClaim` (header + eligibleReserves, liquidAssets); legal role signs `LegalClaim` (header only, i.e. the reserve root); verifier signs the full `Snapshot`. Header = epoch, asOfTimestamp, validUntil, policyHash, reserveRoot. Signatures are supplied in fixed role order 0-4 | `PoBPolicyController.sol` (`hashRoleClaim`, `_verifyRoleScopedSignatures`), `test/helpers.ts` (`signSnapshot`) | "rejects a full-snapshot signature in a field-scoped role slot", "rejects correctly scoped signatures supplied out of role order", "a custodian signature cannot vouch for liabilities", "a role's signature does not cover fields outside its claim" |
| 3 | The contract does not verify the Merkle root | Position leaves (OpenZeppelin `StandardMerkleTree` encoding) can be verified on-chain (`verifyReservePosition`). `challengeReservePosition` is permissionless: a valid proof of a position that breaks the eligibility rules (encumbered / legally ineligible / unsettled but eligible; eligible above haircut value; liquid above eligible) suspends the snapshot | `PoBPolicyController.sol` | "on-chain leaf hash matches the OpenZeppelin StandardMerkleTree leaf", "rejects a challenge against a consistent position", "rejects a challenge with an invalid proof", "anyone can suspend minting by proving an encumbered position was counted" |
| 4 | 199.9999% and 39.9999% come from truncation; two decimals are enough | Ratios are rounded half-up to two decimals | `test/ExperimentResults.ts` (`ratioToPercent`), all replay outputs | `data/results/scenario-results.csv` now shows 114.12 / 96.34 / 200.00 / 40.00 |
| 5 | Evaluation uses deterministic synthetic scenarios only | New on-chain longitudinal replay over the full 1,043-day USDY liability series with reserves priced daily from official U.S. Treasury bill rates (see below) | `test/RealDataReplay.ts`, `data/raw/treasury/` | Replay asserts zero unsafe mints and a conservative on-chain view in every configuration |
| 6 | Settlement delays, liquidity fluctuations, institutional failures | Replay sweeps over settlement delay (T+0/T+1/T+3), snapshot cadence (daily/weekly/30-day), buffer (1.5/3/5%), encumbrance (4%), and a cleaned series | `test/RealDataReplay.ts` | `data/results/real-replay-summary.csv` |
| 7 | Coordinated misreporting, credential compromise, false declarations | Role scoping (a stolen key covers only its own fields), the Merkle challenge, and epoch-bound receipts; the paper adds a threat-to-mechanism-to-residual-risk table | contract + paper Table "Threat analysis" | tests in rows 2-3 |

### Added

- `authorizeMintWithReceipt(mintLiability, receivedCash, nonce, custodianSignature)`
  and `canMintWithReceipt(mintLiability, receivedCash)`. A custodian signs an
  EIP-712 `SubscriptionReceipt(uint64 epoch,uint256 amount,uint256 nonce)` for
  cash that arrived in the segregated account after the latest snapshot. The
  cash is credited to liquid, eligible, and gross reserves in the same
  transaction as the mint; if the policy check fails the call reverts and
  nothing is credited. Receipts are bound to the current epoch and cannot be
  replayed. `receivedCash` may exceed the mint when the issuer posts its
  buffer on the new subscription. Without receipts, a snapshot-based
  controller cannot follow real growth between snapshots.
- `creditedSubscriptionCash`, `usedSubscriptionReceipts`, events
  `SubscriptionCashCredited` and `ReservePositionChallenged`, errors
  `InvalidMerkleProof`, `PositionIsConsistent`, `InvalidSubscriptionReceipt`,
  enum `ChallengeReason`, struct `ReservePosition`.
- `contracts/test/PoBPolicyControllerV1.sol`: the submitted controller,
  renamed, used only to reproduce the v1 defect. Do not deploy.
- `test/V2ReviewFixes.ts`: 14 regression tests (table above).
- `test/RealDataReplay.ts`: real-data replay (70-day smoke run in CI; full run
  with `npm run experiment:real`).
- `data/raw/treasury/`: U.S. Treasury Daily Treasury Bill Rates, Aug 2023 -
  Jul 2026 (750 business days, public domain).
- `scripts/validate-treasury-bill-rates.py` (`npm run validate:treasury`):
  checks every row with the Treasury's bank-discount to coupon-equivalent
  identity, including Treasury's semi-annual formula for the 52-week bill.
  Result: 750 rows, 4,864 checks, 0 mismatches.
- `scripts/fetch-treasury-bill-rates.sh` (`npm run fetch:treasury`, add
  `-- --compare` to diff against the committed files).
- npm scripts `test:v2`, `experiment:real`, `validate:treasury`,
  `fetch:treasury`.
- `hardhat.config.ts`: optional `SOLC_PATH` to use a local solc (for example
  `node_modules/solc/soljson.js`) when the compiler download is blocked.

### Changed

- Snapshot signatures (breaking): `submitSnapshot` expects five role-scoped
  signatures in role order. `signSnapshot` in `test/helpers.ts` produces them;
  `signSnapshotV1` keeps the old full-snapshot signing for the v1 comparison.
- `currentEligibleReserves()`, `currentGrossReserves()`,
  `currentLiquidAssets()` = snapshot value + credited subscription cash -
  settled redemption cash (floored at 0).
- `data/raw/README.md`: removed a PowerShell wrapper that had been committed
  into the file; documents both data sources.
- `.gitignore`: `data/raw/treasury/` is committed (public-domain data).
- `scripts/prepare-usdy-data.mjs`: accepts an input path and `--until`, and
  reads both RWA.xyz layouts (one column per product, or one column per chain,
  which it sums). `data/input/usdy-*` and `data/input/usdy-scenarios/*` were
  regenerated from the 1 Nov 2026 export (latest value USD 2,161,446,182.11
  instead of 2,161,765,037.00).
- Gas results regenerated (the role-scoped verification costs about 8,400
  more gas per snapshot than v1).

### Real-data replay

**Data (real).** RWA.xyz "Bridged Token Value (Dollar)" for Ondo USDY, 1,043
daily observations, 18 Sep 2023 - 26 Jul 2026 (USD 30.28 million to USD 2.16
billion), from the USDY market-cap export downloaded on 1 Nov 2026 and summed
across its 12 chain columns. RWA.xyz had revised some history since the export
committed in v1.0.0: the two match to the cent up to 28 Oct 2024, 884 of 1,043
days agree within 0.1%, and some days in late Nov 2024 - early Jan 2025 are up
to 2.9% lower in the new export. All results below use the new export. U.S. Treasury Daily Treasury Bill Rates, 4- to 52-week bank-discount
rates; the 13-week rate ranges from 3.52% to 5.36%.

**Model (stated assumptions).** USDY's position-level holdings are not
public, so the reserve portfolio is modelled: a 2% cash target plus an
equal-weight 26-week bill ladder, priced daily from the real curve
(linear interpolation, price = 1 - d·τ/360). Haircut = price loss under a
+100 bp shock. Liquid = cash + bills maturing within 7 days. Accrual = trailing
31-day median daily growth; net flow = observed change minus accrual, applied
as a fraction of the previous day's value to the modelled supply. Flows below
0.001% of outstanding value are treated as zero. On snapshot days the
portfolio is rebalanced (cash above target into new 26-week bills, excess
over-collateralisation swept to the issuer); between snapshots it is not. The
issuer posts its buffer on new subscriptions (the custodian receipt covers
subscription plus top-up). Settlement is paid at T+delay (+2 days if queued),
limited by the controller's `currentLiquidAssets()`. A fresh controller is
deployed for each snapshot interval and open claims are re-registered.
θ_S = 101%, θ_L = 100%. The v1 settlement defect is measured as a shadow
metric in the same run (v1 BCR = snapshot eligible + credited cash, settlement
not deducted).

**Results** (`data/results/real-replay-summary.csv`; mint counts out of 343
subscription days, 339 for the cleaned series):

| Configuration | PoR mints | PoB mints | Rejected (BCR / RLC) | Queued redemptions | Days RLC < 100% | BCR range | Unsafe mints v2 | Unsafe mints under v1 logic | Max v1 BCR overstatement |
|---|---:|---:|---:|---:|---:|---|---:|---:|---:|
| Baseline (3% buffer, weekly, T+1) | 343 | 327 | 0 / 16 | 7 of 232 | 58 | 102.44-103.91% | 0 | 0 | 42.18 pp |
| Encumbered 4% | 343 | 0 | 343 / 88 | 73 of 232 | 284 | 98.41-100.49% | 0 | 43 (USD 9.60 m) | 10.68 pp |
| Buffer 1.5% | 343 | 262 | 66 / 32 | 32 of 232 | 123 | 100.74-101.78% | 0 | 19 (USD 30.95 m) | 42.18 pp |
| Buffer 5% | 343 | 327 | 0 / 16 | 7 of 232 | 58 | 104.44-106.75% | 0 | 0 | 42.18 pp |
| Settlement T+0 | 343 | 327 | 0 / 16 | 7 of 232 | 58 | 102.44-103.91% | 0 | 0 | 42.18 pp |
| Settlement T+3 | 343 | 327 | 0 / 16 | 7 of 232 | 58 | 102.44-103.91% | 0 | 0 | 42.18 pp |
| Daily snapshots | 343 | 281 | 0 / 62 | 68 of 232 | 194 | 102.53-104.22% | 0 | 0 | 23.93 pp |
| 30-day snapshots | 343 | 330 | 0 / 13 | 3 of 232 | 36 | 102.36-103.87% | 0 | 0 | 42.39 pp |
| Cleaned series | 339 | 323 | 0 / 16 | 7 of 228 | 58 | 102.33-103.46% | 0 | 0 | 12.72 pp |
| USDY published mix | 343 | 335 | 0 / 8 | 3 of 232 | 20 | 101.92-103.52% | 0 | 0 | 42.18 pp |
| USDY mix, encumbered 4% | 343 | 0 | 343 / 57 | 60 of 232 | 152 | 98.29-99.99% | 0 | 42 (USD 23.60 m) | 19.41 pp |

"Rejected (BCR / RLC)" counts rejected mints whose post-mint BCR or current
RLC was below its threshold; a mint can fail both (buffer 1.5%: 66 + 32
reasons for 81 rejections). In every configuration the on-chain liquid and
eligible values never exceeded the modelled portfolio
(`days_onchain_liquid_above_actual` = `days_onchain_eligible_above_actual` =
0), and no accepted mint left the post-mint BCR below θ_S.

Main findings: the aggregate PoR rule accepted every subscription, including
all 343 in the encumbered case where eligible backing was below 101% on every
day; RWA-PoB rejected all of them. Under v1 accounting, the same encumbered
run would have authorised 43 mints (USD 9.60 million) while true BCR was below
the threshold. In the baseline, all 16 rejections were liquidity-driven: they
fell on days when unpaid redemptions exceeded attested liquid assets. Settlement
delay changed how long claims stayed open (days with pending claims: 285 at
T+1, 545 at T+3) but not mint decisions, because the binding constraint was
attested liquidity. Daily snapshots produced more liquidity rejections than
weekly ones because the portfolio is rebalanced into 26-week bills at every
snapshot, leaving less idle cash.

**USDY published mix.** Two runs use the composition Ondo publishes for USDY
(ondo.finance/usdy, 29 Oct 2026: 86.12% U.S. Treasuries, 13.86% tokenized
iShares 0-1 Year Treasury Bond ETF, <0.01% deposits and cash, portfolio WAM
177.18 days): no cash target, a 1-364-day bill ladder priced from the 4- to
52-week curve, and a 14% ETF sleeve (accrues at the 4-week rate, haircut for
146-day duration, liquid because it settles T+1, sold first for
redemptions). Compared with the baseline, liquidity rejections fell from 16 to
8, queued redemptions from 7 to 3, days with RLC < 100% from 58 to 20, and the
longest-open claim from 37 to 11 days; the minimum BCR fell from 102.44% to
101.92% because haircuts grow with maturity. With 4% encumbrance every
subscription was rejected and v1 accounting would have authorised 42 unsafe
mints (USD 23.60 million).

**Gas** (`data/results/real-replay-gas.csv`, baseline means; every interval
uses a freshly deployed controller, so storage writes are cold):
`submitSnapshot` 350,191; `authorizeMintWithReceipt` 115,973;
`requestRedemption` 121,752; `confirmSettlement` 104,022.

### Controlled scenarios (retained, two decimals)

`data/results/scenario-results.csv`: valid BCR 114.12% / RLC 200.00%;
encumbered BCR 96.34% (PoR accepts, RWA-PoB rejects); liquidity stress RLC
40.00% (queued). `data/results/gas-results.csv`: submitSnapshot 370,625 /
203,288 / 206,076 vs aggregate PoR 94,701 / 37,801 / 37,801.
`data/results/atomic-gas-summary.csv`: atomic issuance 137,061 vs 86,660 +
70,834 = 157,494 for advisory authorisation plus an independent mint (20,433
less, 12.97%).

### Tests

46 tests: 7 controller unit tests, 21 atomic integration and adversarial
tests, 1 seeded state-machine test (128 transitions), 2 scenario and gas
tests, 1 real-data replay (smoke run in CI), and 14 v2 regression tests. All
pass.

### Data provenance note

The Treasury CSVs in `data/raw/treasury/` were retrieved from the Treasury's
daily bill-rates CSV endpoint through a fetching tool, not a direct `curl`,
because the build environment blocked home.treasury.gov. Every row passes the
Treasury's own discount-to-coupon-equivalent identity (4,864 checks, 0
mismatches), which would expose transcription or column errors, but this
does not prove the files are identical to the official download. Before
publication, run `npm run fetch:treasury -- --compare` on a machine with
direct access; it must report 0 differing cells.

### Reproduce

```bash
npm ci
npm run build
npm run validate:treasury
npm test                  # 46 tests, replay as a 70-day smoke run
npm run experiment        # scenario-results.csv, gas-results.csv
npm run experiment:atomic-gas
npm run experiment:real   # full 1,043-day replay, 11 configurations
```

## [1.0.0] - 2026 - Submitted version

Prototype as submitted: five-role full-snapshot signatures, BCR/RLC policy
controller, atomic ERC-20 integration, aggregate PoR baseline, three
deterministic synthetic scenarios (seed 42) calibrated to the latest USDY
observation, 31 tests.
