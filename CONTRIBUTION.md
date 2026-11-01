# Contribution: Atomic Token Supply and RWA-PoB Liability Enforcement

> Historical design note for v1.0.0. Numbers below are the submitted
> version's. Current results and the v2 changes are in `CHANGELOG.md`.

## The big why

The central purpose of RWA-PoB is not merely to report whether a token appears
backed. It is to prevent the issuer from creating new financial claims when the
evidence shows that backing or liquidity is insufficient.

Minting one token creates two things that must remain synchronized:

1. an on-chain token that an investor can hold or transfer; and
2. an economic liability that the backing entity is expected to redeem.

If the token contract can mint independently from the proof-of-backing
controller, the controller is advisory. It may correctly reject a proposed
mint, while another contract path still creates the tokens. The accounting
answer is correct, but it does not control the economic action.

The contribution therefore connects the token and controller atomically:

> Token supply cannot increase unless the RWA-PoB controller approves and
> records an exactly equal liability increase in the same transaction.

The same principle applies to redemption. Burning a token does not mean the
investor has been paid. The obligation must move from circulating-token
liability to pending-redemption liability and remain there until settlement is
confirmed.

This turns RWA-PoB from a separate policy calculation into an enforceable part
of the token lifecycle.

## Contribution summary

Phase B adds:

- `contracts/interfaces/IPoBPolicyController.sol`, a narrow interface between
  the token and policy controller;
- `contracts/RWABackedToken.sol`, a non-upgradeable ERC-20 with one
  supply-increasing entry point;
- atomic controller authorization and token issuance;
- atomic token burning and redemption-liability reclassification;
- role isolation so the token, rather than the issuer account, calls the
  controller's liability-changing operations; and
- adversarial tests for missing snapshots, direct controller bypass, and
  unauthorized issuance.

The initial prototype assumes one 18-decimal token unit creates one 18-decimal
USD liability unit. A product with a changing NAV will require a signed
conversion value and explicit rounding rules.

## Before: controller and token state can diverge

Before the integration, the controller contains:

```solidity
function authorizeMint(uint256 mintLiability)
    external
    onlyRole(TOKEN_ROLE)
{
    if (!canMint(mintLiability)) revert MintPolicyFailed();
    additionalMintLiabilities += mintLiability;
}
```

This function checks the policy and records a liability. It does not mint an
ERC-20 token.

An independent token could separately expose:

```solidity
function mint(address recipient, uint256 amount)
    external
    onlyRole(MINTER_ROLE)
{
    _mint(recipient, amount);
}
```

These are separate state transitions:

```text
Transaction A: controller authorization
    token supply                    no change
    controller token liabilities   +amount

Transaction B: independent mint
    token supply                    +amount
    controller token liabilities   no change
```

Either transaction can occur without the other. Four outcomes are possible:

| Controller records liability? | Token mints? | Result |
|---:|---:|---|
| No | No | No issuance |
| Yes | Yes | Intended result, but synchronization depends on the issuer |
| Yes | No | Liability recorded without issued tokens |
| No | Yes | Unrecorded and potentially unbacked token issuance |

The final row is the critical bypass. The controller can reject minting without
preventing the independent token contract from increasing supply.

## After: one atomic issuance transition

The new token exposes `issue()` as its only supply-increasing workflow:

```solidity
function issue(address recipient, uint256 amount)
    external
    onlyRole(ISSUER_ROLE)
{
    pobController.authorizeMint(amount);
    _mint(recipient, amount);
}
```

The call sequence is:

```text
Authorized issuer calls token.issue(recipient, amount)
                         |
                         v
Token calls controller.authorizeMint(amount)
                         |
                         v
Controller verifies snapshot freshness, BCR, and RLC
                         |
                  +------+------+
                  |             |
                reject        approve
                  |             |
             revert all    record liability
                                |
                                v
                         token mints amount
```

Both contracts execute in one EVM transaction. If the controller rejects the
request, `_mint` is never reached. If `_mint` unexpectedly reverts, the earlier
controller liability update is also rolled back.

### Atomic mint state change

Let:

- `S` be ERC-20 total supply;
- `T` be token liabilities recorded by the controller;
- `P` be pending-redemption liabilities;
- `O` be other liabilities; and
- `m` be the approved mint amount.

For a successful mint:

