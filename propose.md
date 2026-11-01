# Atomic Supply–Liability Enforcement for RWA Proof-of-Backing

> Historical design note for v1.0.0. Numbers below are the submitted
> version's. Current results and the v2 changes are in `CHANGELOG.md`.

## Methodology: atomic supply–liability enforcement

The original RWA-PoB controller could decide whether a proposed issuance was compatible with signed reserve evidence, the minimum Backing Coverage Ratio (BCR), and the minimum Redemption Liquidity Coverage ratio (RLC). It could also record the resulting liability. The controller was nevertheless separate from the token contract. Its decision was therefore advisory: an issuer could retain another route to mint tokens without using the controller.

This contribution connects both contracts in one transaction. `RWABackedToken` has one supply-increasing entry point. An account with `ISSUER_ROLE` calls `issue`, which passes the exact amount to `PoBPolicyController.authorizeMint`. The controller checks that the current snapshot exists, is fresh, has not been revoked, and matches the active policy. It calculates post-mint BCR and checks current RLC. If the request is acceptable, the controller records the liability and the token mints the same amount. A failure in either contract reverts the whole transaction.

The controller now reserves mint and redemption accounting for addresses with a dedicated `TOKEN_ROLE`. This role is not assigned by the constructor. In the evaluated configuration it is granted to `RWABackedToken`, while the issuer holds its permission on the token rather than on the controller. Settlement authority is assigned to a separate account. This arrangement prevents an ordinary issuer from recording liabilities independently of supply and prevents an unregistered contract from impersonating the backed token.

Redemption is modeled as two events. When a holder requests redemption of an amount (r), the token burns (r), token liabilities fall by (r), and pending-redemption liabilities rise by (r). Total obligations do not change because payment is still due. When the settlement account confirms payment (p), pending liabilities and liquid assets both fall by (p). Partial payment leaves the unpaid remainder open; final payment closes the redemption.

The prototype assumes one token unit corresponds to one US dollar of liability at 18-decimal precision. The initial signed snapshot reports USD 900 million of legacy token liabilities, whereas the experimental token begins with zero supply. The evaluation consequently verifies equal changes rather than absolute equality. The invariant is that current token liabilities minus experimental token supply remains equal to the initial legacy liability.

The evaluation used deterministic integration tests, adversarial calls, and a model-based state machine. With seed 42, the state machine executed 128 accepted and rejected mints, redemptions, and settlements. After every transition, an independent model was compared with on-chain supply, holder balance, token liabilities, pending liabilities, liquid assets, total obligations, and individual redemption records. The contracts were compiled with Solidity 0.8.28, the optimizer enabled for 200 runs, and the Cancun EVM target. The recorded environment used Hardhat 3.11.1, Node.js 24.18.0, OpenZeppelin Contracts 5.6.1, and Viem 2.55.10.

## Evaluating bypass resistance

The bypass review began with an inventory of every source-level supply change. `RWABackedToken` contains one `_mint` call, immediately after controller authorization. It has no constructor mint, administrator mint, rebase, bridge mint, or upgrade proxy. ERC-20 transfers move balances without changing total supply. The separate aggregate proof-of-reserves contract cannot mint `RWABackedToken`.

The tests attempted issuance without a snapshot, with a stale or revoked snapshot, after a policy change invalidated the snapshot, below the required BCR, and while RLC was below its threshold. They also tested zero issuance, a caller without `ISSUER_ROLE`, an issuer calling the controller directly, and an unregistered Solidity contract attempting to call the controller. Every attempt reverted, and subsequent assertions confirmed that supply and mint liabilities had not changed.

Redemption tests covered an unregistered contract attempting to create pending liabilities and a controller rejection after `_burn` had already been reached. In the latter case, removal of the token’s `TOKEN_ROLE` caused the controller call to fail. The EVM restored total supply, the holder balance, token liabilities, and pending liabilities, demonstrating cross-contract rollback rather than merely assuming it.

Settlement tests rejected an unauthorized caller, an unknown redemption identifier, a zero payment, payment above the redemption remainder, payment above liquid assets, and payment after closure. Partial and final payments were evaluated separately. Failed calls left accounting unchanged.

The model-based test checked the following relationships after every transition: on-chain supply equaled modeled supply; supply and token liabilities moved equally; total obligations equaled token, pending, and other liabilities; total obligations changed only through issuance and confirmed payment; aggregate pending liabilities equaled the sum of unpaid redemption records; and cumulative settlement equaled the reduction in liquid assets.

This evidence supports a narrow conclusion. No enumerated ordinary path in the implemented non-upgradeable token increased supply without controller enforcement. It does not prove resistance to malicious governance, a future code revision, or external wrapped and bridged representations. The controller administrator can still grant `TOKEN_ROLE` to another address, which remains a governance risk.

## Evaluating gas cost

Gas was measured from local Hardhat transaction receipts. Ten observations were collected per operation, restoring the same fixture before each observation. The measured operations were snapshot submission, aggregate proof-of-reserves reporting, advisory authorization, independent ERC-20 minting, atomic issuance, redemption request, partial settlement, and final settlement.

The advisory comparison used a separate adapter with `TOKEN_ROLE`; it updated controller liabilities without minting. The independent baseline used a permissioned test ERC-20. Adding those measurements represents the split two-transaction workflow. Atomic issuance measured the production-path call that performs both changes together.

