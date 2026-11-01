# Phase F: Atomic Controller-Token Gas Evaluation

> Updated for v2.0.0 (role-scoped snapshot verification and settlement
> propagation add gas to the controller paths). See `CHANGELOG.md`.

## The big why

Atomic enforcement adds work to token issuance: the transaction evaluates the
RWA-PoB policy, updates liabilities, and mints ERC-20 supply. The relevant
research question is not simply whether this costs more than a controller-only
authorization. The controller-only operation does not mint a token.

Phase F therefore evaluates two comparisons:

1. atomic issuance versus advisory authorization alone; and
2. atomic issuance versus the sum of separate advisory authorization and
   independent ERC-20 mint transactions.

The second comparison is functionally closer because both alternatives perform
the policy-accounting update and token issuance.

## Environment and configuration

```text
Solidity compiler: 0.8.28
EVM target:        Cancun
Optimizer:         enabled, 200 runs
Hardhat:           3.11.1
Samples:           10 per operation
Mint amount:       $1,000,000 in 18-decimal prototype units
Issued balance:    $10,000,000 before redemption measurement
Redemption:        $4,000,000
Partial payment:   $1,500,000
Final payment:     $2,500,000
```

Measurements use local Hardhat transaction receipts. They are raw EVM gas
observations, not fiat deployment or transaction prices.

## Measurement design

Every repetition restores the same fresh fixture state before executing the
measured operation. This avoids mixing first-write and later-write storage
costs within one operation category.

The experiment measures:

| Operation | Measured behavior |
|---|---|
| `submitSnapshot` | Five-signature snapshot validation and initial storage |
| `aggregatePoRReport` | Baseline gross-reserve report update |
| `advisoryAuthorization` | Adapter calls controller; policy check and liability update only |
| `independentTokenMint` | Permissioned standalone ERC-20 mint only |
| `atomicIssue` | Token calls controller and mints in one transaction |
| `redemptionRequest` | Token burn plus pending-liability record creation |
| `partialSettlement` | Pending/liquid accounting update; redemption remains open |
| `finalSettlement` | Remaining accounting update and redemption closure |

The advisory measurement uses `ControllerBypassHarness` after explicitly
granting it `TOKEN_ROLE`. This models a separate advisory adapter transaction
under the hardened Phase D controller. The harness-call overhead is part of the
reported advisory architecture.

Failed transactions are not mixed into this successful-operation comparison.
Revert gas depends on where execution fails and how the transaction is
submitted. Phase D and E use failures as security evidence; a separate study
would be required for systematic denial-of-service cost analysis.

## Results

All ten repetitions within each controlled operation produced the same gas
value:

| Operation | Samples | Minimum | Median | Maximum |
|---|---:|---:|---:|---:|
| Snapshot submission | 10 | 370,517 | 370,517 | 370,517 |
| Aggregate PoR report | 10 | 94,653 | 94,653 | 94,653 |
| Advisory authorization | 10 | 86,660 | 86,660 | 86,660 |
| Independent token mint | 10 | 70,834 | 70,834 | 70,834 |
| Atomic issuance | 10 | 137,061 | 137,061 | 137,061 |
| Redemption request | 10 | 150,283 | 150,283 | 150,283 |
| Partial settlement | 10 | 104,229 | 104,229 | 104,229 |
| Final settlement | 10 | 73,047 | 73,047 | 73,047 |

### Atomic issuance versus advisory authorization only

```text
Atomic issuance                 137,061 gas
Advisory authorization           86,660 gas
Absolute difference              50,401 gas
Relative difference               58.16% higher
```

This does not mean atomic enforcement adds 58.16% overhead to equivalent
functionality. The advisory-only operation does not create ERC-20 supply.

### Atomic issuance versus two separate transactions

```text
Advisory authorization           86,660 gas
Independent token mint           70,834 gas
Separate-transaction total      157,494 gas
Atomic issuance                 137,061 gas
Absolute difference             -20,433 gas
Relative difference              12.97% lower
```

In this controlled local experiment, the atomic design both enforces
synchronization and uses less gas than performing authorization and minting as
two separate transactions. One reason is that the separate design pays
transaction and call overhead twice. This is an interpretation of the measured
result, not a universal claim for all token/controller implementations.

## Redemption interpretation

The redemption request is the most expensive lifecycle transaction after
snapshot submission because it combines:

- ERC-20 balance and total-supply reduction;
- creation of a new redemption record;
- token-to-pending liability reclassification; and
- event emission across the token and controller.

Final settlement is cheaper than partial settlement in this fixture. Final
settlement closes the record and clears pending values, which can change EVM
storage charging/refund behavior. The result should be interpreted for this
specific state transition and compiler configuration.

## Generated evidence

The experiment command is:

```powershell
npm.cmd run experiment:atomic-gas
```

It generates:

- `data/results/atomic-gas-raw.csv` — every repetition;
- `data/results/atomic-gas-summary.csv` — sample count and min/median/max; and
- `data/results/atomic-gas-comparison.csv` — the two issuance comparisons.

The generator is implemented in `test/AtomicGasResults.ts`. The independent
mint baseline is implemented in the test-only
`contracts/test/IndependentMintToken.sol`.

## Reproducibility qualification

The experiment restores an identical fixture for each repetition, so all ten
observations within a run are equal. The standalone Phase F command measured
362,145 gas for snapshot submission, while the final full-suite run measured
362,109. Earlier baseline work also observed 12-gas cross-run changes with
different timestamp-dependent EIP-712 signatures. Signature bytes can change
calldata zero/non-zero byte composition and therefore transaction gas.

For this reason, paper reporting should retain raw observations and environment
metadata and should not claim that gas is universally constant across dates,
signatures, networks, or clients.

## Limitations

- Results come from a local Hardhat EVM, not a public network.
- Gas is not converted to USD because gas price and native-token price vary.
- Ten identical restored fixtures measure controlled execution, not diverse
  portfolio sizes or signer sets.
- The prototype always requires five snapshot signatures.
- The advisory adapter and independent token are experimental comparison
  implementations; another design may have different costs.
- Storage state, calldata bytes, compiler versions, optimizer settings, EVM
  revisions, access lists, and contract upgrades can alter gas.
- Bridge, cross-chain, batch-mint, NAV conversion, permit, and compliance-token
  costs are outside scope.
- Security benefits cannot be reduced to gas savings; the primary contribution
  is removal of the split-transaction synchronization gap.

## Phase F conclusion

The measured evidence supports this scoped statement:

> Under the reported local Hardhat configuration, atomic issuance used 137,061
> gas. It cost 50,401 gas more than advisory authorization alone, but 20,433 gas
> less than the sum of separate advisory-authorization and independent-mint
> transactions, while ensuring that liability and supply changes occurred in
> one transaction.