| State | Before | After | Net effect |
|---|---:|---:|---:|
| Token supply | `S` | `S + m` | `+m` |
| Recipient balance | `B` | `B + m` | `+m` |
| Token liabilities | `T` | `T + m` | `+m` |
| Pending redemptions | `P` | `P` | `0` |
| Other liabilities | `O` | `O` | `0` |
| Total economic obligations | `T + P + O` | `T + P + O + m` | `+m` |

The key invariant is:

```text
change in token supply = change in token liabilities = m
```

For a rejected mint:

| State | Net effect |
|---|---:|
| Token supply | `0` |
| Recipient balance | `0` |
| Token liabilities | `0` |
| Total economic obligations | `0` |

This is the atomicity guarantee: there is no partial outcome.

## Mint example: before and after

Assume:

```text
Eligible reserves                 $105 million
Token liabilities                  $90 million
Pending redemptions                 $5 million
Other liabilities                   $2 million
Current total obligations          $97 million
Proposed mint                        $3 million
Required BCR                              105%
```

Before minting:

```text
BCR = 105 / 97 = 108.25%
```

After the proposed mint:

```text
Post-mint obligations = 97 + 3 = $100 million
Post-mint BCR         = 105 / 100 = 105%
```

The mint passes exactly at the threshold.

Atomic state transition:

```text
Token supply                     +$3 million equivalent
Token liabilities                +$3 million
Pending redemptions               no change
Total economic obligations       +$3 million
Eligible reserves                 no change
```

Now consider a proposed mint of $4 million:

```text
Post-mint obligations = 97 + 4 = $101 million
Post-mint BCR         = 105 / 101 = 103.96%
```

The controller rejects it. Because issuance is atomic, both token supply and
controller liabilities remain unchanged.

## Redemption: burning is reclassification, not payment

The new token begins redemption with:

```solidity
function requestRedemption(uint256 amount)
    external
    returns (uint256 redemptionId, uint8 disposition)
{
    _burn(msg.sender, amount);
    (redemptionId, disposition) =
        pobController.requestRedemption(msg.sender, amount);
}
```

Although `_burn` appears first, the burn and controller call are part of the
same transaction. If the controller rejects the request, the burn rolls back.

Let `r` be the redemption amount.

### Redemption-request state change

| State | Before | After | Net effect |
|---|---:|---:|---:|
| Token supply | `S` | `S - r` | `-r` |
| Holder balance | `B` | `B - r` | `-r` |
| Token liabilities | `T` | `T - r` | `-r` |
| Pending redemptions | `P` | `P + r` | `+r` |
| Other liabilities | `O` | `O` | `0` |
| Total economic obligations | `T + P + O` | `T + P + O` | `0` |
| Liquid assets | `Q` | `Q` | `0` |

The essential invariant is:

```text
burned token liability does not disappear;
it moves to pending-redemption liability.
```

This prevents the issuer from appearing healthier merely because the investor
has surrendered or burned tokens.

## Settlement: only payment removes the obligation

Settlement occurs later because off-chain bank payment is asynchronous. Let
`p` be the confirmed payment amount.

### Settlement state change

| State | Before | After | Net effect |
|---|---:|---:|---:|
| Token supply | `S` | `S` | `0` |
| Token liabilities | `T` | `T` | `0` |
| Pending redemptions | `P` | `P - p` | `-p` |
| Liquid assets | `Q` | `Q - p` | `-p` |
| Total economic obligations | `T + P + O` | `T + P + O - p` | `-p` |

Only at this stage does the economic obligation decrease. Partial payments
remove only the paid portion. The remaining unpaid amount stays pending.

## Complete lifecycle example

Assume the starting state is:

```text
Token supply                         $90 million equivalent
Token liabilities                    $90 million
Pending redemptions                   $0
Other liabilities                     $2 million
Liquid assets                        $20 million
Total economic obligations           $92 million
```

### 1. Issue $5 million

```text
Token supply                         $95 million   (+5)
Token liabilities                    $95 million   (+5)
Pending redemptions                   $0           (no change)
Total economic obligations           $97 million   (+5)
```

### 2. Holder requests a $3 million redemption

```text
Token supply                         $92 million   (-3)
Token liabilities                    $92 million   (-3)
Pending redemptions                   $3 million   (+3)
Total economic obligations           $97 million   (no change)
Liquid assets                        $20 million   (no change)
```

The holder no longer owns the tokens, but the issuer still owes $3 million.

### 3. Settlement agent confirms a $1 million partial payment

