/**
 * Multi-epoch accounting on ONE persistent controller (review points 8, 13).
 *
 * Five successive snapshots on the same deployment, with receipt-backed mints,
 * redemptions, partial settlement across a snapshot boundary, receipt replay,
 * snapshot expiry, a policy update, and a role rotation. After every step an
 * independent off-chain ledger is compared with the controller:
 *   total liabilities = token liabilities + pending claims + other liabilities
 *   eligible / liquid / gross reserves fall by exactly the settled amount and
 *   rise by exactly the receipt-credited cash.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import hre from "hardhat";
import { keccak256, toBytes } from "viem";

import { POLICY_HASH, WAD, makeSnapshot, signSnapshot, signSubscriptionReceipt, usd } from "./helpers.js";

const { viem, networkHelpers } = await hre.network.create();
const ROLE_NAMES = ["CUSTODIAN_ROLE", "ADMINISTRATOR_ROLE", "VALUATION_ROLE", "LEGAL_ROLE", "VERIFIER_ROLE", "SETTLEMENT_ROLE", "TOKEN_ROLE"];
const role = (n: string) => keccak256(toBytes(n));

describe("Persistent controller: liability and reserve continuity across epochs", function () {
  it("conserves liabilities and reserves over five snapshots without redeployment", async function () {
    const wallets = await viem.getWalletClients();
    const [admin, custodian, administrator, valuation, legal, verifier, holder, newCustodian] = wallets;
    let signers = [custodian, administrator, valuation, legal, verifier];
    const c = (await viem.deployContract("PoBPolicyController", [POLICY_HASH, (101n * WAD) / 100n, WAD, 86_400n])) as any;
    const holders = [custodian, administrator, valuation, legal, verifier, admin, admin];
    for (const [i, r] of ROLE_NAMES.entries()) await c.write.grantRole([role(r), holders[i].account.address], { account: admin.account });
    const client = await viem.getPublicClient();
    const chainId = await client.getChainId();
    const as = { account: admin.account };

    // Independent ledger.
    const L = { token: 0n, pending: 0n, other: usd("1"), gross: 0n, eligible: 0n, liquid: 0n };
    const claims = new Map<bigint, bigint>(); // id -> open amount
    let checks = 0;
    const check = async (label: string) => {
      assert.equal(await c.read.currentTokenLiabilities(), L.token, `${label}: token`);
      assert.equal(await c.read.currentPendingRedemptions(), L.pending, `${label}: pending`);
      assert.equal(L.pending, [...claims.values()].reduce((a, b) => a + b, 0n), `${label}: claims`);
      assert.equal(await c.read.currentTotalLiabilities(), L.token + L.pending + L.other, `${label}: total`);
      assert.equal(await c.read.currentEligibleReserves(), L.eligible, `${label}: eligible`);
      assert.equal(await c.read.currentLiquidAssets(), L.liquid, `${label}: liquid`);
      assert.equal(await c.read.currentGrossReserves(), L.gross, `${label}: gross`);
      checks++;
    };
    let epoch = 0n;
    let policy = POLICY_HASH;
    const submit = async (over: Record<string, bigint> = {}) => {
      epoch += 1n;
      const now = (await client.getBlock()).timestamp;
      const snap = makeSnapshot(now, {
        epoch, policyHash: policy,
        grossReserves: L.gross, eligibleReserves: L.eligible, liquidAssets: L.liquid,
        tokenLiabilities: L.token, pendingRedemptions: L.pending, otherLiabilities: L.other, ...over,
      });
      return { snap, tx: c.write.submitSnapshot([snap, await signSnapshot(signers, chainId, c.address, snap)], as) };
    };
    const mint = async (amount: bigint, cash: bigint, nonce: bigint) => {
      const sig = await signSubscriptionReceipt(signers[0], chainId, c.address, { epoch, amount: cash, nonce });
      await c.write.authorizeMintWithReceipt([amount, cash, nonce, sig], as);
      L.token += amount; L.gross += cash; L.eligible += cash; L.liquid += cash;
      return sig;
    };
    const redeem = async (amount: bigint) => {
      await c.write.requestRedemption([holder.account.address, amount], as);
      const id = (await c.read.nextRedemptionId()) - 1n;
      claims.set(id, amount); L.token -= amount; L.pending += amount;
      return id;
    };
    const settle = async (id: bigint, amount: bigint) => {
      await c.write.confirmSettlement([id, amount], as);
      claims.set(id, claims.get(id)! - amount);
      if (claims.get(id) === 0n) claims.delete(id);
      L.pending -= amount; L.gross -= amount; L.eligible -= amount; L.liquid -= amount;
    };

    // Epoch 1: initial state.
    Object.assign(L, { token: usd("100"), gross: usd("112"), eligible: usd("110"), liquid: usd("30") });
    await (await submit()).tx;
    await check("E1 accepted");
    const r1 = await mint(usd("10"), usd("10.3"), 1n);
    await check("E1 mint");
    const id1 = await redeem(usd("20"));
    await check("E1 redeem");
    await settle(id1, usd("8"));
    await check("E1 partial settlement");

    // Epoch 2: a snapshot that drops the open claim fails continuity.
    await networkHelpers.time.increase(3_600);
    const wrong = await submit({ pendingRedemptions: 0n, tokenLiabilities: L.token + L.pending });
    await assert.rejects(wrong.tx, /LiabilityContinuityFailure/);
    epoch -= 1n;
    await (await submit()).tx;
    await check("E2 accepted (claim carried)");
    // An epoch-1 receipt cannot be reused in epoch 2.
    await assert.rejects(c.write.authorizeMintWithReceipt([usd("10"), usd("10.3"), 1n, r1], as), /InvalidSubscriptionReceipt/);
    await settle(id1, usd("12")); // the rest of the epoch-1 claim, after the boundary
    await check("E2 settles epoch-1 claim");
    const r2 = await mint(usd("5"), usd("5.15"), 2n);
    await assert.rejects(c.write.authorizeMintWithReceipt([usd("5"), usd("5.15"), 2n, r2], as), /InvalidSubscriptionReceipt/);
    const id2 = await redeem(usd("7"));
    await check("E2 mint + redeem");

    // Epoch 3: policy update makes the current snapshot stale; old hash rejected.
    await networkHelpers.time.increase(3_600);
    const newPolicy = keccak256(toBytes("RWA-PoB policy v2"));
    await c.write.setPolicy([newPolicy, (101n * WAD) / 100n, WAD, 86_400n], as);
    assert.equal(await c.read.isSnapshotFresh(), false);
    await assert.rejects((await submit()).tx, /InvalidPolicyHash/);
    epoch -= 1n;
    policy = newPolicy;
    await (await submit()).tx;
    await check("E3 accepted under new policy");
    // A lower epoch is rejected.
    const stale = makeSnapshot((await client.getBlock()).timestamp, { epoch: 2n, policyHash: policy, grossReserves: L.gross, eligibleReserves: L.eligible, liquidAssets: L.liquid, tokenLiabilities: L.token, pendingRedemptions: L.pending, otherLiabilities: L.other });
    await assert.rejects(c.write.submitSnapshot([stale, await signSnapshot(signers, chainId, c.address, stale)], as), /InvalidSnapshotEpoch/);

    // Expiry: the epoch-3 snapshot lapses; minting stops, redemptions queue.
    await networkHelpers.time.increase(86_401);
    assert.equal(await c.read.canMint([1n]), false);
    const id3 = await redeem(usd("2"));
    assert.equal(Number((await c.read.redemptions([id3]))[3]), 1);
    await settle(id2, usd("7"));
    await check("E3 expired: queue + settlement");

    // Epoch 4: custodian rotated; the old custodian can no longer sign.
    await c.write.revokeRole([role("CUSTODIAN_ROLE"), custodian.account.address], as);
    await c.write.grantRole([role("CUSTODIAN_ROLE"), newCustodian.account.address], as);
    await assert.rejects((await submit()).tx, /SignerHasNoRequiredRole/);
    epoch -= 1n;
    signers = [newCustodian, administrator, valuation, legal, verifier];
    await (await submit()).tx;
    await check("E4 accepted after rotation");
    await mint(usd("3"), usd("3.09"), 3n);
    await settle(id3, usd("2"));
    await check("E4 mint + settle");

    // Epoch 5: a clean snapshot of the final state.
    await networkHelpers.time.increase(3_600);
    await (await submit()).tx;
    await check("E5 accepted");
    assert.equal(claims.size, 0);
    assert.equal(epoch, 5n);
    assert.ok(checks >= 12);
  });
});
