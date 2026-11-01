/**
 * Authenticated redemption price (review point P4).
 *
 * Each snapshot carries the token supply S and the redemption price P, and the
 * controller requires tokenLiabilities == ceil(S * P). Mints and redemptions are
 * passed in token units: a mint adds the rounded-up liability increase, a
 * redemption fixes a USD claim at the request-time price (rounded down), and
 * token liabilities follow each new price. An independent ledger (units, fixed
 * USD claims, reserves) is compared with the controller after every step.
 */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { describe, it } from "node:test";
import hre from "hardhat";
import { keccak256, toBytes } from "viem";

import { POLICY_HASH, WAD, liabilityOf, makeSnapshot, signSnapshot, signSubscriptionReceipt, usd } from "./helpers.js";

const { viem } = await hre.network.create();
const ROLE_NAMES = ["CUSTODIAN_ROLE", "ADMINISTRATOR_ROLE", "VALUATION_ROLE", "LEGAL_ROLE", "VERIFIER_ROLE", "SETTLEMENT_ROLE", "TOKEN_ROLE"];
const role = (n: string) => keccak256(toBytes(n));
const price = (s: string) => usd(s); // 18-decimal price per token

async function deploy(minBCR = (101n * WAD) / 100n) {
  const wallets = await viem.getWalletClients();
  const [admin, custodian, administrator, valuation, legal, verifier, holder] = wallets;
  const signers = [custodian, administrator, valuation, legal, verifier];
  const c = (await viem.deployContract("PoBPolicyController", [POLICY_HASH, minBCR, WAD, 86_400n])) as any;
  const holders = [custodian, administrator, valuation, legal, verifier, admin, admin];
  for (const [i, r] of ROLE_NAMES.entries()) await c.write.grantRole([role(r), holders[i].account.address], { account: admin.account });
  const client = await viem.getPublicClient();
  const chainId = await client.getChainId();
  return { c, admin, holder, signers, client, chainId, as: { account: admin.account } };
}
type Env = Awaited<ReturnType<typeof deploy>>;

async function submit(env: Env, epoch: bigint, s: { units: bigint; p: bigint; pending: bigint; gross: bigint; eligible: bigint; liquid: bigint; other?: bigint }, tokenLiabilitiesOverride?: bigint) {
  const now = (await env.client.getBlock()).timestamp;
  const snap = makeSnapshot(now, {
    epoch,
    grossReserves: s.gross, eligibleReserves: s.eligible, liquidAssets: s.liquid,
    tokenSupply: s.units, redemptionPrice: s.p,
    tokenLiabilities: tokenLiabilitiesOverride ?? liabilityOf(s.units, s.p),
    pendingRedemptions: s.pending, otherLiabilities: s.other ?? 0n,
  });
  return env.c.write.submitSnapshot([snap, await signSnapshot(env.signers, env.chainId, env.c.address, snap)], env.as);
}

const rows: string[] = [];