```text
Token supply                         $92 million   (no change)
Token liabilities                    $92 million   (no change)
Pending redemptions                   $2 million   (-1)
Total economic obligations           $96 million   (-1)
Liquid assets                        $19 million   (-1)
```

The unpaid $2 million remains an obligation.

### 4. Settlement agent confirms the remaining $2 million

```text
Token supply                         $92 million   (no change)
Token liabilities                    $92 million   (no change)
Pending redemptions                   $0           (-2)
Total economic obligations           $94 million   (-2)
Liquid assets                        $17 million   (-2)
```

The redemption closes only after its full value has been confirmed as paid.

## Permission change: before and after

Before Phase D, the original controller constructor granted `OPERATIONS_ROLE`
to its deployer. That account could call `authorizeMint` and
`requestRedemption` directly.

The Phase B fixture changes the authority graph:

### Before

```text
Issuer/deployer
    |
    +---- controller.authorizeMint()

Independent token
    |
    +---- mint()
```

### After

```text
Issuer account --ISSUER_ROLE--> RWABackedToken.issue()
                                      |
                                      | TOKEN_ROLE
                                      v
                              PoBPolicyController
```

The Phase D controller grants neither issuer nor deployer automatic token
authority. The fixture grants `TOKEN_ROLE` only to `RWABackedToken`. Therefore:

- the issuer can initiate issuance through the token;
- the issuer cannot call controller authorization directly;
- the token cannot mint until controller authorization succeeds; and
- an unregistered fake token cannot update controller liabilities.

This role arrangement is currently performed during deployment. A later
hardening phase should add one-time or timelocked token registration directly
to the controller so governance cannot silently authorize an additional
liability adapter.

## Evidence added in Phase B

`test/AtomicControllerToken.ts` currently demonstrates:

| Test | Security meaning |
|---|---|
| Controller operations assigned exclusively to token | Issuer cannot use the old direct path |
| Atomic supply and liability increase | Successful issuance changes both states equally |
| Issuance without a valid snapshot reverts | Failed policy check leaves no token or liability change |
| Direct controller call by issuer reverts | First bypass path is blocked |
| Issuance by non-issuer reverts | Token entry point is permissioned |

Current verification state:

```text
Solidity compilation             passed
Phase B integration tests        5 passed
Full project tests              13 passed
TypeScript static checking       passed
Existing experiment regression  passed
```

## Net contribution

Before this contribution, RWA-PoB could calculate and record whether a mint was
acceptable, but it did not control an actual token's supply.

After this contribution:

```text
successful mint
    => fresh policy approval
    => acceptable post-mint BCR and RLC
    => equal liability increase
    => equal token-supply increase

failed policy check
    => no liability increase
    => no token-supply increase

redemption burn
    => token-liability decrease
    => equal pending-liability increase
    => no premature decrease in total obligations

confirmed payment
    => pending-liability decrease
    => equal liquid-asset decrease
```

The contribution does not prove that off-chain statements are true. It makes
the implemented token's on-chain issuance and redemption transitions obey the
controller's authenticated policy state. That is the precise boundary of the
claim supported by the current code and tests.

## Phase C: atomic redemption and settlement integration

### The big why

Redemption has two different events that may occur at different times:

1. the investor gives up or locks the token; and
2. the investor receives the corresponding off-chain payment.

These events must not be treated as the same financial event.

If the system removes the obligation when tokens are burned, an issuer can
appear better capitalized before investors have actually been paid. For
example, burning $10 million of tokens could make reported liabilities fall by
$10 million even though $10 million remains payable through the banking system.

The Phase C contribution enforces a more accurate rule:

> Burning tokens changes the classification of the obligation. Only confirmed
> payment removes the obligation.

This distinction is essential to the paper because a proof-of-backing system
must cover investors who are waiting for payment, not only investors whose
tokens remain in circulation.

### Before: a burn can be mistaken for discharged debt

A weak token-only redemption flow might be:

```solidity
function redeem(uint256 amount) external {
    _burn(msg.sender, amount);
    emit RedemptionRequested(msg.sender, amount);
}
```

The token supply decreases, but the contract does not record that payment is
still owed:

```text
Token supply                  -amount
Reported token liabilities    -amount
Pending liabilities            no record
Investor payment               not yet made
```

Its reported total obligations fall too early. The on-chain state says the
claim disappeared, while the off-chain financial obligation still exists.

Another weak design records a pending redemption in a separate transaction:

