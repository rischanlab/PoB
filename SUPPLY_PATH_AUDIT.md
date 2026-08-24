# Phase D Supply-Path and Bypass Audit

## Objective

Phase D asks whether token supply or its corresponding liability can increase
through a path that bypasses the RWA-PoB checks.

The scoped security property is:

```text
For the implemented non-upgradeable RWABackedToken:

successful increase in totalSupply
    => caller passed ISSUER_ROLE
    => authorized token called the controller
    => snapshot was fresh and not revoked
    => post-mint BCR met minimumBCR
    => current RLC met minimumRLC
    => controller token liabilities increased by the identical amount
```

This audit covers source-level paths in this repository. It is not a formal
proof, production audit, or claim about bridges and external wrapped tokens.

## Source inventory method

The supply-changing source was enumerated with:

```powershell
rg -n "_mint|mint\(|issue\(|_burn|burn\(|totalSupply" contracts test
```

OpenZeppelin's `ERC20._mint` and `ERC20._burn` are internal functions. The
derived token determines whether an external caller can reach them.

## Supply-increasing paths

| Path | Externally reachable? | Controller required? | Atomic? | Finding |
|---|---:|---:|---:|---|
| `RWABackedToken.issue` | Yes, `ISSUER_ROLE` only | Yes | Yes | Authorized issuance path |
| `RWABackedToken._mint` | No, internal | Called only after controller approval | Yes | One call site |
| ERC-20 transfer | Yes | No | N/A | Moves balance; does not change supply |
| Constructor mint | No | N/A | N/A | No constructor mint exists |
| Public/admin `mint` | No | N/A | N/A | No alternate mint function exists |
| Rebase | No | N/A | N/A | Not implemented |
| Bridge mint | No | N/A | N/A | Not implemented and out of scope |
| Proxy upgrade | No | N/A | N/A | Token is non-upgradeable |
| Aggregate PoR baseline | Separate research contract | No | No | Cannot mint `RWABackedToken` |

The only `_mint` call in the implemented token occurs immediately after:

```solidity
pobController.authorizeMint(amount);
_mint(recipient, amount);
```

Both statements execute in one transaction.

## Liability-changing authorization boundary

Phase D replaces the general `OPERATIONS_ROLE` boundary with:

```solidity
bytes32 public constant TOKEN_ROLE = keccak256("TOKEN_ROLE");
```

Both controller entry points that reclassify token-related liabilities require
this role:

```solidity
authorizeMint(...)      onlyRole(TOKEN_ROLE)
requestRedemption(...)  onlyRole(TOKEN_ROLE)
```

The constructor does not grant `TOKEN_ROLE` to the deployer. Deployment must
explicitly grant it to the backed-token contract.

This distinction matters because an issuer is allowed to request issuance but
must not be able to update controller accounting separately from actual token
supply.

## Tested bypass attempts

| ID | Attempt | Expected outcome | State after rejection |
|---|---|---|---|
| D01 | Issue without a snapshot | Revert | Supply and mint liabilities unchanged |
| D02 | Issue with stale snapshot | Revert | Supply and mint liabilities unchanged |
| D03 | Issue after snapshot revocation | Revert | Supply and mint liabilities unchanged |
| D04 | Issue amount breaches BCR | Revert | Supply and mint liabilities unchanged |
| D05 | Issue while RLC is below minimum | Revert | Supply and mint liabilities unchanged |
| D06 | Non-issuer calls `issue` | Revert | Supply and mint liabilities unchanged |
| D07 | Issuer calls controller directly | Revert | Supply and mint liabilities unchanged |
| D08 | Unregistered contract calls controller | Revert | Supply and mint liabilities unchanged |
| D09 | Issue zero amount | Revert | Supply and mint liabilities unchanged |
| D10 | Controller rejects after redemption burn | Revert all | Supply, balance, and liabilities restored |

`ControllerBypassHarness` is a test-only contract that attempts to call
`authorizeMint` as a contract address. Its call fails because it does not have
`TOKEN_ROLE`. This supplements the externally owned account bypass test.

## Before and after

### Before Phase D

```text
Deployer receives OPERATIONS_ROLE automatically
    |
    +-- can call authorizeMint directly
    +-- can call requestRedemption directly

Token integration fixture later revokes that role
```

Safety depended on deployment code correctly removing an authority the
deployer received by default.

### After Phase D

```text
Controller deployment
    |
    +-- deployer receives governance and settlement authority
    +-- no address receives TOKEN_ROLE automatically

Explicit integration
    |
    +-- governance grants TOKEN_ROLE to RWABackedToken
    +-- issuer receives ISSUER_ROLE on RWABackedToken
```

The issuer can initiate the atomic `issue` workflow but cannot call the
controller's liability-changing functions directly.

## Net security effect

| State transition | Before Phase D | After Phase D |
|---|---|---|
| Direct deployer mint authorization | Allowed by constructor role | Rejected unless governance separately grants `TOKEN_ROLE` |
| Token mint under stale evidence | Atomic token test existed only for absent snapshot | Explicitly tested and rejected |
| Token mint after revocation | Not integration-tested | Explicitly tested and rejected |
| Token mint below BCR | Controller unit-tested | End-to-end token path tested |
| Token mint below RLC | Not end-to-end tested | Explicitly tested and rejected |
| Fake contract authorization | Not tested | Explicitly tested and rejected |
| Zero issuance | Contract guard existed | Explicitly tested and rejected |

## Residual bypass and governance risks

Phase D eliminates the enumerated ordinary source-level bypasses, but the
following claims would be too broad:

> No one can ever authorize another mint path.

The controller administrator can still grant `TOKEN_ROLE` to another address.
A compromised or malicious administrator could authorize a second adapter that
records liabilities without controlling the intended token. This would not
silently increase `RWABackedToken.totalSupply`, because that token has no second
mint function, but it could corrupt controller accounting or support another
token representation.

Recommended governance hardening includes:

- one-time backed-token registration;
- a timelock for token replacement;
- multisignature governance;
- an event and delay for every liability-adapter change;
- a rule limiting the active adapter count;
- emergency revocation that cannot grant mint authority;
- monitoring of `RoleGranted` and `RoleRevoked`; and
- explicit treatment of bridge and cross-chain adapters.

Other residual limitations:

- institutional signers can collude on false reserve data;
- `policyHash` contents remain off-chain;
- the reserve root is authenticated but not interpreted on-chain;
- settlement-role calls attest payment but do not prove bank finality;
- a separately issued wrapped or bridged representation is outside this
  token's `totalSupply`; and
- tests are evidence for executed cases, not mathematical proof over every EVM
  execution.

## Verification result

After Phase D:

```text
Focused controller and integration tests  24 passed
Full project suite                         25 passed
TypeScript static checking                 passed
```

The final Phase D verification was performed with:

```powershell
npm.cmd run build
npx.cmd tsc --noEmit
npm.cmd test
```
