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