```text
Transaction A: burn token
Transaction B: create pending liability
```

If Transaction B fails or is omitted, supply decreases without the matching
pending obligation. The two systems become inconsistent.

### After: burn and liability reclassification are atomic

The integrated token performs both transitions in one transaction:

```solidity
function requestRedemption(uint256 amount)
    external
    returns (uint256 redemptionId, uint8 disposition)
{
    _burn(msg.sender, amount);
    (redemptionId, disposition) =
        pobController.requestRedemption(msg.sender, amount);
}
```

The execution flow is:

```text
Holder calls requestRedemption(amount)
                    |
                    v
Token burns holder's tokens
                    |
                    v
Controller validates and records redemption
                    |
             +------+------+
             |             |
           reject        accept
             |             |
        restore burn   token liability -amount
        revert all     pending liability +amount
```

Although `_burn` is executed before the controller call, the EVM treats the
cross-contract execution as one transaction. A later controller revert undoes
the earlier burn.

### Redemption request: state change and net effect

Let:

- `S` be total token supply;
- `B` be the redeeming holder's token balance;
- `T` be controller token liabilities;
- `P` be pending-redemption liabilities;
- `O` be other liabilities;
- `Q` be available liquid assets; and
- `r` be the requested redemption value.

For a successful redemption request:

| State | Before | After | Net effect |
|---|---:|---:|---:|
| Token supply | `S` | `S - r` | `-r` |
| Holder balance | `B` | `B - r` | `-r` |
| Token liabilities | `T` | `T - r` | `-r` |
| Pending liabilities | `P` | `P + r` | `+r` |
| Other liabilities | `O` | `O` | `0` |
| Total obligations | `T + P + O` | `T + P + O` | `0` |
| Liquid assets | `Q` | `Q` | `0` |

The net economic effect is:

```text
Circulating token claim       decreases by r
Pending payment claim         increases by r
Total amount owed             does not change
Cash or liquid assets         do not change
```

This is a reclassification, not settlement.

### Why liquid assets do not decrease at redemption request

A redemption request is not evidence that money left the custody or payment
account. Reducing liquid assets immediately would mix an investor instruction
with a completed bank transfer.

Therefore, Phase C keeps `Q` unchanged until `confirmSettlement` is executed by
the settlement authority. This makes the state transitions correspond to two
different observable events:

```text
Request evidence     -> liability reclassification
Payment evidence     -> liability and liquid-asset reduction
```

### Partial settlement: state change and net effect

Suppose the requested redemption is `r`, and the settlement agent confirms a
partial payment `p`, where `0 < p < r`.

| State | Before payment | After payment | Net effect |
|---|---:|---:|---:|
| Token supply | `S` | `S` | `0` |
| Token liabilities | `T` | `T` | `0` |
| Pending liabilities | `P` | `P - p` | `-p` |
| Liquid assets | `Q` | `Q - p` | `-p` |
| Total obligations | `T + P + O` | `T + P + O - p` | `-p` |
| Redemption closed? | No | No | No change |

Only the amount actually confirmed as paid disappears. The unpaid remainder is:

```text
remaining redemption = requested value - total settled value
```

### Final settlement: state change and net effect

When the final remaining amount is confirmed:

| State | Before final payment | After final payment | Net effect |
|---|---:|---:|---:|
| Pending liabilities | Remaining amount | `0` | `-remaining` |
| Liquid assets | `Q` | `Q - remaining` | `-remaining` |
| Total obligations | `L` | `L - remaining` | `-remaining` |
| Settled value | Less than requested | Equal to requested | `+remaining` |
| Redemption closed? | No | Yes | Closed |

After closure, another settlement attempt for the same redemption is rejected.
This prevents the system from removing the same obligation twice.

### Complete Phase C numerical example

Assume that after issuance the system has:

```text
Token supply                         $10 million
Controller token liabilities        $910 million
Pending-redemption liabilities        $0
Other liabilities                    $10 million
Liquid assets                       $120 million
Total economic obligations          $920 million
```

The difference between token supply and controller token liabilities exists
because the signed baseline snapshot already reports $900 million of
pre-existing liabilities. The Phase B and C tests verify equal changes rather
than claiming that this newly deployed example token represents all legacy
supply.

#### Step 1: request a $4 million redemption