describe("Variable redemption price", function () {
  it("rejects a snapshot whose token liabilities are not supply x price, and a zero price", async function () {
    const env = await deploy();
    const base = { units: usd("1000"), p: price("1.05"), pending: 0n, gross: usd("1100"), eligible: usd("1100"), liquid: usd("100") };
    await assert.rejects(submit(env, 1n, base, usd("1000")), /InvalidSnapshotValues/); // stated at unit price
    await assert.rejects(submit(env, 1n, base, liabilityOf(base.units, base.p) - 1n), /InvalidSnapshotValues/); // rounded down
    await assert.rejects(submit(env, 1n, { ...base, p: 0n }, 0n), /InvalidSnapshotValues/);
    await submit(env, 1n, base);
    assert.equal(await env.c.read.currentTokenLiabilities(), usd("1050"));
    assert.equal(await env.c.read.tokenUnits(), usd("1000"));
  });

  it("converts mints and redemptions at the snapshot price and fixes claims at request time", async function () {
    const env = await deploy();
    const { c, as, holder } = env;
    // Ledger: units, fixed USD claims, reserves.
    const L = { units: usd("1000"), pending: 0n, gross: usd("1100"), eligible: usd("1090"), liquid: usd("200") };
    const claims = new Map<bigint, bigint>();
    let p = price("1.05");
    const check = async (label: string) => {
      const tokenUsd = liabilityOf(L.units, p);
      assert.equal(await c.read.tokenUnits(), L.units, `${label}: units`);
      assert.equal(await c.read.currentTokenLiabilities(), tokenUsd, `${label}: token USD`);
      assert.equal(await c.read.currentPendingRedemptions(), L.pending, `${label}: pending`);
      assert.equal(L.pending, [...claims.values()].reduce((a, b) => a + b, 0n), `${label}: claims`);
      assert.equal(await c.read.currentTotalLiabilities(), tokenUsd + L.pending, `${label}: total`);
      assert.equal(await c.read.currentEligibleReserves(), L.eligible, `${label}: eligible`);
      rows.push([label, (Number(p) / 1e18).toFixed(6), (Number(L.units) / 1e18).toFixed(6), (Number(tokenUsd) / 1e18).toFixed(6), (Number(L.pending) / 1e18).toFixed(6), (Number(await c.read.currentBCR()) / 1e16).toFixed(2)].join(","));
    };
    await submit(env, 1n, { ...L, p });
    await check("E1 price 1.05");

    // Mint 100 units at 1.05 with a receipt for 106.05 (105 + 1%): +105 USD liability.
    let sig = await signSubscriptionReceipt(env.signers[0], env.chainId, c.address, { epoch: 1n, amount: usd("106.05"), nonce: 1n });
    assert.equal(await c.read.mintLiabilityOf([usd("100")]), usd("105"));
    await c.write.authorizeMintWithReceipt([usd("100"), usd("106.05"), 1n, sig], as);
    L.units += usd("100"); L.gross += usd("106.05"); L.eligible += usd("106.05"); L.liquid += usd("106.05");
    await check("E1 mint 100 units");

    // Redeem 40 units at 1.05: a fixed claim of 42 USD.
    await c.write.requestRedemption([holder.account.address, usd("40")], as);
    const id1 = (await c.read.nextRedemptionId()) - 1n;
    assert.equal((await c.read.redemptions([id1]))[1], usd("42"));
    claims.set(id1, usd("42")); L.units -= usd("40"); L.pending += usd("42");
    await check("E1 redeem 40 units");

    // Price rises to 1.10. Token liabilities follow the price; the claim does not.
    p = price("1.10");
    L.gross += usd("70"); L.eligible += usd("70"); // reserves accrued too
    await submit(env, 2n, { ...L, p });
    await check("E2 price 1.10");
    assert.equal(await c.read.currentPendingRedemptions(), usd("42"), "claim fixed at request-time price");

    // A snapshot that restates the claim at the new price fails continuity.
    await assert.rejects(submit(env, 3n, { ...L, p, pending: usd("44") }), /LiabilityContinuityFailure/);
    // So does one that drops units.
    await assert.rejects(submit(env, 3n, { ...L, p, units: L.units - 1n }), /LiabilityContinuityFailure/);

    // Redeem 40 more units at 1.10: a fixed claim of 44 USD.
    await c.write.requestRedemption([holder.account.address, usd("40")], as);
    const id2 = (await c.read.nextRedemptionId()) - 1n;
    assert.equal((await c.read.redemptions([id2]))[1], usd("44"));
    claims.set(id2, usd("44")); L.units -= usd("40"); L.pending += usd("44");
    await check("E2 redeem 40 units");

    // Partial settlement of the first claim across the boundary.
    await c.write.confirmSettlement([id1, usd("30")], as);
    claims.set(id1, usd("12")); L.pending -= usd("30"); L.gross -= usd("30"); L.eligible -= usd("30"); L.liquid -= usd("30");
    await check("E2 settle 30 of claim 1");

    // Price falls to 1.08 (a loss). Liabilities fall with it; claims are unchanged.
    p = price("1.08");
    L.gross -= usd("15"); L.eligible -= usd("15");
    await submit(env, 3n, { ...L, p });
    await check("E3 price 1.08");

    // Mint at 1.08 without enough cash: rejected, nothing changes.
    sig = await signSubscriptionReceipt(env.signers[0], env.chainId, c.address, { epoch: 3n, amount: usd("1"), nonce: 2n });
    await assert.rejects(c.write.authorizeMintWithReceipt([usd("500"), usd("1"), 2n, sig], as), /MintPolicyFailed/);
    await check("E3 rejected mint");

    // Settle the rest; claims close at their fixed USD values.
    await c.write.confirmSettlement([id1, usd("12")], as);
    await c.write.confirmSettlement([id2, usd("44")], as);
    for (const [id, v] of [[id1, usd("12")], [id2, usd("44")]] as const) { claims.delete(id); L.pending -= v; L.gross -= v; L.eligible -= v; L.liquid -= v; }
    await check("E3 all claims settled");
    assert.equal((await c.read.redemptions([id1]))[4], true);
    assert.equal((await c.read.redemptions([id2]))[4], true);

    await mkdir("data/results", { recursive: true });
    await writeFile("data/results/variable-price-ledger.csv", "step,price,token_units,token_liabilities_usd,pending_usd,bcr_pct\n" + rows.join("\n") + "\n");
  });

  it("rounds conservatively at boundaries: liabilities up, claims down", async function () {
    const env = await deploy(WAD / 2n);
    const { c, as, holder } = env;
    const p = 1_000_000_000_000_000_001n; // 1 + 1e-18
    const base = { units: 3n, p, pending: 0n, gross: usd("10"), eligible: usd("10"), liquid: usd("5") };
    await submit(env, 1n, base);
    assert.equal(await c.read.currentTokenLiabilities(), 4n, "ceil(3 * (1+1e-18)) = 4 wei");
    assert.equal(await c.read.redemptionClaimOf([1n]), 1n, "floor(1 * (1+1e-18)) = 1 wei");
    assert.equal(await c.read.mintLiabilityOf([1n]), 1n, "ceil(4 units) - ceil(3 units) = 5 - 4");
    // Redeem 1 unit: claim 1 wei; token liabilities ceil(2 * p) = 3 wei; total 4 = never below exact 3.000...003.
    await c.write.requestRedemption([holder.account.address, 1n], as);
    assert.equal(await c.read.currentTokenLiabilities(), 3n);
    assert.equal(await c.read.currentPendingRedemptions(), 1n);
    assert.ok((await c.read.currentTotalLiabilities()) * WAD >= 3n * p, "recorded liabilities >= exact value");
    // A redemption whose claim rounds to zero is rejected.
    const tiny = { units: usd("1"), p: 1n, pending: 0n, gross: usd("10"), eligible: usd("10"), liquid: usd("5") };
    const env2 = await deploy(WAD / 2n);
    await submit(env2, 1n, tiny);
    await assert.rejects(env2.c.write.requestRedemption([holder.account.address, 1n], env2.as), /InvalidRedemptionAmount/);
    // Redeeming more units than outstanding is rejected.
    await assert.rejects(c.write.requestRedemption([holder.account.address, 3n], as), /InvalidRedemptionAmount/);
  });

  it("couples the token's unit supply to the controller at a non-unit price", async function () {
    const env = await deploy();
    const { c, as, holder, admin } = env;
    const token = (await viem.deployContract("RWABackedToken", [c.address, admin.account.address])) as any;
    await c.write.revokeRole([role("TOKEN_ROLE"), admin.account.address], as);
    await c.write.grantRole([role("TOKEN_ROLE"), token.address], as);
    await token.write.grantRole([role("ISSUER_ROLE"), admin.account.address], as);
    const p = price("1.0712");
    await submit(env, 1n, { units: 0n, p, pending: 0n, gross: usd("120"), eligible: usd("120"), liquid: usd("50") });
    await token.write.issue([holder.account.address, usd("100")], as);
    assert.equal(await token.read.totalSupply(), usd("100"));
    assert.equal(await c.read.tokenUnits(), usd("100"));
    assert.equal(await c.read.currentTokenLiabilities(), usd("107.12"));
    await token.write.requestRedemption([usd("25")], { account: holder.account });
    assert.equal(await token.read.totalSupply(), usd("75"));
    assert.equal(await c.read.tokenUnits(), usd("75"));
    assert.equal(await c.read.currentPendingRedemptions(), usd("26.78"));
    assert.equal(await c.read.currentTokenLiabilities(), usd("80.34"));
  });
});
