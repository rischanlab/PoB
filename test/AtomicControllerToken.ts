import assert from "node:assert/strict";
import { describe, it } from "node:test";
import hre from "hardhat";
import { keccak256, toBytes } from "viem";

import {
  POLICY_HASH,
  WAD,
  makeSnapshot,
  signSnapshot,
  signSubscriptionReceipt,
  type Snapshot,
  usd,
} from "./helpers.js";

const { viem, networkHelpers } = await hre.network.create();

async function deployAtomicFixture() {
  const wallets = await viem.getWalletClients();
  const [
    admin,
    custodian,
    administrator,
    valuation,
    legal,
    verifier,
    holder,
    settlement,
  ] = wallets;

  const controller = await viem.deployContract("PoBPolicyController", [
    POLICY_HASH,
    (105n * WAD) / 100n,
    WAD,
    86_400n,
  ]);
  const token = await viem.deployContract("RWABackedToken", [
    controller.address,
    admin.account.address,
  ]);

  const signerAssignments = [
    ["CUSTODIAN_ROLE", custodian.account.address],
    ["ADMINISTRATOR_ROLE", administrator.account.address],
    ["VALUATION_ROLE", valuation.account.address],
    ["LEGAL_ROLE", legal.account.address],
    ["VERIFIER_ROLE", verifier.account.address],
  ] as const;

  for (const [roleName, address] of signerAssignments) {
    await controller.write.grantRole(
      [keccak256(toBytes(roleName)), address],
      { account: admin.account },
    );
  }

  // Only the token may call the controller's liability-changing operations.
  // The issuer initiates issuance through token.issue(), but cannot bypass it
  // by calling controller.authorizeMint() directly.
  const tokenRole = keccak256(toBytes("TOKEN_ROLE"));
  await controller.write.grantRole(
    [tokenRole, token.address],
    { account: admin.account },
  );

  // Settlement authority is independent from governance in this fixture.
  const settlementRole = keccak256(toBytes("SETTLEMENT_ROLE"));
  await controller.write.grantRole(
    [settlementRole, settlement.account.address],
    { account: admin.account },
  );
  await controller.write.revokeRole(
    [settlementRole, admin.account.address],
    { account: admin.account },
  );

  const publicClient = await viem.getPublicClient();
  const chainId = await publicClient.getChainId();
  const block = await publicClient.getBlock();

  return {
    controller,
    token,
    publicClient,
    chainId,
    now: block.timestamp,
    admin,
    holder,
    settlement,
    tokenRole,
    settlementRole,
    snapshotSigners: [
      custodian,
      administrator,
      valuation,
      legal,
      verifier,
    ],
  };
}

async function submitValidSnapshot(
  env: Awaited<ReturnType<typeof deployAtomicFixture>>,
  overrides: Partial<Snapshot> = {},
) {
  const snapshot = makeSnapshot(env.now, overrides);
  const signatures = await signSnapshot(
    env.snapshotSigners,
    env.chainId,
    env.controller.address,
    snapshot,
  );

  await env.controller.write.submitSnapshot([snapshot, signatures], {
    account: env.admin.account,
  });
}

async function issueToHolder(
  env: Awaited<ReturnType<typeof deployAtomicFixture>>,
  amount: bigint,
) {
  await env.token.write.issue([env.holder.account.address, amount], {
    account: env.admin.account,
  });
}