```text
Token supply                          $6 million   (-4)
Holder balance                        $6 million   (-4)
Controller token liabilities        $906 million   (-4)
Pending-redemption liabilities        $4 million   (+4)
Liquid assets                       $120 million    (0)
Total economic obligations          $920 million    (0)
```

The investor has surrendered $4 million of tokens, but the backing entity still
owes the same total amount.

#### Step 2: confirm a $1.5 million partial payment

```text
Token supply                          $6 million    (0)
Controller token liabilities        $906 million    (0)
Pending-redemption liabilities      $2.5 million   (-1.5)
Liquid assets                     $118.5 million   (-1.5)
Total economic obligations        $918.5 million   (-1.5)
Redemption status                    open
```

The remaining $2.5 million is still visible as an unpaid obligation.

#### Step 3: confirm the remaining $2.5 million

```text
Token supply                          $6 million    (0)
Controller token liabilities        $906 million    (0)
Pending-redemption liabilities        $0          (-2.5)
Liquid assets                       $116 million   (-2.5)
Total economic obligations          $916 million   (-2.5)
Redemption status                    closed
```

The full $4 million obligation disappears only after confirmed payments total
$4 million.

### Failed redemption: rollback and net effect

Phase C deliberately removes the token's controller permission after issuing
tokens. The holder then calls `requestRedemption`.

Execution reaches `_burn`, but the controller rejects the following call
because the token no longer has `TOKEN_ROLE`. The complete transaction
reverts.

| State | Before failed request | After failed request | Net effect |
|---|---:|---:|---:|
| Token supply | `S` | `S` | `0` |
| Holder balance | `B` | `B` | `0` |
| Token liabilities | `T` | `T` | `0` |
| Pending liabilities | `P` | `P` | `0` |

This test demonstrates atomic rollback across two contracts rather than merely
assuming it from the Solidity source.

### Settlement authority: before and after

The controller constructor originally grants `SETTLEMENT_ROLE` to the deployer,
who is also governance and the initial operations authority. Leaving this
configuration in the integration fixture would allow one account to initiate
issuance, administer roles, and report investor payment.

Phase C changes the test authority graph:

```text
Governance account
    -> administers roles
    -> does not confirm settlement

Issuer account
    -> initiates token issuance
    -> does not call controller operations directly

RWABackedToken
    -> records mint and redemption liability transitions

Settlement account
    -> confirms partial or final payment
    -> cannot issue tokens
```

The fixture grants `SETTLEMENT_ROLE` to a separate settlement account and
revokes it from governance. An attempted settlement from governance is tested
and rejected.

This separation does not prove that a bank payment occurred. It proves which
authorized on-chain identity asserted settlement. Binding that assertion to a
bank transaction reference or payment credential remains future work.

### Adversarial protections demonstrated in Phase C

| Attempt | Expected behavior | Net state effect |
|---|---|---:|
| Holder redeems valid owned balance | Burn and reclassify | `S -r`, `T -r`, `P +r` |
| Controller rejects after burn is reached | Revert entire transaction | `0` |
| Governance confirms payment without settlement role | Revert | `0` |
| Settlement exceeds redemption remainder | Revert | `0` |
| Settlement repeats after closure | Revert | `0` |
| Settlement is partial | Preserve unpaid remainder | `P -p`, `Q -p` |
| Settlement completes requested value | Close redemption | Remaining `P` removed |

### Evidence implemented in tests

The Phase C tests in `test/AtomicControllerToken.ts` establish:

1. a successful request decreases supply and token liabilities equally;
2. the same request increases pending liabilities equally;
3. total obligations do not change when redemption is requested;
4. liquid assets do not change before settlement;
5. partial payment changes pending liabilities and liquid assets by only the
   paid amount;
6. token supply and token liabilities do not change again during settlement;
7. final payment closes the redemption;
8. unauthorized settlement cannot change state;
9. excessive and duplicate settlement cannot change state; and
10. a controller rejection restores an already-executed burn.

Current verification state after Phase C:

```text
Atomic controller-token tests    11 passed
Full project tests               19 passed
TypeScript static checking       passed
```

### Net Phase C contribution

Before Phase C, the architecture contained the redemption functions, but the
integrated lifecycle and its failure cases were not demonstrated end to end.

After Phase C, the executable evidence supports the following claim:

