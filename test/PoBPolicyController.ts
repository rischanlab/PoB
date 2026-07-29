import assert from "node:assert/strict";
import { describe, it } from "node:test";
import hre from "hardhat";
import { keccak256, toBytes } from "viem";

import {
  POLICY_HASH,
  WAD,
  makeSnapshot,
  signSnapshot,
  usd,
} from "./helpers.js";

const { viem, networkHelpers } = await hre.network.create();

async function deployFixture() {
  const wallets = await viem.getWalletClients();
  const [admin, custodian, administrator, valuation, legal, verifier, settlement] =
    wallets;

  const controller = await viem.deployContract("PoBPolicyController", [
    POLICY_HASH,
    105n * WAD / 100n,
    WAD,
    86_400n,
  ]);
  const baseline = await viem.deployContract("AggregatePoRBaseline");

  const roleAssignments = [
    ["CUSTODIAN_ROLE", custodian.account.address],
    ["ADMINISTRATOR_ROLE", administrator.account.address],
    ["VALUATION_ROLE", valuation.account.address],
    ["LEGAL_ROLE", legal.account.address],
    ["VERIFIER_ROLE", verifier.account.address],
    ["SETTLEMENT_ROLE", settlement.account.address],
  ] as const;

  for (const [roleName, address] of roleAssignments) {
    const role = keccak256(toBytes(roleName));
    await controller.write.grantRole([role, address], {
      account: admin.account,
    });
  }

  const publicClient = await viem.getPublicClient();
  const chainId = await publicClient.getChainId();
  const block = await publicClient.getBlock();

  const snapshotSigners = [
    custodian,
    administrator,
    valuation,
    legal,
    verifier,
  ];

  return {
    controller,
    baseline,
    publicClient,
    networkHelpers,
    chainId,
    now: block.timestamp,
    admin,
    settlement,
    snapshotSigners,
  };
}

describe("PoBPolicyController", function () {
  it("accepts a fresh snapshot signed by every mandatory role", async function () {
    const env = await networkHelpers.loadFixture(deployFixture);
    const snapshot = makeSnapshot(env.now);
    const signatures = await signSnapshot(
      env.snapshotSigners,
      env.chainId,
      env.controller.address,
      snapshot,
    );

    await env.controller.write.submitSnapshot([snapshot, signatures], {
      account: env.admin.account,
    });

    assert.equal(await env.controller.read.isSnapshotFresh(), true);
    assert.equal(await env.controller.read.currentTotalLiabilities(), usd("910000000"));
    assert.equal(await env.controller.read.canMint([usd("50000000")]), true);
    assert.equal(await env.controller.read.canMint([usd("70000000")]), false);
  });

  it("rejects a snapshot when a mandatory signature is missing", async function () {
    const env = await networkHelpers.loadFixture(deployFixture);
    const snapshot = makeSnapshot(env.now);
    const signatures = await signSnapshot(
      env.snapshotSigners.slice(0, 4),
      env.chainId,
      env.controller.address,
      snapshot,
    );

    await assert.rejects(
      env.controller.write.submitSnapshot([snapshot, signatures], {
        account: env.admin.account,
      }),
    );
  });

  it("rejects replay of the same signed snapshot", async function () {
    const env = await networkHelpers.loadFixture(deployFixture);
    const snapshot = makeSnapshot(env.now);
    const signatures = await signSnapshot(
      env.snapshotSigners,
      env.chainId,
      env.controller.address,
      snapshot,
    );

    await env.controller.write.submitSnapshot([snapshot, signatures], {
      account: env.admin.account,
    });

    await assert.rejects(
      env.controller.write.submitSnapshot([snapshot, signatures], {
        account: env.admin.account,
      }),
    );
  });

  it("shows why eligible reserves are stricter than aggregate PoR", async function () {
    const env = await networkHelpers.loadFixture(deployFixture);
    const snapshot = makeSnapshot(env.now, {
      grossReserves: usd("1050000000"),
      eligibleReserves: usd("850000000"),
    });
    const signatures = await signSnapshot(
      env.snapshotSigners,
      env.chainId,
      env.controller.address,
      snapshot,
    );

    await env.controller.write.submitSnapshot([snapshot, signatures], {
      account: env.admin.account,
    });
    await env.baseline.write.updateReport([
      snapshot.grossReserves,
      snapshot.tokenLiabilities,
      snapshot.validUntil,
    ]);

    assert.equal(await env.baseline.read.canMint([usd("1")]), true);
    assert.equal(await env.controller.read.canMint([usd("1")]), false);
  });

  it("queues a redemption when liquid assets are insufficient", async function () {
    const env = await networkHelpers.loadFixture(deployFixture);
    const snapshot = makeSnapshot(env.now, {
      liquidAssets: usd("20000000"),
    });
    const signatures = await signSnapshot(
      env.snapshotSigners,
      env.chainId,
      env.controller.address,
      snapshot,
    );

    await env.controller.write.submitSnapshot([snapshot, signatures], {
      account: env.admin.account,
    });

    const disposition = await env.controller.read.redemptionDisposition([
      usd("50000000"),
    ]);
    assert.equal(disposition, 1); // Queue

    await env.controller.write.requestRedemption([
      env.admin.account.address,
      usd("50000000"),
    ]);
    assert.equal(
      await env.controller.read.currentPendingRedemptions(),
      usd("50000000"),
    );
    assert.equal(
      await env.controller.read.currentTotalLiabilities(),
      usd("910000000"),
    );
  });

  it("keeps a redemption as a liability until settlement", async function () {
    const env = await networkHelpers.loadFixture(deployFixture);
    const snapshot = makeSnapshot(env.now);
    const signatures = await signSnapshot(
      env.snapshotSigners,
      env.chainId,
      env.controller.address,
      snapshot,
    );

    await env.controller.write.submitSnapshot([snapshot, signatures], {
      account: env.admin.account,
    });
    await env.controller.write.requestRedemption([
      env.admin.account.address,
      usd("40000000"),
    ]);

    assert.equal(
      await env.controller.read.currentTotalLiabilities(),
      usd("910000000"),
    );

    await env.controller.write.confirmSettlement([1n, usd("40000000")], {
      account: env.settlement.account,
    });

    assert.equal(
      await env.controller.read.currentTotalLiabilities(),
      usd("870000000"),
    );
    assert.equal(await env.controller.read.currentPendingRedemptions(), 0n);
  });

  it("stops mint authorization after the snapshot becomes stale", async function () {
    const env = await networkHelpers.loadFixture(deployFixture);
    const snapshot = makeSnapshot(env.now, {
      validUntil: env.now + 172_800n,
    });
    const signatures = await signSnapshot(
      env.snapshotSigners,
      env.chainId,
      env.controller.address,
      snapshot,
    );

    await env.controller.write.submitSnapshot([snapshot, signatures], {
      account: env.admin.account,
    });
    await env.networkHelpers.time.increase(86_401);

    assert.equal(await env.controller.read.isSnapshotFresh(), false);
    assert.equal(await env.controller.read.canMint([usd("1")]), false);
  });
});