describe("Atomic controller-token integration", function () {
  it("assigns controller operations exclusively to the token", async function () {
    const env = await networkHelpers.loadFixture(deployAtomicFixture);

    assert.equal(
      await env.controller.read.hasRole([
        env.tokenRole,
        env.token.address,
      ]),
      true,
    );
    assert.equal(
      await env.controller.read.hasRole([
        env.tokenRole,
        env.admin.account.address,
      ]),
      false,
    );
  });

  it("atomically increases supply and token liabilities", async function () {
    const env = await networkHelpers.loadFixture(deployAtomicFixture);
    await submitValidSnapshot(env);

    const amount = usd("1000000");
    const supplyBefore =
      (await env.token.read.totalSupply()) as bigint;
    const liabilityBefore =
      (await env.controller.read.currentTokenLiabilities()) as bigint;

    await env.token.write.issue([env.holder.account.address, amount], {
      account: env.admin.account,
    });

    assert.equal(
      await env.token.read.totalSupply(),
      supplyBefore + amount,
    );
    assert.equal(
      await env.token.read.balanceOf([env.holder.account.address]),
      amount,
    );
    assert.equal(
      await env.controller.read.currentTokenLiabilities(),
      liabilityBefore + amount,
    );
  });

  it("issues against a custodian receipt atomically (issueWithReceipt)", async function () {
    const env = await networkHelpers.loadFixture(deployAtomicFixture);
    await submitValidSnapshot(env);
    const amount = usd("1000000");
    const cash = usd("1030000");
    const eligibleBefore = (await env.controller.read.currentEligibleReserves()) as bigint;
    const sig = await signSubscriptionReceipt(env.snapshotSigners[0], env.chainId, env.controller.address, { epoch: 1n, amount: cash, nonce: 7n });
    await env.token.write.issueWithReceipt([env.holder.account.address, amount, cash, 7n, sig], { account: env.admin.account });
    assert.equal(await env.token.read.totalSupply(), amount);
    assert.equal(await env.controller.read.creditedSubscriptionCash(), cash);
    assert.equal(await env.controller.read.currentEligibleReserves(), eligibleBefore + cash);
    // The same receipt cannot be used twice.
    await assert.rejects(
      env.token.write.issueWithReceipt([env.holder.account.address, amount, cash, 7n, sig], { account: env.admin.account }),
    );
    assert.equal(await env.token.read.totalSupply(), amount);
  });

  it("rolls back receipt issuance that fails the policy: nothing credited or minted", async function () {
    const env = await networkHelpers.loadFixture(deployAtomicFixture);
    await submitValidSnapshot(env);
    const amount = usd("200000000");
    const cash = usd("1000000");
    const sig = await signSubscriptionReceipt(env.snapshotSigners[0], env.chainId, env.controller.address, { epoch: 1n, amount: cash, nonce: 8n });
    await assert.rejects(
      env.token.write.issueWithReceipt([env.holder.account.address, amount, cash, 8n, sig], { account: env.admin.account }),
    );
    assert.equal(await env.token.read.totalSupply(), 0n);
    assert.equal(await env.controller.read.creditedSubscriptionCash(), 0n);
  });

  it("rolls back issuance when no valid snapshot exists", async function () {
    const env = await networkHelpers.loadFixture(deployAtomicFixture);
    const amount = usd("1000000");

    await assert.rejects(
      env.token.write.issue([env.holder.account.address, amount], {
        account: env.admin.account,
      }),
    );

    assert.equal(await env.token.read.totalSupply(), 0n);
    assert.equal(
      await env.token.read.balanceOf([env.holder.account.address]),
      0n,
    );
    assert.equal(
      await env.controller.read.additionalMintLiabilities(),
      0n,
    );
  });

  it("rejects direct controller authorization by the issuer", async function () {
    const env = await networkHelpers.loadFixture(deployAtomicFixture);
    await submitValidSnapshot(env);

    await assert.rejects(
      env.controller.write.authorizeMint([usd("1")], {
        account: env.admin.account,
      }),
    );

    assert.equal(
      await env.controller.read.additionalMintLiabilities(),
      0n,
    );
    assert.equal(await env.token.read.totalSupply(), 0n);
  });

  it("rejects token issuance by an account without the issuer role", async function () {
    const env = await networkHelpers.loadFixture(deployAtomicFixture);
    await submitValidSnapshot(env);

    await assert.rejects(
      env.token.write.issue([env.holder.account.address, usd("1")], {
        account: env.holder.account,
      }),
    );

    assert.equal(await env.token.read.totalSupply(), 0n);
    assert.equal(
      await env.controller.read.additionalMintLiabilities(),
      0n,
    );
  });

  it("rejects zero-value issuance", async function () {
    const env = await networkHelpers.loadFixture(deployAtomicFixture);
    await submitValidSnapshot(env);

    await assert.rejects(
      env.token.write.issue([env.holder.account.address, 0n], {
        account: env.admin.account,
      }),
    );

    assert.equal(await env.token.read.totalSupply(), 0n);
    assert.equal(
      await env.controller.read.additionalMintLiabilities(),
      0n,
    );
  });

  it("rejects issuance after the snapshot becomes stale", async function () {
    const env = await networkHelpers.loadFixture(deployAtomicFixture);
    await submitValidSnapshot(env, {
      validUntil: env.now + 172_800n,
    });
    await networkHelpers.time.increase(86_401);

    await assert.rejects(
      env.token.write.issue([env.holder.account.address, usd("1")], {
        account: env.admin.account,
      }),
    );

    assert.equal(await env.token.read.totalSupply(), 0n);
    assert.equal(
      await env.controller.read.additionalMintLiabilities(),
      0n,
    );
  });

  it("rejects issuance after snapshot revocation", async function () {
    const env = await networkHelpers.loadFixture(deployAtomicFixture);
    await submitValidSnapshot(env);
    await env.controller.write.revokeCurrentSnapshot([], {
      account: env.admin.account,
    });

    await assert.rejects(
      env.token.write.issue([env.holder.account.address, usd("1")], {
        account: env.admin.account,
      }),
    );

    assert.equal(await env.token.read.totalSupply(), 0n);
    assert.equal(
      await env.controller.read.additionalMintLiabilities(),
      0n,
    );
  });

  it("rejects issuance that would breach the minimum BCR", async function () {
    const env = await networkHelpers.loadFixture(deployAtomicFixture);
    await submitValidSnapshot(env);

    await assert.rejects(
      env.token.write.issue(
        [env.holder.account.address, usd("70000000")],
        { account: env.admin.account },
      ),
    );

    assert.equal(await env.token.read.totalSupply(), 0n);
    assert.equal(
      await env.controller.read.additionalMintLiabilities(),
      0n,
    );
  });

  it("rejects issuance while current RLC is below its threshold", async function () {
    const env = await networkHelpers.loadFixture(deployAtomicFixture);
    await submitValidSnapshot(env, {
      liquidAssets: usd("20000000"),
      pendingRedemptions: usd("50000000"),
    });

    const bcr = (await env.controller.read.currentBCR()) as bigint;
    const rlc = (await env.controller.read.currentRLC()) as bigint;
    assert.equal(bcr >= 105n * WAD / 100n, true);
    assert.equal(rlc < WAD, true);

    await assert.rejects(
      env.token.write.issue([env.holder.account.address, usd("1")], {
        account: env.admin.account,
      }),
    );

    assert.equal(await env.token.read.totalSupply(), 0n);
    assert.equal(
      await env.controller.read.additionalMintLiabilities(),
      0n,
    );
  });

  it("rejects mint authorization from an unregistered contract", async function () {
    const env = await networkHelpers.loadFixture(deployAtomicFixture);
    await submitValidSnapshot(env);
    const bypass = await viem.deployContract("ControllerBypassHarness");

    await assert.rejects(
      bypass.write.attemptMintAuthorization([
        env.controller.address,
        usd("1"),
      ]),
    );

    assert.equal(await env.token.read.totalSupply(), 0n);
    assert.equal(
      await env.controller.read.additionalMintLiabilities(),
      0n,
    );
  });

  it("rejects redemption accounting from an unregistered contract", async function () {
    const env = await networkHelpers.loadFixture(deployAtomicFixture);
    await submitValidSnapshot(env);
    const bypass = await viem.deployContract("ControllerBypassHarness");

    await assert.rejects(
      bypass.write.attemptRedemption([
        env.controller.address,
        env.holder.account.address,
        usd("1"),
      ]),
    );

    assert.equal(
      await env.controller.read.currentTokenLiabilities(),
      usd("900000000"),
    );
    assert.equal(
      await env.controller.read.currentPendingRedemptions(),
      0n,
    );
  });

  it("stops issuance when a policy update invalidates the snapshot", async function () {
    const env = await networkHelpers.loadFixture(deployAtomicFixture);
    await submitValidSnapshot(env);
    const replacementPolicy = keccak256(toBytes("RWA-PoB policy v2"));

    await env.controller.write.setPolicy(
      [replacementPolicy, (105n * WAD) / 100n, WAD, 86_400n],
      { account: env.admin.account },
    );

    await assert.rejects(
      env.token.write.issue([env.holder.account.address, usd("1")], {
        account: env.admin.account,
      }),
    );
    assert.equal(await env.token.read.totalSupply(), 0n);
    assert.equal(
      await env.controller.read.additionalMintLiabilities(),
      0n,
    );
  });

  it("atomically reclassifies a burned token liability as pending", async function () {
    const env = await networkHelpers.loadFixture(deployAtomicFixture);
    await submitValidSnapshot(env);

    const issued = usd("10000000");
    const redeemed = usd("4000000");
    await issueToHolder(env, issued);

    const supplyBefore =
      (await env.token.read.totalSupply()) as bigint;
    const tokenLiabilitiesBefore =
      (await env.controller.read.currentTokenLiabilities()) as bigint;
    const pendingBefore =
      (await env.controller.read.currentPendingRedemptions()) as bigint;
    const totalBefore =
      (await env.controller.read.currentTotalLiabilities()) as bigint;
    const liquidBefore =
      (await env.controller.read.currentLiquidAssets()) as bigint;

    await env.token.write.requestRedemption([redeemed], {
      account: env.holder.account,
    });

    assert.equal(await env.token.read.totalSupply(), supplyBefore - redeemed);
    assert.equal(
      await env.token.read.balanceOf([env.holder.account.address]),
      issued - redeemed,
    );
    assert.equal(
      await env.controller.read.currentTokenLiabilities(),
      tokenLiabilitiesBefore - redeemed,
    );
    assert.equal(
      await env.controller.read.currentPendingRedemptions(),
      pendingBefore + redeemed,
    );
    assert.equal(
      await env.controller.read.currentTotalLiabilities(),
      totalBefore,
    );
    assert.equal(
      await env.controller.read.currentLiquidAssets(),
      liquidBefore,
    );

    const redemption = (await env.controller.read.redemptions([1n])) as
      readonly [`0x${string}`, bigint, bigint, number, boolean];
    assert.equal(
      redemption[0].toLowerCase(),
      env.holder.account.address.toLowerCase(),
    );
    assert.equal(redemption[1], redeemed);
    assert.equal(redemption[2], 0n);
    assert.equal(redemption[4], false);
  });

  it("keeps the unpaid remainder pending through partial settlement", async function () {
    const env = await networkHelpers.loadFixture(deployAtomicFixture);
    await submitValidSnapshot(env);

    const redeemed = usd("4000000");
    const firstPayment = usd("1500000");
    await issueToHolder(env, usd("10000000"));
    await env.token.write.requestRedemption([redeemed], {
      account: env.holder.account,
    });

    const supplyBeforeSettlement =
      (await env.token.read.totalSupply()) as bigint;
    const tokenLiabilitiesBeforeSettlement =
      (await env.controller.read.currentTokenLiabilities()) as bigint;
    const totalBeforeSettlement =
      (await env.controller.read.currentTotalLiabilities()) as bigint;
    const liquidBeforeSettlement =
      (await env.controller.read.currentLiquidAssets()) as bigint;

    await env.controller.write.confirmSettlement([1n, firstPayment], {
      account: env.settlement.account,
    });

    assert.equal(
      await env.controller.read.currentPendingRedemptions(),
      redeemed - firstPayment,
    );
    assert.equal(
      await env.controller.read.currentLiquidAssets(),
      liquidBeforeSettlement - firstPayment,
    );
    assert.equal(
      await env.controller.read.currentTotalLiabilities(),
      totalBeforeSettlement - firstPayment,
    );
    assert.equal(
      await env.controller.read.currentTokenLiabilities(),
      tokenLiabilitiesBeforeSettlement,
    );
    assert.equal(
      await env.token.read.totalSupply(),
      supplyBeforeSettlement,
    );

    const redemption = (await env.controller.read.redemptions([1n])) as
      readonly [`0x${string}`, bigint, bigint, number, boolean];
    assert.equal(redemption[2], firstPayment);
    assert.equal(redemption[4], false);
  });

  it("removes the final pending liability only at full settlement", async function () {
    const env = await networkHelpers.loadFixture(deployAtomicFixture);
    await submitValidSnapshot(env);

    const redeemed = usd("4000000");
    const firstPayment = usd("1500000");
    const finalPayment = redeemed - firstPayment;
    await issueToHolder(env, usd("10000000"));
    await env.token.write.requestRedemption([redeemed], {
      account: env.holder.account,
    });
    await env.controller.write.confirmSettlement([1n, firstPayment], {
      account: env.settlement.account,
    });

    const liquidBeforeFinal =
      (await env.controller.read.currentLiquidAssets()) as bigint;
    const totalBeforeFinal =
      (await env.controller.read.currentTotalLiabilities()) as bigint;

    await env.controller.write.confirmSettlement([1n, finalPayment], {
      account: env.settlement.account,
    });

    assert.equal(
      await env.controller.read.currentPendingRedemptions(),
      0n,
    );
    assert.equal(
      await env.controller.read.currentLiquidAssets(),
      liquidBeforeFinal - finalPayment,
    );
    assert.equal(
      await env.controller.read.currentTotalLiabilities(),
      totalBeforeFinal - finalPayment,
    );

    const redemption = (await env.controller.read.redemptions([1n])) as
      readonly [`0x${string}`, bigint, bigint, number, boolean];
    assert.equal(redemption[2], redeemed);
    assert.equal(redemption[4], true);
  });

  it("rejects settlement by an unauthorized account", async function () {
    const env = await networkHelpers.loadFixture(deployAtomicFixture);
    await submitValidSnapshot(env);
    await issueToHolder(env, usd("10000000"));
    await env.token.write.requestRedemption([usd("4000000")], {
      account: env.holder.account,
    });

    const pendingBefore =
      (await env.controller.read.currentPendingRedemptions()) as bigint;
    const liquidBefore =
      (await env.controller.read.currentLiquidAssets()) as bigint;

    await assert.rejects(
      env.controller.write.confirmSettlement([1n, usd("1")], {
        account: env.admin.account,
      }),
    );

    assert.equal(
      await env.controller.read.currentPendingRedemptions(),
      pendingBefore,
    );
    assert.equal(
      await env.controller.read.currentLiquidAssets(),
      liquidBefore,
    );
  });

  it("rejects excessive and duplicate settlement", async function () {
    const env = await networkHelpers.loadFixture(deployAtomicFixture);
    await submitValidSnapshot(env);

    const redeemed = usd("4000000");
    await issueToHolder(env, usd("10000000"));
    await env.token.write.requestRedemption([redeemed], {
      account: env.holder.account,
    });

    await assert.rejects(
      env.controller.write.confirmSettlement([1n, redeemed + 1n], {
        account: env.settlement.account,
      }),
    );
    assert.equal(
      await env.controller.read.currentPendingRedemptions(),
      redeemed,
    );

    await env.controller.write.confirmSettlement([1n, redeemed], {
      account: env.settlement.account,
    });
    await assert.rejects(
      env.controller.write.confirmSettlement([1n, 1n], {
        account: env.settlement.account,
      }),
    );
    assert.equal(
      await env.controller.read.currentPendingRedemptions(),
      0n,
    );
  });

  it("rejects settlement that exceeds available liquid assets", async function () {
    const env = await networkHelpers.loadFixture(deployAtomicFixture);
    await submitValidSnapshot(env, {
      liquidAssets: usd("1000000"),
    });

    await issueToHolder(env, usd("5000000"));
    await env.token.write.requestRedemption([usd("4000000")], {
      account: env.holder.account,
    });

    await assert.rejects(
      env.controller.write.confirmSettlement([1n, usd("2000000")], {
        account: env.settlement.account,
      }),
    );

    assert.equal(
      await env.controller.read.currentPendingRedemptions(),
      usd("4000000"),
    );
    assert.equal(
      await env.controller.read.currentLiquidAssets(),
      usd("1000000"),
    );
  });

  it("rejects zero settlement and an unknown redemption", async function () {
    const env = await networkHelpers.loadFixture(deployAtomicFixture);
    await submitValidSnapshot(env);
    await issueToHolder(env, usd("5000000"));
    await env.token.write.requestRedemption([usd("4000000")], {
      account: env.holder.account,
    });

    await assert.rejects(
      env.controller.write.confirmSettlement([1n, 0n], {
        account: env.settlement.account,
      }),
    );
    await assert.rejects(
      env.controller.write.confirmSettlement([999n, usd("1")], {
        account: env.settlement.account,
      }),
    );

    assert.equal(
      await env.controller.read.currentPendingRedemptions(),
      usd("4000000"),
    );
  });

  it("rolls back the burn when the controller rejects redemption", async function () {
    const env = await networkHelpers.loadFixture(deployAtomicFixture);
    await submitValidSnapshot(env);

    const issued = usd("10000000");
    const redeemed = usd("4000000");
    await issueToHolder(env, issued);

    // Removing the token's controller permission makes the controller sub-call
    // fail after `_burn` is reached. EVM atomicity must restore the burn.
    await env.controller.write.revokeRole(
      [env.tokenRole, env.token.address],
      { account: env.admin.account },
    );

    const supplyBefore =
      (await env.token.read.totalSupply()) as bigint;
    const balanceBefore =
      (await env.token.read.balanceOf([
        env.holder.account.address,
      ])) as bigint;
    const tokenLiabilitiesBefore =
      (await env.controller.read.currentTokenLiabilities()) as bigint;
    const pendingBefore =
      (await env.controller.read.currentPendingRedemptions()) as bigint;

    await assert.rejects(
      env.token.write.requestRedemption([redeemed], {
        account: env.holder.account,
      }),
    );

    assert.equal(await env.token.read.totalSupply(), supplyBefore);
    assert.equal(
      await env.token.read.balanceOf([env.holder.account.address]),
      balanceBefore,
    );
    assert.equal(
      await env.controller.read.currentTokenLiabilities(),
      tokenLiabilitiesBefore,
    );
    assert.equal(
      await env.controller.read.currentPendingRedemptions(),
      pendingBefore,
    );
  });
});
