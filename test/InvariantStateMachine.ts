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

const { viem } = await hre.network.create();

const SEED = 42;
const TRANSITION_COUNT = 128;

type OpenRedemption = {
  id: bigint;
  requested: bigint;
  settled: bigint;
};

function seededRandom(seed: number) {
  let state = BigInt(seed);
  return () => {
    state = (1_664_525n * state + 1_013_904_223n) % 4_294_967_296n;
    return Number(state) / 4_294_967_296;
  };
}

function randomAmount(random: () => number, maximumWholeUsd: number) {
  const wholeUsd = 1 + Math.floor(random() * maximumWholeUsd);
  return usd(String(wholeUsd));
}

describe("Atomic RWA-PoB model-based invariants", function () {
  it("preserves accounting invariants across a seeded transition sequence", async function () {
    const wallets = await viem.getWalletClients();
    const [
      governance,
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
      governance.account.address,
    ]);

    const roleAssignments = [
      ["CUSTODIAN_ROLE", custodian.account.address],
      ["ADMINISTRATOR_ROLE", administrator.account.address],
      ["VALUATION_ROLE", valuation.account.address],
      ["LEGAL_ROLE", legal.account.address],
      ["VERIFIER_ROLE", verifier.account.address],
      ["TOKEN_ROLE", token.address],
      ["SETTLEMENT_ROLE", settlement.account.address],
    ] as const;

    for (const [roleName, address] of roleAssignments) {
      await controller.write.grantRole(
        [keccak256(toBytes(roleName)), address],
        { account: governance.account },
      );
    }
    await controller.write.revokeRole(
      [keccak256(toBytes("SETTLEMENT_ROLE")), governance.account.address],
      { account: governance.account },
    );

    const client = await viem.getPublicClient();
    const chainId = await client.getChainId();
    const block = await client.getBlock();
    const snapshot = makeSnapshot(block.timestamp);
    const signatures = await signSnapshot(
      [custodian, administrator, valuation, legal, verifier],
      chainId,
      controller.address,
      snapshot,
    );
    await controller.write.submitSnapshot([snapshot, signatures], {
      account: governance.account,
    });

    const initialTokenLiabilities = snapshot.tokenLiabilities;
    const initialLiquidAssets = snapshot.liquidAssets;
    const initialTotalLiabilities =
      snapshot.tokenLiabilities +
      snapshot.pendingRedemptions +
      snapshot.otherLiabilities;

    let modelSupply = 0n;
    let modelMinted = 0n;
    let modelTokenLiabilities = initialTokenLiabilities;
    let modelPending = snapshot.pendingRedemptions;
    let modelSettled = 0n;
    let modelLiquid = initialLiquidAssets;
    let nextRedemptionId = 1n;
    const redemptions: OpenRedemption[] = [];
    const random = seededRandom(SEED);
    let acceptedMintCount = 0;
    let rejectedMintCount = 0;
    let redemptionCount = 0;
    let settlementCount = 0;

    async function assertInvariants(step: number) {
      const chainSupply = (await token.read.totalSupply()) as bigint;
      const holderBalance = (await token.read.balanceOf([
        holder.account.address,
      ])) as bigint;
      const chainTokenLiabilities =
        (await controller.read.currentTokenLiabilities()) as bigint;
      const chainPending =
        (await controller.read.currentPendingRedemptions()) as bigint;
      const chainLiquid =
        (await controller.read.currentLiquidAssets()) as bigint;
      const chainTotal =
        (await controller.read.currentTotalLiabilities()) as bigint;
      const openRemainder = redemptions.reduce(
        (sum, redemption) =>
          sum + redemption.requested - redemption.settled,
        0n,
      );

      assert.equal(chainSupply, modelSupply, `step ${step}: model supply`);
      assert.equal(holderBalance, modelSupply, `step ${step}: holder balance`);
      assert.equal(
        chainTokenLiabilities,
        modelTokenLiabilities,
        `step ${step}: token liabilities`,
      );
      assert.equal(chainPending, modelPending, `step ${step}: pending`);
      assert.equal(chainLiquid, modelLiquid, `step ${step}: liquid assets`);
      assert.equal(
        chainTotal,
        modelTokenLiabilities + modelPending + snapshot.otherLiabilities,
        `step ${step}: liability composition`,
      );
      assert.equal(
        chainTotal,
        initialTotalLiabilities + modelMinted - modelSettled,
        `step ${step}: obligation conservation`,
      );
      assert.equal(
        chainTokenLiabilities - chainSupply,
        initialTokenLiabilities,
        `step ${step}: legacy-liability offset`,
      );
      assert.equal(
        chainPending,
        openRemainder,
        `step ${step}: redemption-record reconciliation`,
      );
      assert.equal(
        initialLiquidAssets - chainLiquid,
        modelSettled,
        `step ${step}: settlement/liquidity equality`,
      );
    }

    await assertInvariants(0);

    for (let step = 1; step <= TRANSITION_COUNT; step += 1) {
      const action = Math.floor(random() * 3);

      if (action === 0) {
        const amount =
          random() < 0.2
            ? randomAmount(random, 80_000_000)
            : randomAmount(random, 3_000_000);
        const canMint = (await controller.read.canMint([amount])) as boolean;

        if (canMint) {
          await token.write.issue([holder.account.address, amount], {
            account: governance.account,
          });
          modelSupply += amount;
          modelMinted += amount;
          modelTokenLiabilities += amount;
          acceptedMintCount += 1;
        } else {
          const supplyBefore = modelSupply;
          const liabilitiesBefore = modelTokenLiabilities;
          await assert.rejects(
            token.write.issue([holder.account.address, amount], {
              account: governance.account,
            }),
          );
          assert.equal(modelSupply, supplyBefore);
          assert.equal(modelTokenLiabilities, liabilitiesBefore);
          rejectedMintCount += 1;
        }
      } else if (action === 1 && modelSupply > 0n) {
        const candidate = randomAmount(random, 2_000_000);
        const amount = candidate < modelSupply ? candidate : modelSupply;

        await token.write.requestRedemption([amount], {
          account: holder.account,
        });
        modelSupply -= amount;
        modelTokenLiabilities -= amount;
        modelPending += amount;
        redemptions.push({
          id: nextRedemptionId,
          requested: amount,
          settled: 0n,
        });
        nextRedemptionId += 1n;
        redemptionCount += 1;
      } else {
        const open = redemptions.filter(
          (redemption) => redemption.settled < redemption.requested,
        );
        if (open.length > 0 && modelLiquid > 0n) {
          const redemption =
            open[Math.floor(random() * open.length)];
          const remaining = redemption.requested - redemption.settled;
          const candidate = randomAmount(random, 1_000_000);
          let amount = candidate < remaining ? candidate : remaining;
          if (amount > modelLiquid) amount = modelLiquid;

          await controller.write.confirmSettlement(
            [redemption.id, amount],
            { account: settlement.account },
          );
          redemption.settled += amount;
          modelPending -= amount;
          modelSettled += amount;
          modelLiquid -= amount;
          settlementCount += 1;
        }
      }

      await assertInvariants(step);
    }

    assert.ok(acceptedMintCount > 0, "sequence must accept at least one mint");
    assert.ok(rejectedMintCount > 0, "sequence must reject at least one mint");
    assert.ok(redemptionCount > 0, "sequence must process redemptions");
    assert.ok(settlementCount > 0, "sequence must process settlements");
  });
});
