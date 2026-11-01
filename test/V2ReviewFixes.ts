/**
 * Regression tests for the v2 changes made in response to review:
 *  1. settlement propagates to eligible reserves (v1 overstated BCR);
 *  2. role-scoped EIP-712 claims;
 *  3. position-level Merkle verification and permissionless challenge;
 *  4. custodian-signed subscription receipts.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import hre from "hardhat";
import { StandardMerkleTree } from "@openzeppelin/merkle-tree";
import { keccak256, toBytes, type Hex } from "viem";

import {
  POLICY_HASH,
  WAD,
  makeSnapshot,
  roleClaimMessage,
  roleClaimTypes,
  signSnapshot,
  signSnapshotV1,
  signSubscriptionReceipt,
  usd,
} from "./helpers.js";

const { viem, networkHelpers } = await hre.network.create();

const ROLES = [
  "CUSTODIAN_ROLE",
  "ADMINISTRATOR_ROLE",
  "VALUATION_ROLE",
  "LEGAL_ROLE",
  "VERIFIER_ROLE",
  "SETTLEMENT_ROLE",
  "TOKEN_ROLE",
] as const;

async function deploy(contractName: "PoBPolicyController" | "PoBPolicyControllerV1", minBcr = WAD) {
  const wallets = await viem.getWalletClients();
  const [admin, custodian, administrator, valuation, legal, verifier, outsider, holder] = wallets;
  const controller = await viem.deployContract(contractName, [POLICY_HASH, minBcr, WAD, 86_400n]);
  const holders = [custodian, administrator, valuation, legal, verifier, admin, admin];
  for (const [i, role] of ROLES.entries()) {
    await controller.write.grantRole([keccak256(toBytes(role)), holders[i].account.address], {
      account: admin.account,
    });
  }
  const client = await viem.getPublicClient();
  return {
    controller: controller as any,
    client,
    chainId: await client.getChainId(),
    now: (await client.getBlock()).timestamp,
    admin,
    custodian,
    outsider,
    holder,
    signers: [custodian, administrator, valuation, legal, verifier],
  };
}

const deployV2 = () => deploy("PoBPolicyController");
const deployV1 = () => deploy("PoBPolicyControllerV1");

// Reviewer example: 100 eligible / 100 liabilities; 20 is redeemed and settled.
const reviewerSnapshot = (now: bigint, root?: Hex) =>
  makeSnapshot(now, {
    ...(root ? { reserveRoot: root } : {}),
    grossReserves: usd("100"),
    eligibleReserves: usd("100"),
    liquidAssets: usd("20"),
    tokenLiabilities: usd("100"),
    pendingRedemptions: 0n,
    otherLiabilities: 0n,
  });

describe("v2 fix 1: settlement reduces eligible reserves", function () {
  it("v1 overstates BCR at 125% after settling 20 of 100 (reviewer example)", async function () {
    const env = await networkHelpers.loadFixture(deployV1);
    const snap = reviewerSnapshot(env.now);
    await env.controller.write.submitSnapshot(
      [snap, await signSnapshotV1(env.signers, env.chainId, env.controller.address, snap)],
      { account: env.admin.account },
    );
    // Redeem 20, then settle it from liquid cash.
    await env.controller.write.requestRedemption([env.holder.account.address, usd("20")], {
      account: env.admin.account,
    });
    const id = (await env.controller.read.nextRedemptionId()) - 1n;
    await env.controller.write.confirmSettlement([id, usd("20")], { account: env.admin.account });
    // v1: eligible stays 100 while liabilities fall to 80.
    assert.equal(await env.controller.read.currentBCR(), (125n * WAD) / 100n);
  });

  it("v2 reports 100% for the same sequence and blocks a mint the v1 rule allows", async function () {
    const env = await networkHelpers.loadFixture(deployV2);
    // Policy floor 110%: v1 would see 125% and allow a mint; v2 sees 100%.
    const snap = reviewerSnapshot(env.now);
    await env.controller.write.submitSnapshot(
      [snap, await signSnapshot(env.signers, env.chainId, env.controller.address, snap)],
      { account: env.admin.account },
    );
    await env.controller.write.setPolicy([POLICY_HASH, (110n * WAD) / 100n, WAD, 86_400n], {
      account: env.admin.account,
    });
    await env.controller.write.requestRedemption([env.holder.account.address, usd("20")], {
      account: env.admin.account,
    });
    const id = (await env.controller.read.nextRedemptionId()) - 1n;
    await env.controller.write.confirmSettlement([id, usd("20")], { account: env.admin.account });
    assert.equal(await env.controller.read.currentEligibleReserves(), usd("80"));
    assert.equal(await env.controller.read.currentGrossReserves(), usd("80"));
    assert.equal(await env.controller.read.currentBCR(), WAD);
    assert.equal(await env.controller.read.canMint([usd("1")]), false);
  });
});

describe("v2 fix 2: role-scoped claims", function () {
  it("rejects a full-snapshot signature in a field-scoped role slot", async function () {
    const env = await networkHelpers.loadFixture(deployV2);
    const snap = makeSnapshot(env.now);
    const signatures = await signSnapshotV1(env.signers, env.chainId, env.controller.address, snap);
    await assert.rejects(
      env.controller.write.submitSnapshot([snap, signatures], { account: env.admin.account }),
    );
  });

  it("rejects correctly scoped signatures supplied out of role order", async function () {
    const env = await networkHelpers.loadFixture(deployV2);
    const snap = makeSnapshot(env.now);
    const s = await signSnapshot(env.signers, env.chainId, env.controller.address, snap);
    await assert.rejects(
      env.controller.write.submitSnapshot([snap, [s[1], s[0], s[2], s[3], s[4]]], {
        account: env.admin.account,
      }),
    );
  });

  it("a custodian signature cannot vouch for liabilities", async function () {
    const env = await networkHelpers.loadFixture(deployV2);
    const snap = makeSnapshot(env.now);
    const s = await signSnapshot(env.signers, env.chainId, env.controller.address, snap);
    // The custodian signs the administrator's liability claim instead of its own.
    const domain = { name: "RWA-PoB", version: "1", chainId: env.chainId, verifyingContract: env.controller.address };
    const forged = await env.custodian.signTypedData({
      account: env.custodian.account,
      domain,
      types: roleClaimTypes[1].types,
      primaryType: roleClaimTypes[1].primaryType,
      message: roleClaimMessage(1, snap),
    } as any);
    await assert.rejects(
      env.controller.write.submitSnapshot([snap, [s[0], forged, s[2], s[3], s[4]]], {
        account: env.admin.account,
      }),
    );
  });

  it("a role's signature does not cover fields outside its claim", async function () {
    const env = await networkHelpers.loadFixture(deployV2);
    const snap = makeSnapshot(env.now);
    const s = await signSnapshot(env.signers, env.chainId, env.controller.address, snap);
    // Changing eligible reserves invalidates only the valuation and verifier
    // claims; reusing their old signatures must fail.
    const tampered = { ...snap, eligibleReserves: snap.eligibleReserves + usd("1") };
    await assert.rejects(
      env.controller.write.submitSnapshot([tampered, s], { account: env.admin.account }),
    );
    const claim0 = await env.controller.read.hashRoleClaim([0, snap]);
    const claim0Tampered = await env.controller.read.hashRoleClaim([0, tampered]);
    assert.equal(claim0, claim0Tampered, "custody claim does not include eligibleReserves");
    const claim2 = await env.controller.read.hashRoleClaim([2, snap]);
    const claim2Tampered = await env.controller.read.hashRoleClaim([2, tampered]);
    assert.notEqual(claim2, claim2Tampered, "valuation claim includes eligibleReserves");
  });
});

// Position leaves use the same field order as ReservePosition.
const POSITION_TYPES = [
  "string", "string", "uint256", "uint256", "uint256", "uint256", "uint256", "uint256", "bool", "bool", "bool",
];
type Position = [string, string, bigint, bigint, bigint, bigint, bigint, bigint, boolean, boolean, boolean];
const toStruct = (p: Position) => ({
  positionId: p[0],
  instrumentId: p[1],
  faceValue: p[2],
  marketValue: p[3],
  eligibleValue: p[4],
  liquidValue: p[5],
  maturityDays: p[6],
  haircutBps: p[7],
  encumbered: p[8],
  legallyEligible: p[9],
  settlementFinal: p[10],
});

function positionTree() {
  const good: Position = ["P-1", "912797KX4", usd("50"), usd("49"), usd("48"), usd("10"), 30n, 100n, false, true, true];
  const pledgedButCounted: Position = ["P-2", "912797LB1", usd("50"), usd("49"), usd("48"), 0n, 90n, 100n, true, true, true];
  const tree = StandardMerkleTree.of([good, pledgedButCounted], POSITION_TYPES);
  return { tree, good, pledgedButCounted };
}

describe("v2 fix 3: Merkle position challenge", function () {
  async function withRoot() {
    const env = await deployV2();
    const { tree, good, pledgedButCounted } = positionTree();
    const snap = reviewerSnapshot(env.now, tree.root as Hex);
    await env.controller.write.submitSnapshot(
      [snap, await signSnapshot(env.signers, env.chainId, env.controller.address, snap)],
      { account: env.admin.account },
    );
    return { ...env, tree, good, pledgedButCounted };
  }

  it("on-chain leaf hash matches the OpenZeppelin StandardMerkleTree leaf", async function () {
    const env = await networkHelpers.loadFixture(withRoot);
    const leaf = await env.controller.read.reservePositionLeaf([toStruct(env.good)]);
    assert.equal(leaf, env.tree.leafHash(env.good));
    assert.equal(
      await env.controller.read.verifyReservePosition([toStruct(env.good), env.tree.getProof(0)]),
      true,
    );
  });

  it("rejects a challenge against a consistent position", async function () {
    const env = await networkHelpers.loadFixture(withRoot);
    await assert.rejects(
      env.controller.write.challengeReservePosition([toStruct(env.good), env.tree.getProof(0)], {
        account: env.outsider.account,
      }),
      /PositionIsConsistent/,
    );
  });

  it("rejects a challenge with an invalid proof", async function () {
    const env = await networkHelpers.loadFixture(withRoot);
    await assert.rejects(
      env.controller.write.challengeReservePosition([toStruct(env.pledgedButCounted), env.tree.getProof(0)], {
        account: env.outsider.account,
      }),
      /InvalidMerkleProof/,
    );
  });

  it("anyone can suspend minting by proving an encumbered position was counted", async function () {
    const env = await networkHelpers.loadFixture(withRoot);
    assert.equal(
      await env.controller.read.positionInconsistency([toStruct(env.pledgedButCounted)]),
      1, // EncumberedButEligible
    );
    await env.controller.write.challengeReservePosition(
      [toStruct(env.pledgedButCounted), env.tree.getProof(1)],
      { account: env.outsider.account },
    );
    assert.equal(await env.controller.read.isSnapshotFresh(), false);
    assert.equal(await env.controller.read.canMint([1n]), false);
  });
});

describe("v2 fix 4: custodian-signed subscription receipts", function () {
  async function withSnapshot() {
    const env = await deployV2();
    // 105 eligible / 100 liabilities; floor 101%.
    const snap = makeSnapshot(env.now, {
      grossReserves: usd("105"),
      eligibleReserves: usd("105"),
      liquidAssets: usd("10"),
      tokenLiabilities: usd("100"),
      pendingRedemptions: 0n,
      otherLiabilities: 0n,
    });
    await env.controller.write.submitSnapshot(
      [snap, await signSnapshot(env.signers, env.chainId, env.controller.address, snap)],
      { account: env.admin.account },
    );
    await env.controller.write.setPolicy([POLICY_HASH, (101n * WAD) / 100n, WAD, 86_400n], {
      account: env.admin.account,
    });
    return { ...env, epoch: snap.epoch };
  }

  it("without a receipt the mint is blocked; with one the cash is credited atomically", async function () {
    const env = await networkHelpers.loadFixture(withSnapshot);
    const amount = usd("10");
    assert.equal(await env.controller.read.canMint([amount]), false);
    assert.equal(await env.controller.read.canMintWithReceipt([amount, amount]), true);
    const sig = await signSubscriptionReceipt(env.custodian, env.chainId, env.controller.address, {
      epoch: env.epoch,
      amount,
      nonce: 1n,
    });
    await env.controller.write.authorizeMintWithReceipt([amount, amount, 1n, sig], { account: env.admin.account });
    assert.equal(await env.controller.read.creditedSubscriptionCash(), amount);
    assert.equal(await env.controller.read.currentEligibleReserves(), usd("115"));
    assert.equal(await env.controller.read.currentTotalLiabilities(), usd("110"));
  });

  it("rejects a replayed receipt and a receipt not signed by the custodian", async function () {
    const env = await networkHelpers.loadFixture(withSnapshot);
    const amount = usd("1");
    const sig = await signSubscriptionReceipt(env.custodian, env.chainId, env.controller.address, {
      epoch: env.epoch,
      amount,
      nonce: 7n,
    });
    await env.controller.write.authorizeMintWithReceipt([amount, amount, 7n, sig], { account: env.admin.account });
    await assert.rejects(
      env.controller.write.authorizeMintWithReceipt([amount, amount, 7n, sig], { account: env.admin.account }),
      /InvalidSubscriptionReceipt/,
    );
    const outsiderSig = await signSubscriptionReceipt(env.outsider, env.chainId, env.controller.address, {
      epoch: env.epoch,
      amount,
      nonce: 8n,
    });
    await assert.rejects(
      env.controller.write.authorizeMintWithReceipt([amount, amount, 8n, outsiderSig], { account: env.admin.account }),
      /InvalidSubscriptionReceipt/,
    );
  });

  it("credits nothing when the policy check fails", async function () {
    const env = await networkHelpers.loadFixture(withSnapshot);
    // Pending redemptions with no liquidity left: RLC fails, so the whole call reverts.
    await env.controller.write.requestRedemption([env.holder.account.address, usd("50")], {
      account: env.admin.account,
    });
    const amount = usd("1");
    const sig = await signSubscriptionReceipt(env.custodian, env.chainId, env.controller.address, {
      epoch: env.epoch,
      amount,
      nonce: 9n,
    });
    await assert.rejects(
      env.controller.write.authorizeMintWithReceipt([amount, amount, 9n, sig], { account: env.admin.account }),
      /MintPolicyFailed/,
    );
    assert.equal(await env.controller.read.creditedSubscriptionCash(), 0n);
  });

  it("a receipt is bound to the current snapshot epoch", async function () {
    const env = await networkHelpers.loadFixture(withSnapshot);
    const amount = usd("2");
    const sig = await signSubscriptionReceipt(env.custodian, env.chainId, env.controller.address, {
      epoch: env.epoch + 1n,
      amount,
      nonce: 1n,
    });
    await assert.rejects(
      env.controller.write.authorizeMintWithReceipt([amount, amount, 1n, sig], { account: env.admin.account }),
      /InvalidSubscriptionReceipt/,
    );
  });
});
