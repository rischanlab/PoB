/**
 * Real position-level reserve snapshot: the 85 positions of the Franklin
 * OnChain U.S. Government Money Fund (FOBXX) as filed on Form N-MFP3 for
 * 30 September 2026 (83 securities, cash, other assets). The tree and
 * aggregates come from scripts/build-franklin-snapshot.mjs.
 *
 * The test (1) commits the real root on-chain and verifies every position,
 * (2) evaluates the mint policy on the real balance sheet at two BCR
 * thresholds, and (3) tampers with real positions and checks that a
 * permissionless challenge suspends minting.
 */
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { describe, it } from "node:test";
import hre from "hardhat";
import { StandardMerkleTree } from "@openzeppelin/merkle-tree";
import { keccak256, toBytes, type Hex } from "viem";

import { POLICY_HASH, WAD, makeSnapshot, signSnapshot, usd } from "./helpers.js";

const { viem } = await hre.network.create();

const DIR = "data/input/franklin-fobxx";
const TYPES = ["string", "string", "uint256", "uint256", "uint256", "uint256", "uint256", "uint256", "bool", "bool", "bool"];
type Leaf = [string, string, string, string, string, string, string, string, boolean, boolean, boolean];
const ROLES = ["CUSTODIAN_ROLE", "ADMINISTRATOR_ROLE", "VALUATION_ROLE", "LEGAL_ROLE", "VERIFIER_ROLE", "SETTLEMENT_ROLE", "TOKEN_ROLE"];
const REASONS = ["None", "EncumberedButEligible", "LegallyIneligibleButEligible", "UnsettledButEligible", "EligibleExceedsHaircutValue", "LiquidExceedsEligible"];

const toStruct = (p: Leaf) => ({
  positionId: p[0], instrumentId: p[1], faceValue: BigInt(p[2]), marketValue: BigInt(p[3]),
  eligibleValue: BigInt(p[4]), liquidValue: BigInt(p[5]), maturityDays: BigInt(p[6]),
  haircutBps: BigInt(p[7]), encumbered: p[8], legallyEligible: p[9], settlementFinal: p[10],
});
const pct = (wad: bigint) => (Number((wad * 1_000_000n) / WAD) / 10_000).toFixed(2);
const usdText = (v: bigint) => (Number(v / 10n ** 16n) / 100).toFixed(2);

const snapshotData = JSON.parse(await readFile(`${DIR}/snapshot.json`, "utf8"));
const tree = StandardMerkleTree.load<Leaf>(JSON.parse(await readFile(`${DIR}/tree.json`, "utf8")));
const leaves = [...tree.entries()].map(([, v]) => v);
const A = snapshotData.aggregates;

async function deploy(minBcr: bigint) {
  const wallets = await viem.getWalletClients();
  const [admin, custodian, administrator, valuation, legal, verifier, outsider] = wallets;
  const controller = (await viem.deployContract("PoBPolicyController", [POLICY_HASH, minBcr, WAD, 86_400n])) as any;
  const holders = [custodian, administrator, valuation, legal, verifier, admin, admin];
  for (const [i, role] of ROLES.entries()) {
    await controller.write.grantRole([keccak256(toBytes(role)), holders[i].account.address], { account: admin.account });
  }
  const client = await viem.getPublicClient();
  return {
    controller, client, admin, outsider,
    chainId: await client.getChainId(),
    now: (await client.getBlock()).timestamp,
    signers: [custodian, administrator, valuation, legal, verifier],
  };
}

// Aggregates as filed; the stress redemption queue (largest five-business-day
// gross redemptions in September 2026) is moved out of token liabilities, so
// total liabilities are unchanged.
function realSnapshot(now: bigint, root: Hex) {
  const pending = BigInt(A.stressPendingRedemptions);
  return makeSnapshot(now, {
    reserveRoot: root,
    grossReserves: BigInt(A.grossReserves),
    eligibleReserves: BigInt(A.eligibleReserves),
    liquidAssets: BigInt(A.liquidAssets),
    tokenLiabilities: BigInt(A.tokenLiabilities) - pending,
    pendingRedemptions: pending,
    otherLiabilities: BigInt(A.otherLiabilities),
  });
}

async function submit(env: Awaited<ReturnType<typeof deploy>>, root: Hex) {
  const snap = realSnapshot(env.now, root);
  const sigs = await signSnapshot(env.signers, env.chainId, env.controller.address, snap);
  const hash = await env.controller.write.submitSnapshot([snap, sigs], { account: env.admin.account });
  return (await env.client.waitForTransactionReceipt({ hash })).gasUsed as bigint;
}

const find = (id: string) => leaves.findIndex((l) => l[1] === id);

