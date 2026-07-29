# RWA-PoB USDY-calibrated research prototype

This repository implements a research prototype of the RWA-PoB policy layer.
It is not an audit of USDY and is not production-ready financial software.

## What the prototype contributes

- EIP-712 signatures from five required institutional roles
- a canonical reserve snapshot with epoch, expiry, policy hash, and Merkle root
- replay, freshness, signer-role, and liability-continuity checks
- Backing Coverage Ratio (BCR) and Redemption Liquidity Coverage (RLC)
- mint authorization and redemption queue decisions
- pending-redemption accounting until settlement
- an aggregate PoR baseline for comparison
- deterministic synthetic reserve data and CSV experiment outputs

## Prerequisites

- Node.js 22.13 or later
- npm
- Visual Studio Code

## Install

```powershell
npm install
npm run build
```

## Generate synthetic reserve data

```powershell
npm run generate:data
```

## Run the tests

```powershell
npm test
```

## Generate paper-ready raw results

```powershell
npm run experiment
```

The generated CSV files are written to `data/results/`.

## Important interpretation

The aggregate PoR baseline uses gross reserve value. RWA-PoB instead uses
eligible reserves after the synthetic legal, encumbrance, settlement, and
haircut rules. This is the central experimental distinction.

## License

MIT. See `LICENSE`.
