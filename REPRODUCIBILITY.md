# Reproducibility

## Environment

Record these commands in the paper's replication log:

```powershell
node --version
npm --version
npx hardhat --version
npm list --depth=0
```

## Reproduce all local outputs

```powershell
npm ci
npm run build
npm run generate:data
npm run validate:treasury
npm test
npm run experiment
npm run experiment:atomic-gas
npm run experiment:real
npm run coverage
```

If the Solidity compiler download is blocked, point Hardhat at a local solc:
`SOLC_PATH=$(pwd)/node_modules/solc/soljson.js npm test` (after
`npm install --no-save solc@0.8.28`).

## Determinism

- Synthetic reserve seed: `42`
- Synthetic position count: `100`
- Solidity compiler and npm package versions are pinned by `package-lock.json`
- Commit `package-lock.json` after the first successful `npm install`
- Tag the exact paper version, for example `v0.1.0-sdlt2026`

## Real data

- USDY liabilities: `data/input/usdy-observed-liabilities.csv` (RWA.xyz,
  1,043 daily observations).
- Reserve prices: `data/raw/treasury/` (U.S. Treasury Daily Treasury Bill
  Rates, 750 business days). Validate with `npm run validate:treasury`; diff
  against a fresh official download with `npm run fetch:treasury -- --compare`.
- The replay is deterministic: it uses no random numbers, and the same inputs
  produce the same decisions. Gas means vary slightly between runs because
  signatures depend on block timestamps.

## Data interpretation

Public USDY-derived liability data and synthetic reserve/credential states must
be identified separately in every output. This repository does not claim to
reconstruct or audit USDY's actual reserve positions.