describe("Real position-level snapshot (FOBXX N-MFP3, 30 Sep 2026)", function () {
  const rows: Record<string, string>[] = [];
  const out: any = { reportDate: snapshotData.reportDate, merkleRoot: tree.root, positions: leaves.length };

  it("the committed tree matches the filing and every real position verifies on-chain", async function () {
    assert.equal(tree.root, snapshotData.merkleRoot);
    assert.equal(leaves.length, 85);
    const env = await deploy(WAD);
    const gas = await submit(env, tree.root as Hex);
    let maxProof = 0, minProof = Infinity;
    for (const [i, leaf] of tree.entries()) {
      const proof = tree.getProof(i);
      maxProof = Math.max(maxProof, proof.length); minProof = Math.min(minProof, proof.length);
      assert.equal(await env.controller.read.reservePositionLeaf([toStruct(leaf)]), tree.leafHash(leaf));
      assert.equal(await env.controller.read.verifyReservePosition([toStruct(leaf), proof]), true);
      assert.equal(Number(await env.controller.read.positionInconsistency([toStruct(leaf)])), 0);
    }
    Object.assign(out, { submitSnapshotGas: gas.toString(), proofLength: `${minProof}-${maxProof}`, verifiedPositions: leaves.length, inconsistentPositions: 0 });
  });

  it("evaluates the mint policy on the real balance sheet", async function () {
    for (const [label, minBcr] of [["100%", WAD], ["99.5%", (995n * WAD) / 1000n]] as const) {
      const env = await deploy(minBcr);
      await submit(env, tree.root as Hex);
      const bcr = await env.controller.read.currentBCR();
      const rlc = await env.controller.read.currentRLC();
      const eligible = await env.controller.read.currentEligibleReserves();
      const liabilities = await env.controller.read.currentTotalLiabilities();
      // Largest mint the policy allows without new cash: E / (L + m) >= minBCR.
      const headroom = (eligible * WAD) / minBcr > liabilities ? (eligible * WAD) / minBcr - liabilities : 0n;
      const oneMillion = usd("1000000");
      const row = {
        policy: `minBCR ${label}, minRLC 100%`,
        bcr: pct(bcr),
        rlc: pct(rlc),
        mint1mWithoutReceipt: String(await env.controller.read.canMint([oneMillion])),
        mint1mWithReceipt: String(await env.controller.read.canMintWithReceipt([oneMillion, oneMillion])),
        mintHeadroomUsd: usdText(headroom),
      };
      if (headroom > 0n) {
        assert.equal(await env.controller.read.canMint([headroom]), true);
        assert.equal(await env.controller.read.canMint([headroom + usd("1")]), false);
      } else {
        assert.equal(await env.controller.read.canMint([usd("1")]), false);
      }
      rows.push(row);
    }
    out.policy = rows.slice();
    assert.equal(rows[0].mint1mWithoutReceipt, "false"); // a 1:1 fund sits below 100% BCR at market value
    assert.equal(rows[1].mint1mWithoutReceipt, "true");
  });

  it("challenges against tampered real positions suspend minting", async function () {
    const challenges: Record<string, string>[] = [];
    const tamper = async (name: string, index: number, edit: (l: Leaf) => Leaf, expected: number | null) => {
      const tampered = leaves.map((l, i) => (i === index ? edit([...l] as Leaf) : l));
      const t = StandardMerkleTree.of(tampered, TYPES);
      const env = await deploy((995n * WAD) / 1000n);
      await submit(env, t.root as Hex);
      const leaf = tampered[index];
      const reason = Number(await env.controller.read.positionInconsistency([toStruct(leaf)]));
      let gas = "";
      if (expected === null) {
        assert.equal(reason, 0);
        await assert.rejects(
          env.controller.write.challengeReservePosition([toStruct(leaf), t.getProof(index)], { account: env.outsider.account }),
          /PositionIsConsistent/,
        );
      } else {
        assert.equal(reason, expected);
        const hash = await env.controller.write.challengeReservePosition([toStruct(leaf), t.getProof(index)], { account: env.outsider.account });
        gas = String((await env.client.waitForTransactionReceipt({ hash })).gasUsed);
        assert.equal(await env.controller.read.isSnapshotFresh(), false);
        assert.equal(await env.controller.read.canMint([usd("1")]), false);
      }
      challenges.push({ tamper: name, instrument: leaf[1], detected: String(expected !== null), reason: REASONS[reason], challengeGas: gas });
    };
    const repo = find("ZS48579");
    const longNote = leaves.reduce((b, l, i) => (Number(l[6]) > Number(leaves[b][6]) ? i : b), 0);
    const bill = find("912797VN4");
    const notWeekly = leaves.findIndex((l) => l[5] === "0" && l[4] !== "0");
    const other = find("OTHER-ASSETS");
    await tamper("repo pledged elsewhere but counted", repo, (l) => { l[8] = true; return l; }, 1);
    await tamper("receivables counted as eligible", other, (l) => { l[4] = l[3]; return l; }, 2);
    await tamper("unsettled bill counted", bill, (l) => { l[10] = false; return l; }, 3);
    await tamper("haircut skipped on longest note", longNote, (l) => { l[4] = l[3]; return l; }, 4);
    await tamper("liquid value above eligible", notWeekly, (l) => { l[5] = (BigInt(l[4]) + 1n).toString(); return l; }, 5);
    // Limitation: liquidity beyond the 7-day horizon is not a challenge rule.
    await tamper("non-weekly-liquid note reported liquid", notWeekly, (l) => { l[5] = l[4]; return l; }, null);

    // Controls on the untampered tree.
    const env = await deploy((995n * WAD) / 1000n);
    await submit(env, tree.root as Hex);
    await assert.rejects(
      env.controller.write.challengeReservePosition([toStruct(leaves[repo]), tree.getProof(repo)], { account: env.outsider.account }),
      /PositionIsConsistent/,
    );
    const forged = [...leaves[repo]] as Leaf; forged[8] = true;
    await assert.rejects(
      env.controller.write.challengeReservePosition([toStruct(forged), tree.getProof(repo)], { account: env.outsider.account }),
      /InvalidMerkleProof/,
    );
    out.challenges = challenges;

    const csv = (rs: Record<string, string>[]) => [Object.keys(rs[0]).join(","), ...rs.map((r) => Object.values(r).map((v) => (/[",]/.test(v) ? `"${v}"` : v)).join(","))].join("\n") + "\n";
    await writeFile("data/results/real-position-policy.csv", csv(out.policy));
    await writeFile("data/results/real-position-challenges.csv", csv(challenges));
    await writeFile("data/results/real-position-snapshot.json", JSON.stringify({ ...out, usd: snapshotData.usd, ratiosPercent: snapshotData.ratiosPercent, haircutSchedule: snapshotData.haircutSchedule }, null, 2) + "\n");
  });
});
