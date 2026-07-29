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
npm test
npm run experiment
npm run coverage
```

## Determinism

- Synthetic reserve seed: `42`
- Synthetic position count: `100`
- Solidity compiler and npm package versions are pinned by `package-lock.json`
- Commit `package-lock.json` after the first successful `npm install`
- Tag the exact paper version, for example `v0.1.0-sdlt2026`

## Data interpretation

Public USDY-derived liability data and synthetic reserve/credential states must
be identified separately in every output. This repository does not claim to
reconstruct or audit USDY's actual reserve positions.