| Operation | Samples | Median gas |
|---|---:|---:|
| Snapshot submission | 10 | 362,109 |
| Aggregate PoR report | 10 | 94,653 |
| Advisory authorization | 10 | 82,172 |
| Independent token mint | 10 | 70,834 |
| Atomic issuance | 10 | 132,573 |
| Redemption request | 10 | 148,122 |
| Partial settlement | 10 | 102,075 |
| Final settlement | 10 | 70,893 |

Atomic issuance used 50,401 more gas than advisory authorization alone, or 61.34 per cent. That is not a comparison of equivalent functionality because advisory authorization does not mint a token. Advisory authorization and independent minting together used 153,006 gas. Atomic issuance used 132,573 gas, a reduction of 20,433 gas, or 13.35 per cent, relative to the split functional comparison.

This does not establish that every atomic architecture will save 13.35 per cent. The result belongs to these contracts, storage states, compiler settings, and the local Hardhat EVM. It shows that the enforcement benefit did not impose a premium relative to the measured two-transaction alternative.

Snapshot gas changed slightly across separate runs. The standalone experiment measured 362,145 gas, while the final full-suite run measured 362,109. Timestamp-dependent EIP-712 signatures can alter zero and non-zero calldata bytes, providing a plausible explanation. The raw CSV observations are retained, and the paper should not describe snapshot gas as universally constant.

## Results: enforcement and cost

Successful issuance increased token supply and controller token liabilities by the same amount. Policy-invalid and unauthorized attempts reverted without changing either value. Redemption requests reduced supply and token liabilities equally, increased pending liabilities by the same amount, and left total obligations and liquid assets unchanged. Confirmed settlement reduced pending liabilities and liquid assets only by the paid amount. A redemption closed only after full payment.

The complete suite passed 31 tests, including 21 atomic integration and adversarial cases, the 128-transition invariant test, the gas experiment, the original controller tests, and the existing USDY-calibrated scenarios. TypeScript static checking also passed.

The cost comparison found that atomic issuance used 132,573 gas. Although this exceeded the incomplete advisory-only call, it was 20,433 gas below the sum of separate authorization and mint transactions. The main result is still enforcement: there is no interval in which one transaction has updated liabilities while another transaction has not yet minted, or vice versa.

The original financial findings were unchanged. Aggregate proof of reserves accepted issuance in the encumbered-assets scenario because gross reserves exceeded token liabilities. RWA-PoB rejected it because eligible reserves failed the required BCR. Under liquidity stress, backing remained sufficient but redemption was queued because short-horizon liquidity was inadequate. The contribution changes how those decisions control supply; it does not alter their definitions.

## Limitations

The contracts authenticate signed statements but do not prove their off-chain truth. Legal ownership, custody segregation, encumbrance, valuation, and bank-payment finality remain dependent on institutions and legal enforcement. All five institutions sign one aggregate snapshot rather than role-specific credentials. The Merkle root is authenticated but not interpreted on-chain, so the controller does not recalculate eligible reserves from position proofs or detect cross-issuer double-pledging.

Settlement confirmation identifies the authorized on-chain signer but is not bound to a bank transaction reference, currency, recipient-account commitment, payment rail, or external finality proof. A compromised settlement key can report payment that did not occur.

Governance can appoint signers, alter policy thresholds, revoke snapshots, and grant `TOKEN_ROLE` to another address. There is no timelock, multisignature requirement, policy floor, or single-token registration rule. The bypass tests address ordinary unauthorized callers, not malicious administration.

The single-chain token has no bridge, wrapper, rebase, or upgrade path. This simplifies the audit but does not solve global supply accounting. External wrapped or bridged claims may exist outside its `totalSupply`. The one-token-to-one-dollar assumption also omits NAV changes, yield, fees, decimal conversion, and rounding.

Liquidity is represented by one aggregate value and one pending-redemption denominator. The model does not distinguish intraday and multi-day horizons, market closures, settlement latency, maturity ladders, or stressed sale prices. Reserve positions and institutional keys are synthetic or simulated. USDY-derived data calibrate liability scale but do not constitute an audit of USDY.

The state machine uses one seed and 128 transitions. It is broader than example testing but is not exhaustive fuzzing or formal verification. Gas measurements come from a local Hardhat environment and are not fixed public-network or fiat costs.

## Future work after this contribution

The first priority is governance hardening. The controller should support one active liability adapter, multisignature and timelocked replacement, advance notice of role changes, and an emergency revocation mechanism that cannot grant new mint authority. Policy and institutional-signer changes should receive similar controls.

The aggregate snapshot should be divided into role-specific credentials. Custody claims should identify instruments, quantities, accounts, and segregation; legal claims should identify beneficial ownership and liens; valuation claims should bind prices, sources, and timestamps; liability claims should cover supply, fees, and pending redemptions; and settlement claims should bind payment evidence to a redemption identifier and amount.

Position-level Merkle verification could allow the contract or a verified aggregation layer to apply eligibility rules and haircuts rather than trusting only signed totals. Cross-issuer double-pledging will require a shared registry or commitment scheme beyond one reserve tree.

A changing-NAV product needs an authenticated token-to-liability conversion with a defined epoch, price source, fee treatment, precision, and rounding direction. Liquidity should be extended to several horizons with market calendars and stressed liquidation assumptions.

Cross-chain use requires global reconciliation of canonical issuance, bridge minting, burns, failed messages, and replayed instructions. Finally, the evaluation should add multiple seeds, longer state-machine runs, coverage-guided fuzzing, static analysis, and formal verification. Independent smart-contract and legal review would be required before a production pilot.