```text
successful redemption request
    => holder token balance decreases
    => total token supply decreases
    => token liability decreases equally
    => pending liability increases equally
    => total obligations remain unchanged
    => liquid assets remain unchanged

successful partial settlement
    => pending liability decreases only by confirmed payment
    => liquid assets decrease by the same amount
    => unpaid remainder stays open

successful final settlement
    => remaining pending liability is removed
    => redemption is closed

failed redemption or settlement transition
    => all state changes in that transaction are rolled back
```

The next implementation phase is adversarial and property evaluation across
larger state-transition sequences, followed by reproducible gas measurement.

## Phase D: eliminating enumerated bypass paths

### The big why

Atomic code is effective only if every supply-increasing path is forced through
it. A second mint function, a direct controller permission, or an unregistered
adapter could make the correct BCR/RLC logic irrelevant.

Phase D therefore moves from testing the intended path to testing the edges:

> Which callers, contracts, evidence states, or functions could increase token
> supply or controller liabilities without completing the intended atomic
> workflow?

### Authorization before and after

Before Phase D, the controller used a general `OPERATIONS_ROLE` and granted it
to the deployer in its constructor. The integration fixture revoked that role,
but safety depended on deployment configuration removing a default authority.

After Phase D, mint authorization and redemption reclassification require a
dedicated role:

```solidity
bytes32 public constant TOKEN_ROLE = keccak256("TOKEN_ROLE");
```

```text
authorizeMint(...)      -> TOKEN_ROLE required
requestRedemption(...)  -> TOKEN_ROLE required
controller constructor  -> TOKEN_ROLE granted to nobody
deployment integration  -> TOKEN_ROLE granted explicitly to RWABackedToken
```

The issuer holds `ISSUER_ROLE` on the token and can request issuance. It does
not hold `TOKEN_ROLE` on the controller and cannot separate liability changes
from token changes.

### Supply-path inventory

Source inspection finds one `_mint` call in `RWABackedToken`, immediately after
controller authorization. The token has:

- no public or administrative second mint function;
- no constructor mint;
- no rebase mechanism;
- no bridge-mint function; and
- no proxy-upgrade mechanism.

ERC-20 transfers change account balances but do not change total supply. The
aggregate PoR baseline is a separate comparison contract and cannot mint
`RWABackedToken`.

The detailed inventory and residual-risk analysis are recorded in
`SUPPLY_PATH_AUDIT.md`.

### Bypass attempts and net effect

| Attempt | Result | Token supply effect | Liability effect |
|---|---|---:|---:|
| No snapshot | Revert | `0` | `0` |
| Stale snapshot | Revert | `0` | `0` |
| Revoked snapshot | Revert | `0` | `0` |
| Post-mint BCR below minimum | Revert | `0` | `0` |
| Current RLC below minimum | Revert | `0` | `0` |
| Caller lacks issuer role | Revert | `0` | `0` |
| Issuer calls controller directly | Revert | `0` | `0` |
| Unregistered contract calls controller | Revert | `0` | `0` |
| Zero-value issue | Revert | `0` | `0` |

The fake-contract case uses `ControllerBypassHarness`, which calls the real
controller from a contract address without `TOKEN_ROLE`. The controller rejects
the attempt and leaves accounting unchanged.

### Net Phase D contribution

```text
Before:
    safe issuance depended on using the intended token path
    and correctly revoking a deployer permission

After:
    the controller grants no default token authority
    the backed token is explicitly registered through TOKEN_ROLE
    every enumerated ordinary mint bypass is rejected in tests
    rejected attempts leave both supply and liabilities unchanged
```

This is deliberately a scoped conclusion. The controller administrator can
still grant `TOKEN_ROLE` to another address. Preventing malicious governance
requires one-time or timelocked token registration, multisignature control, and
role-change monitoring. Bridges and wrapped representations also require a
global supply design rather than assuming one chain's `totalSupply` is the
complete liability.

Phase D verification:

```text
Focused controller/integration tests  24 passed
Full project tests                    25 passed
TypeScript static checking            passed
```

## Phase E: executable invariants and adversarial sequences

### The big why

Individual examples can show that one mint or one redemption behaves correctly.
They do not show whether accounting remains consistent after a long sequence
such as:

```text
mint -> mint -> redeem -> partial settlement -> rejected mint
     -> redeem -> mint -> final settlement -> rejected settlement
```

Phase E converts the intended financial relationships into executable
invariants and checks them after every state transition against an independent
accounting model.

### Before and after

Before Phase E, the suite contained strong deterministic examples and bypass
tests. Each test focused on one scenario and selected before/after assertions.

