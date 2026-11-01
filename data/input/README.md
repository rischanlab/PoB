# Input data

Run `npm run generate:data` to create deterministic synthetic reserve positions,
a standard OpenZeppelin Merkle tree, and an aggregate summary. The seed and all
generation rules are fixed in `scripts/generate-reserve-data.mjs`.

The synthetic fields are not claims about USDY's actual reserves.

## Real reserve positions: `franklin-fobxx/`

Built from the FOBXX Form N-MFP3 filing (see `data/raw/README.md`) by
`npm run prepare:franklin` and `npm run build:franklin`:

- `holdings.csv`: one row per security as filed, plus cash and other assets;
- `fund.json`: fund-level totals, liquid-asset figures and daily flows;
- `positions.csv`, `tree.json`, `snapshot.json`: `ReservePosition` leaves,
  the OpenZeppelin Merkle tree, and the snapshot aggregates.

Holdings, values, maturities and liquidity flags are real. The haircut
schedule is a policy assumption fixed in `scripts/build-franklin-snapshot.mjs`.

## Evidence types

| Type | Input |
|---|---|
| Observed | `usdy-observed-token-value.csv` (RWA.xyz Bridged Token Value = bridged supply x issuer NAV); Treasury bill rates; FOBXX positions, totals, daily flows and liquid assets |
| Observed, retrospective | Ondo's USDY composition of 29 Oct 2026, used only as a calibration for two sensitivity runs |
| Inferred | Daily USDY net flows (value change minus estimated accrual); FOBXX opening shares (month-end shares minus net flows) |
| Modelled | USDY reserve portfolio, buffer, top-ups, rebalancing, haircuts, liquidity horizon, settlement timing; FOBXX haircut schedule and intra-month eligible/gross ratios; unit redemption price |
| Synthetic | Encumbrance overlays, controlled scenarios (seed 42), tampered positions, reconciliation cases R1-R4, trust cases T1-T6, test signer keys |

`usdy-observed-token-value.csv` was named `usdy-observed-liabilities.csv`
before v2.2.0. The series is a market-data proxy, not an issuer record of
legal liabilities.
