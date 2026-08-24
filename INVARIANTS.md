# Phase E: RWA-PoB Issuance and Redemption Invariants

## The big why

Example-based tests prove that selected scenarios work. Invariants express what
must remain true after every permitted sequence of issuance, redemption, and
settlement operations.

The Phase E state-machine test uses deterministic seed `42` and performs 128
mixed transitions. After every transition, it compares on-chain state with an
independent in-test accounting model.

This is model-based property testing. It provides broader evidence than a small
set of examples, but it is not exhaustive fuzzing or formal verification.

## State notation

| Symbol | Meaning |
|---|---|
| `S` | ERC-20 total supply |
| `T` | Current controller token liabilities |
| `P` | Current pending-redemption liabilities |
| `O` | Other liabilities from the signed snapshot |
| `Q` | Current liquid assets |
| `T0` | Token liabilities in the initial snapshot |
| `Q0` | Liquid assets in the initial snapshot |
| `M` | Cumulative successful mint value after the snapshot |
| `X` | Cumulative confirmed settlements after the snapshot |

The experiment starts with legacy token liabilities `T0` but zero supply in the
new example token. Therefore, it tests a constant legacy-liability offset rather
than incorrectly asserting `S == T`:

```text
T - S = T0
```

A production migration must import legacy supply atomically or otherwise prove
the correspondence between legacy supply and `T0`.

## Executable invariants

### I1. Model supply equality

```text
on-chain totalSupply = modeled minted supply - modeled burned supply
```

### I2. Holder balance equality

Because the state-machine experiment uses one holder and performs no transfers:

```text
holder balance = totalSupply
```

### I3. Supply-liability synchronization

Every mint increases `S` and `T` equally. Every redemption request decreases
them equally:

```text
T - S = T0
```

### I4. Liability composition

```text
total economic obligations = T + P + O
```

### I5. Obligation conservation

Minting creates an obligation, redemption requests only reclassify it, and
confirmed settlement removes it:

```text
current total obligations = initial obligations + M - X
```

### I6. Redemption-record reconciliation

The aggregate pending value must equal the sum of every unpaid redemption
record:

```text
P = sum(requestedValue - settledValue) over open redemptions
```

### I7. Settlement/liquidity equality

```text
Q0 - Q = X
```

Every confirmed payment consumes the same amount of tracked liquid assets.

### I8. Rejected mint atomicity

When `canMint(amount)` is false, attempted token issuance must revert and leave
both supply and token liabilities unchanged.

### I9. Redemption atomicity

A successful redemption changes supply and token liabilities by `-r`, pending
liabilities by `+r`, and total obligations by zero. A rejected controller
sub-call restores the preceding burn.

### I10. Settlement bounds

Settlement must be positive and cannot exceed either the individual redemption
remainder or current liquid assets. Closed redemptions cannot settle again.

## State-machine actions

For each of 128 steps, the seeded generator selects one action:

1. usually propose a mint between $1 and $3 million, with a 20% branch that
   proposes up to $80 million to exercise policy rejection;
2. redeem up to $2 million, capped by holder balance; or
3. settle up to $1 million against a randomly selected open redemption, capped
   by its remainder and available liquid assets.

If a proposed mint fails the current BCR/RLC policy, the test expects a revert
and verifies zero model change. All invariants are checked after every accepted
or rejected action.

## Additional deterministic adversarial cases

Phase E adds explicit tests for:

- redemption accounting attempted by an unregistered contract;
- policy replacement invalidating an otherwise fresh snapshot;
- settlement exceeding available liquid assets;
- zero-value settlement; and
- settlement against an unknown redemption ID.

These supplement the Phase D stale, revoked, BCR, RLC, fake-mint-adapter,
unauthorized issuer, zero issuance, excessive settlement, duplicate settlement,
and rollback tests.

## Reproduction

```powershell
npx.cmd hardhat test test/InvariantStateMachine.ts
npx.cmd hardhat test test/AtomicControllerToken.ts
npx.cmd tsc --noEmit
npm.cmd test
```

Record the seed, transition count, compiler settings, dependency versions, and
Git commit with the result. Increasing the transition count or adding multiple
seeds is recommended for later evaluation, but each reported configuration
must remain reproducible.

## Evidence boundary

Verification after Phase E:

```text
Atomic integration/adversarial tests  21 passed
Seeded invariant state machine         1 passed (128 transitions, seed 42)
Full project suite                    30 passed
TypeScript static checking            passed
```

Passing the invariant suite supports this scoped statement:

> Across the reported deterministic examples and seeded transition sequence,
> the implemented contracts preserved the specified supply, liability,
> redemption, and liquidity accounting relationships.

It does not establish:

- truth of signed off-chain claims;
- security against malicious governance or signer collusion;
- correctness of bridges or wrapped representations;
- correctness under a changing NAV conversion;
- absence of every Solidity/EVM vulnerability; or
- a mathematical proof over every possible transition sequence.