After Phase E, a seeded state machine executes 128 mixed operations. Seed `42`
selects accepted and rejected mints, redemptions, partial settlements, and final
settlements. After every operation, the test reads the contracts and compares
them with its own model.

### Invariants checked after every transition

Let `S` be token supply, `T` token liabilities, `P` pending liabilities, `O`
other liabilities, `Q` liquid assets, `M` cumulative mint value, `X` cumulative
settlement, and `T0` the legacy token liability in the initial snapshot.

```text
1. on-chain supply = modeled supply
2. holder balance = supply in the one-holder experiment
3. T - S = T0
4. total obligations = T + P + O
5. total obligations = initial obligations + M - X
6. P = sum of unpaid amounts in redemption records
7. initial liquid assets - Q = X
8. rejected mint => zero supply and liability change
9. redemption request => supply -r, T -r, P +r, total change 0
10. settlement is positive and bounded by remainder and liquidity
```

The `T - S = T0` formulation is intentional. The signed baseline contains $900
million of legacy token liabilities, while the newly deployed research token
starts with zero supply. The experiment proves that all new changes remain
synchronized without falsely claiming that it migrated the legacy tokens.

### State-machine net effects

| Action | Supply | Token liability | Pending liability | Liquid assets | Total obligations |
|---|---:|---:|---:|---:|---:|
| Accepted mint `m` | `+m` | `+m` | `0` | `0` | `+m` |
| Rejected mint | `0` | `0` | `0` | `0` | `0` |
| Redemption request `r` | `-r` | `-r` | `+r` | `0` | `0` |
| Confirmed settlement `p` | `0` | `0` | `-p` | `-p` | `-p` |

### Additional adversarial cases

Phase E also adds direct tests that reject:

- redemption accounting requested by an unregistered contract;
- issuance after a policy update makes the snapshot incompatible;
- settlement greater than available liquid assets;
- zero-value settlement; and
- settlement against an unknown redemption ID.

Every rejected operation is followed by state assertions, so a passing revert
alone is not treated as sufficient evidence.

### Evidence boundary

The model-based test is reproducible property evidence, not exhaustive formal
verification. It executes one reported seed and 128 transitions. It does not
prove correctness for all possible EVM states, malicious governance, false
off-chain credentials, bridges, changing NAV, or unimplemented upgrade paths.

The complete definitions, model, reproduction commands, and limitations are in
`INVARIANTS.md`.

Phase E verification:

```text
Atomic integration/adversarial tests  21 passed
Seeded invariant state machine         1 passed (128 transitions, seed 42)
Full project tests                    30 passed
TypeScript static checking            passed
```

## Phase F: measuring enforcement cost

### The big why

The atomic design performs more work than an advisory controller call because
it also creates the token supply. A fair cost analysis must distinguish:

```text
advisory authorization only
    versus
atomic authorization + mint

and

separate authorization + separate mint
    versus
atomic authorization + mint
```

Comparing only the first pair exaggerates enforcement overhead because the
advisory transaction is functionally incomplete.

### Before and after cost model

```text
Before: split workflow
    transaction 1 -> controller authorization and liability update
    transaction 2 -> independent ERC-20 mint
    synchronization depends on completing both

After: atomic workflow
    one transaction -> controller authorization + liability update + mint
    all changes succeed or revert together
```

### Measured result

Ten restored-fixture observations were collected for each operation:

| Operation | Median gas |
|---|---:|
| Snapshot submission | 362,109 in the final full-suite run |
| Aggregate PoR report | 94,653 |
| Advisory authorization | 82,172 |
| Independent token mint | 70,834 |
| Atomic issuance | 132,573 |
| Redemption request | 148,122 |
| Partial settlement | 102,075 |
| Final settlement | 70,893 |

Net issuance comparison:

```text
Atomic versus advisory only:
    +50,401 gas / +61.34%
    but atomic also performs the missing token mint

Atomic versus separate authorization + mint:
    separate total = 153,006 gas
    atomic total   = 132,573 gas
    difference     = -20,433 gas / -13.35%
```

The primary benefit remains correctness rather than cost: supply and liability
cannot diverge between two transactions. In this controlled implementation,
atomic execution also costs less than the two-transaction functional
comparison.

Raw data, methodology, interpretations, reproduction commands, and limitations
are documented in `GAS_EVALUATION.md` and the generated
`data/results/atomic-gas-*.csv` files.
