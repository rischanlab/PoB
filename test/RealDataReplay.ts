/**
 * Real-data longitudinal replay (v2 evaluation).
 *
 * Every policy decision in this experiment is produced by the deployed Solidity
 * controller, day by day, over the full observed USDY liability series.
 *
 * Real inputs
 *  - Liabilities: RWA.xyz "Bridged Token Value (Dollar)" for Ondo USDY,
 *    1,043 daily observations (18 Sep 2023 - 26 Jul 2026).
 *  - Reserve prices: U.S. Treasury Daily Treasury Bill Rates (bank-discount
 *    rates for 4- to 52-week bills), Aug 2023 - Jul 2026, public domain.
 *
 * Modelled (stated in the paper)
 *  - Reserve composition: a cash buffer plus a 26-week Treasury-bill ladder,
 *    priced every day from the real bill curve. USDY's actual holdings are not
 *    public at position level.
 *  - Accrual: the token's daily yield accrual is estimated from the series
 *    itself as the trailing 31-day median daily growth rate. Net subscription
 *    and redemption flows are the observed change minus that accrual,
 *    expressed as a fraction of the previous day's outstanding value and
 *    applied to the modelled token supply (so a rejected mint does not make
 *    later observed redemptions exceed the modelled supply).
 *
 * The v1 settlement bug is measured as a shadow metric inside the same run:
 * on every day the v1 BCR (snapshot eligible reserves, settlement not
 * deducted) is computed from the same on-chain state as the v2 BCR.
 *
 * Full run:  RWA_POB_REAL_REPLAY=1 npx hardhat test test/RealDataReplay.ts
 * Default (CI): a 70-day smoke run that checks the same invariants.
 */
import assert from "node:assert/strict";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { describe, it } from "node:test";
import hre from "hardhat";
import { keccak256, parseUnits, toBytes, type Hex } from "viem";

import { POLICY_HASH, WAD, liabilityOf, signFullSnapshot, signSnapshot, signSubscriptionReceipt } from "./helpers.js";

const { viem, networkHelpers } = await hre.network.create();

const FULL = process.env.RWA_POB_REAL_REPLAY === "1";
const DAY = 86_400n;
const RESERVE_ROOT = keccak256(toBytes("real-data replay reserve ladder"));

// ---------------------------------------------------------------- data ----

type Obs = { date: string; value: number; nav: number; navWad: bigint; supply: number };

/** Observed token value, issuer NAV, and supply = value / NAV (RWA.xyz). */
async function loadLiabilities(): Promise<Obs[]> {
  const text = await readFile("data/input/usdy-observed-supply.csv", "utf8");
  const [header, ...lines] = text.trim().split("\n");
  const cols = header.split(",");
  const iDate = cols.indexOf("date");
  const iVal = cols.indexOf("observed_token_value_usd");
  const iNav = cols.indexOf("nav_usd");
  const iSup = cols.indexOf("observed_token_supply");
  return lines.map((line) => {
    const c = line.split(",");
    return { date: c[iDate], value: Number(c[iVal]), nav: Number(c[iNav]), navWad: parseUnits(c[iNav], 18), supply: Number(c[iSup]) };
  });
}

const TENORS: Array<[string, number]> = [
  ["4 WEEKS", 28],
  ["6 WEEKS", 42],
  ["8 WEEKS", 56],
  ["13 WEEKS", 91],
  ["17 WEEKS", 119],
  ["26 WEEKS", 182],
  ["52 WEEKS", 364],
];

type Curve = Array<[number, number]>; // [days, bank-discount rate as fraction]

function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (const ch of line) {
    if (ch === '"') quoted = !quoted;
    else if (ch === "," && !quoted) {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

async function loadBillCurves(): Promise<Map<string, Curve>> {
  const dir = "data/raw/treasury";
  const curves = new Map<string, Curve>();
  for (const file of (await readdir(dir)).filter((f) => f.endsWith(".csv"))) {
    const [header, ...lines] = (await readFile(`${dir}/${file}`, "utf8"))
      .trim()
      .split("\n");
    const cols = parseCsvLine(header);
    for (const line of lines) {
      const c = parseCsvLine(line);
      const [m, d, y] = c[0].split("/");
      const iso = `${y}-${m}-${d}`;
      const curve: Curve = [];
      for (const [tenor, days] of TENORS) {
        const idx = cols.indexOf(`${tenor} BANK DISCOUNT`);
        if (idx >= 0 && c[idx] !== "" && c[idx] !== "N/A") {
          curve.push([days, Number(c[idx]) / 100]);
        }
      }
      curves.set(iso, curve);
    }
  }
  return curves;
}

function curveForDate(curves: Map<string, Curve>, iso: string): Curve {
  // Forward-fill weekends and holidays from the latest prior business day.
  let d = new Date(`${iso}T00:00:00Z`);
  for (let k = 0; k < 10; k++) {
    const key = d.toISOString().slice(0, 10);
    const c = curves.get(key);
    if (c) return c;
    d = new Date(d.getTime() - 86_400_000);
  }
  throw new Error(`No Treasury bill curve within 10 days before ${iso}`);
}

function discountRate(curve: Curve, days: number): number {
  if (days <= curve[0][0]) return curve[0][1];
  for (let k = 1; k < curve.length; k++) {
    const [d1, r1] = curve[k];
    const [d0, r0] = curve[k - 1];
    if (days <= d1) return r0 + ((r1 - r0) * (days - d0)) / (d1 - d0);
  }
  return curve[curve.length - 1][1];
}

function billPrice(curve: Curve, days: number): number {
  if (days <= 0) return 1;
  return 1 - (discountRate(curve, days) * days) / 360;
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Observed change minus estimated accrual = net subscription/redemption. */
function deriveFlows(obs: Obs[], cleaned: boolean, accrualWindow = 31) {
  const growth = obs.map((o, i) => (i === 0 ? 0 : o.value / obs[i - 1].value - 1));
  const accrual = obs.map((_, i) => {
    if (i === 0) return 0;
    const window = growth.slice(Math.max(1, i - (accrualWindow - 1)), i + 1);
    return median(window);
  });
  const flow = obs.map((o, i) =>
    i === 0 ? 0 : o.value - obs[i - 1].value * (1 + accrual[i]),
  );
  // Flows smaller than 0.001% of outstanding value are indistinguishable from
  // accrual-estimation noise and are treated as zero.
  for (let i = 1; i < obs.length; i++) {
    if (Math.abs(flow[i]) < 1e-5 * obs[i - 1].value) flow[i] = 0;
  }
  let netted = 0;
  if (cleaned) {
    // Net out one-day round trips (a jump of more than 5% of the series
    // reversed the next day within 2%), which look like bridge or
    // double-counting artefacts in the aggregate series.
    for (let i = 1; i + 1 < obs.length; i++) {
      const a = flow[i];
      const b = flow[i + 1];
      if (
        Math.abs(a) > 0.05 * obs[i - 1].value &&
        Math.sign(a) !== Math.sign(b) &&
        Math.abs(a + b) <= 0.02 * Math.abs(a)
      ) {
        flow[i] = 0;
        flow[i + 1] = 0;
        netted += 1;
        i += 1;
      }
    }
  }
  return { accrual, flow, netted };
}

/**
 * Alternative inference that does not use the series itself for accrual:
 * daily accrual = (4-week bill bank-discount rate - 0.50%/yr fee) / 365.
 * The fee is an assumption, not USDY's disclosed fee.
 */
function deriveFlowsTbill(obs: Obs[], curves: Map<string, Curve>, cleaned: boolean) {
  const accrual = obs.map((o, i) =>
    i === 0 ? 0 : Math.max(0, discountRate(curveForDate(curves, o.date), 28) - 0.005) / 365,
  );
  const flow = obs.map((o, i) => (i === 0 ? 0 : o.value - obs[i - 1].value * (1 + accrual[i])));
  for (let i = 1; i < obs.length; i++) {
    if (Math.abs(flow[i]) < 1e-5 * obs[i - 1].value) flow[i] = 0;
  }
  void cleaned;
  return { accrual, flow, netted: 0 };
}

/**
 * Observed net supply change (review P1): supply = value / NAV is observed,
 * so the daily net flow needs no accrual estimate. Returned as a fraction of
 * the previous day's supply; changes under one token are float noise.
 * The cleaned variant nets one-day round trips as in deriveFlows.
 */
function deriveSupplyFlows(obs: Obs[], cleaned: boolean) {
  const flow = obs.map((o, i) => (i === 0 ? 0 : o.supply - obs[i - 1].supply));
  for (let i = 1; i < obs.length; i++) if (Math.abs(flow[i]) <= 1) flow[i] = 0;
  let netted = 0;
  if (cleaned) {
    for (let i = 1; i + 1 < obs.length; i++) {
      const a = flow[i];
      const b = flow[i + 1];
      if (Math.abs(a) > 0.05 * obs[i - 1].supply && Math.sign(a) !== Math.sign(b) && Math.abs(a + b) <= 0.02 * Math.abs(a)) {
        flow[i] = 0;
        flow[i + 1] = 0;
        netted += 1;
        i += 1;
      }
    }
  }
  return { frac: obs.map((o, i) => (i === 0 ? 0 : flow[i] / obs[i - 1].supply)), netted };
}

// --------------------------------------------------------------- model ----

type Config = {
  name: string;
  bufferBps: number; // target gross over-collateralisation
  thetaS: number; // minimum BCR
  thetaL: number; // minimum RLC
  cashTargetBps: number;
  liquidHorizonDays: number;
  settlementDelayDays: number;
  queueExtraDays: number;
  snapshotEveryDays: number;
  encumberedBps: number; // share of bill holdings pledged (overlay)
  rateShockBps: number; // valuation haircut = price loss under this shock
  cleaned: boolean;
  ladderDays: number; // equal-weight bill ladder 1..ladderDays; reinvest at ladderDays
  etfShareBps: number; // short-Treasury ETF sleeve (share of gross), sold T+1
  etfDurationDays: number; // ETF price sensitivity used for its haircut
  // Ablation and robustness (review points 3, 5, 8)
  attestation: "role-scoped" | "single"; // single = SingleAttestorController
  mintRule: "receipt" | "no-receipt"; // no-receipt: cash counted only at the next snapshot
  liquidityPolicy: boolean; // false: no RLC gate (minimum RLC set to 1 wei)
  persistent: boolean; // one controller for the whole run (unit price, no liability accrual)
  accrualWindow: number; // trailing window (days) for the accrual median
  accrualSource: "series" | "tbill"; // tbill: accrual = 4-week bill rate minus 0.50%/yr
  // "inferred": value change minus estimated accrual, unit price.
  // "supply": observed supply change; liabilities = units x issuer NAV, and the
  // snapshot carries NAV as the authenticated redemption price (v2.2). Requires
  // a persistent controller.
  flowSource: "inferred" | "supply";
  // Price-risk policy (v2.2): mint checks value tokens at the attested price
  // grown at this annual rate since the snapshot (basis points; 0 = off).
  priceAccrualBps: number;
};

const BASE: Config = {
  name: "baseline",
  bufferBps: 300,
  thetaS: 1.01,
  thetaL: 1.0,
  cashTargetBps: 200,
  liquidHorizonDays: 7,
  settlementDelayDays: 1,
  queueExtraDays: 2,
  snapshotEveryDays: 7,
  encumberedBps: 0,
  rateShockBps: 100,
  cleaned: false,
  ladderDays: 182,
  etfShareBps: 0,
  etfDurationDays: 146,
  attestation: "role-scoped",
  mintRule: "receipt",
  liquidityPolicy: true,
  persistent: false,
  accrualWindow: 31,
  accrualSource: "series",
  flowSource: "inferred",
  priceAccrualBps: 0,
};

/**
 * Composition published by Ondo for USDY (ondo.finance/usdy, as of
 * 29 Oct 2026): 86.12% U.S. Treasuries, 13.86% tokenized iShares 0-1 Year
 * Treasury Bond ETF (SHVon), <0.01% bank deposits and cash; portfolio WAM
 * 177.18 days. Modelled as a 1..364-day ladder (WAM about 182 days), a 14%
 * ETF sleeve, and no cash target.
 */
const ONDO_MIX: Partial<Config> = {
  cashTargetBps: 0,
  ladderDays: 364,
  etfShareBps: 1400,
};

const SUPPLY_BASE: Config = { ...BASE, name: "supply-baseline", flowSource: "supply", persistent: true };
const SUPPLY_CONFIGS: Config[] = [
  { ...SUPPLY_BASE },
  ...[100, 200, 300, 400].map((b) => ({ ...SUPPLY_BASE, name: `supply-encumbered-${b / 100}pct`, encumberedBps: b })),
  { ...SUPPLY_BASE, name: "supply-buffer-1.5pct", bufferBps: 150 },
  { ...SUPPLY_BASE, name: "supply-snapshot-daily", snapshotEveryDays: 1 },
  { ...SUPPLY_BASE, name: "supply-cleaned-series", cleaned: true },
  { ...SUPPLY_BASE, ...ONDO_MIX, name: "supply-ondo-mix" },
  { ...SUPPLY_BASE, name: "supply-ablation-A1-bcr-only", attestation: "single", mintRule: "no-receipt", liquidityPolicy: false },
  { ...SUPPLY_BASE, name: "supply-ablation-A2-bcr-rlc", attestation: "single", mintRule: "no-receipt" },
  { ...SUPPLY_BASE, name: "supply-ablation-A3-bcr-rlc-receipts", attestation: "single" },
  { ...SUPPLY_BASE, name: "supply-ablation-A1-encumbered-4pct", attestation: "single", mintRule: "no-receipt", liquidityPolicy: false, encumberedBps: 400 },
  // Price-risk policy: 8%/yr is set a priori above every 13-week bill rate in
  // the window (3.52-5.36%); 5%/yr is a deliberately tight sensitivity.
  { ...SUPPLY_BASE, name: "supply-baseline-pricerisk-8pct", priceAccrualBps: 800 },
  { ...SUPPLY_BASE, name: "supply-buffer-1.5pct-pricerisk-8pct", bufferBps: 150, priceAccrualBps: 800 },
  { ...SUPPLY_BASE, name: "supply-ablation-A1-pricerisk-8pct", attestation: "single", mintRule: "no-receipt", liquidityPolicy: false, priceAccrualBps: 800 },
  { ...SUPPLY_BASE, name: "supply-buffer-1.5pct-pricerisk-5pct", bufferBps: 150, priceAccrualBps: 500 },
];

const toWad = (usdValue: number) =>
  BigInt(Math.round(Math.max(0, usdValue) * 1e6)) * 10n ** 12n;
const fromWad = (w: bigint) => Number(w / 10n ** 12n) / 1e6;
const pct2 = (ratio: number) => (Math.round(ratio * 10_000) / 100).toFixed(2);

type Claim = { amount: number; due: number; id?: bigint; requestedDay: number };

async function runReplay(cfg: Config, obs: Obs[], curves: Map<string, Curve>) {
  const wallets = await viem.getWalletClients();
  const [admin, custodian, administrator, valuation, legal, verifier, , holder] =
    wallets;
  const signers = [custodian, administrator, valuation, legal, verifier];
  const client = await viem.getPublicClient();
  const chainId = await client.getChainId();

  const SUPPLY = cfg.flowSource === "supply";
  if (SUPPLY) assert.ok(cfg.persistent, "supply mode runs on a persistent controller");
  const inferred =
    cfg.accrualSource === "tbill"
      ? deriveFlowsTbill(obs, curves, cfg.cleaned)
      : deriveFlows(obs, cfg.cleaned, cfg.accrualWindow);
  const supplyFlows = deriveSupplyFlows(obs, cfg.cleaned);
  const { flow, accrual } = inferred;
  const netted = SUPPLY ? supplyFlows.netted : inferred.netted;
  const horizon = FULL ? obs.length : Math.min(70, obs.length);

  // Initial portfolio: cash target + ETF sleeve + equal-weight bill ladder.
  const L0 = obs[0].value;
  let tokens = L0; // token liabilities in USD
  let units = SUPPLY ? obs[0].supply : L0; // token units (supply mode)
  let snapPrice = 1; // redemption price in the latest snapshot
  let cash = (cfg.cashTargetBps / 10_000) * L0;
  let etf = (cfg.etfShareBps / 10_000) * L0 * (1 + cfg.bufferBps / 10_000);
  const etfHaircut = ((cfg.rateShockBps / 10_000) * cfg.etfDurationDays) / 360;
  const bills = new Map<number, number>(); // maturity day index -> face
  {
    const curve = curveForDate(curves, obs[0].date);
    const invest = L0 * (1 + cfg.bufferBps / 10_000) - cash - etf;
    for (let k = 1; k <= cfg.ladderDays; k++) {
      bills.set(k, invest / cfg.ladderDays / billPrice(curve, k));
    }
  }

  const claims: Claim[] = [];
  let controller: any;
  let snapshotEligible = 0;
  let snapshotEpoch = 0n;
  const gas: Record<string, bigint[]> = {
    submitSnapshot: [],
    authorizeMintWithReceipt: [],
    requestRedemption: [],
    confirmSettlement: [],
  };
  const m = {
    subscriptionDays: 0,
    subscriptionUsd: 0,
    porAccepted: 0,
    pobAccepted: 0,
    pobRejected: 0,
    pobRejectedUsd: 0,
    porAcceptPobReject: 0,
    redemptionRequests: 0,
    redemptionUsd: 0,
    instant: 0,
    queued: 0,
    queuedUsd: 0,
    settlementDaysDeferred: 0,
    billSalesForSettlementUsd: 0,
    unsafeMints: 0,
    unsafeMintUsd: 0,
    maxBcrOverstatementPp: 0,
    v1WouldAcceptV2Rejects: 0,
    rejectedBcr: 0,
    rejectedRlc: 0,
    issuerTopUpUsd: 0,
    v1UnsafeMints: 0,
    v1UnsafeMintUsd: 0,
    snapshots: 0,
    sweptUsd: 0,
    minBcr: Infinity,
    maxBcr: 0,
    bcrBelowThresholdDays: 0,
    minRlc: Infinity,
    daysWithPending: 0,
    onchainLiquidAboveActualDays: 0,
    onchainEligibleAboveActualDays: 0,
    rlcBelowThresholdDays: 0,
    maxQueueAgeDays: 0,
    redemptionsCapped: 0,
    liabilityConservationViolations: 0,
    priceLagUnsafeMints: 0,
    maxPriceLagBcrPp: 0,
    rejectedPriceRisk: 0,
    minMintBcrAttested: Infinity,
    minMintBcrAtNav: Infinity,
  };
  const daily: string[] = [];

  const liquidAndValues = (day: number) => {
    const curve = curveForDate(curves, obs[day].date);
    let mv = 0;
    let eligibleMv = 0;
    let liquidMv = 0;
    for (const [maturity, face] of bills) {
      const tau = maturity - day;
      const p = billPrice(curve, tau);
      const value = face * p;
      mv += value;
      // Valuation haircut: price loss of a bill with tau days left under a
      // parallel +rateShockBps move in the discount rate.
      const haircut = ((cfg.rateShockBps / 10_000) * tau) / 360 / p;
      eligibleMv += value * (1 - haircut);
      if (tau <= cfg.liquidHorizonDays) liquidMv += value;
    }
    const enc = cfg.encumberedBps / 10_000;
    // The ETF sleeve is sellable T+1, so it counts as liquid after haircut.
    const etfEligible = etf * (1 - etfHaircut);
    const gross = cash + mv + etf;
    const eligible = cash + eligibleMv * (1 - enc) + etfEligible;
    const liquid = Math.min(cash + liquidMv * (1 - enc) + etfEligible, eligible);
    return { gross, eligible, liquid, curve };
  };

  for (let day = 0; day < horizon; day++) {
    // (a) maturities and accrual
    if (day > 0) {
      const face = bills.get(day);
      if (face) {
        cash += face;
        bills.delete(day);
      }
      // Unit redemption price: in the persistent run the token liability
      // does not accrue (the contract has no redemption-price update), so
      // the reserve yield stays with the issuer and is swept.
      if (SUPPLY) tokens = units * obs[day].nav; // liabilities follow the issuer NAV
      else if (!cfg.persistent) tokens *= 1 + accrual[day];
      // ETF sleeve accrues at the 4-week bill rate (money-market-like).
      etf *= 1 + discountRate(curveForDate(curves, obs[day].date), 28) / 360;
      for (const c of claims) void c; // pending claims do not accrue
    }
    const pendingTotal = () => claims.reduce((s, c) => s + c.amount, 0);

    // (b) on snapshot days only: reinvest cash above target into new 26-week
    //     bills and sweep excess over-collateralisation to the issuer. Between
    //     snapshots the portfolio is not rebalanced, so cash credited on-chain
    //     (receipts) or attested as liquid stays liquid until re-attested.
    if (day % cfg.snapshotEveryDays === 0) {
      const { gross, curve } = liquidAndValues(day);
      const liabilities = tokens + pendingTotal();
      const excess = gross - liabilities * (1 + cfg.bufferBps / 10_000);
      const cashFloor = (cfg.cashTargetBps / 10_000) * liabilities + pendingTotal();
      if (excess > 0) {
        const sweep = Math.min(excess, Math.max(0, cash - cashFloor));
        cash -= sweep;
        m.sweptUsd += sweep;
      }
      if (cfg.etfShareBps > 0) {
        // Top the ETF sleeve back up to its target share from spare cash.
        const target = (cfg.etfShareBps / 10_000) * (gross - Math.max(0, excess));
        const buy = Math.min(Math.max(0, target - etf), Math.max(0, cash - cashFloor));
        etf += buy;
        cash -= buy;
      }
      const reinvest = cash - cashFloor;
      if (reinvest > 0) {
        const maturity = day + cfg.ladderDays;
        bills.set(
          maturity,
          (bills.get(maturity) ?? 0) + reinvest / billPrice(curve, cfg.ladderDays),
        );
        cash -= reinvest;
      }
    }

    // (c) signed snapshot at the configured cadence. Default: fresh
    //     deployment per interval, carried pending claims re-registered
    //     on-chain. Persistent: one deployment; the new snapshot must pass
    //     the liability-continuity check against the controller's state.
    const reuse = cfg.persistent && controller !== undefined;
    if (day % cfg.snapshotEveryDays === 0 && !reuse) {
      const maxAge = BigInt(cfg.snapshotEveryDays + 1) * DAY;
      const args = [
        POLICY_HASH,
        BigInt(Math.round(cfg.thetaS * 1e6)) * 10n ** 12n,
        BigInt(Math.round(cfg.thetaL * 1e6)) * 10n ** 12n,
        maxAge,
      ] as const;
      // Ablation variants use AblationController (identical accounting).
      controller =
        cfg.attestation === "single" || !cfg.liquidityPolicy
          ? await viem.deployContract("AblationController", [...args, cfg.attestation === "single", cfg.liquidityPolicy])
          : await viem.deployContract("PoBPolicyController", [...args]);
      const roles = [
        ["CUSTODIAN_ROLE", custodian],
        ["ADMINISTRATOR_ROLE", administrator],
        ["VALUATION_ROLE", valuation],
        ["LEGAL_ROLE", legal],
        ["VERIFIER_ROLE", verifier],
        ["SETTLEMENT_ROLE", admin],
        ["TOKEN_ROLE", admin],
      ] as const;
      for (const [role, w] of roles) {
        await controller.write.grantRole([keccak256(toBytes(role)), w.account.address], {
          account: admin.account,
        });
      }
      if (cfg.priceAccrualBps > 0) {
        await controller.write.setPriceRiskPolicy([BigInt(cfg.priceAccrualBps) * 10n ** 14n], { account: admin.account });
      }
    }
    if (day % cfg.snapshotEveryDays === 0) {
      const maxAge = BigInt(cfg.snapshotEveryDays + 1) * DAY;
      const { gross, eligible, liquid } = liquidAndValues(day);
      const carried = pendingTotal();
      const now = (await client.getBlock()).timestamp;
      const priceWad = SUPPLY ? obs[day].navWad : WAD;
      const supplyWad: bigint = SUPPLY ? (reuse ? await controller.read.tokenUnits() : toWad(units)) : 0n;
      const snapshot = {
        epoch: BigInt(day + 1),
        asOfTimestamp: now,
        validUntil: now + maxAge,
        reserveRoot: RESERVE_ROOT as Hex,
        policyHash: POLICY_HASH,
        grossReserves: toWad(gross),
        eligibleReserves: toWad(eligible),
        liquidAssets: toWad(liquid),
        tokenLiabilities: reuse
          ? await controller.read.currentTokenLiabilities()
          : toWad(tokens) + claims.reduce((s, c) => s + toWad(c.amount), 0n),
        pendingRedemptions: reuse ? await controller.read.currentPendingRedemptions() : 0n,
        otherLiabilities: 0n,
        tokenSupply: 0n,
        redemptionPrice: WAD,
      };
      snapshot.tokenSupply = snapshot.tokenLiabilities;
      if (SUPPLY) {
        snapshot.tokenSupply = supplyWad;
        snapshot.redemptionPrice = priceWad;
        snapshot.tokenLiabilities = liabilityOf(supplyWad, priceWad);
        units = fromWad(supplyWad); // stay on the on-chain unit ledger
        tokens = units * obs[day].nav;
        snapPrice = obs[day].nav;
      } else if (reuse) tokens = fromWad(snapshot.tokenLiabilities); // stay on the on-chain ledger
      const signatures =
        cfg.attestation === "single"
          ? await signFullSnapshot(verifier, chainId, controller.address, snapshot)
          : await signSnapshot(signers, chainId, controller.address, snapshot);
      const hash = await controller.write.submitSnapshot([snapshot, signatures], {
        account: admin.account,
      });
      gas.submitSnapshot.push((await client.getTransactionReceipt({ hash })).gasUsed);
      snapshotEligible = fromWad(snapshot.eligibleReserves);
      snapshotEpoch = snapshot.epoch;
      m.snapshots += 1;
      void carried;
      if (!reuse) {
        for (const c of claims) {
          await controller.write.requestRedemption([holder.account.address, toWad(c.amount)], {
            account: admin.account,
          });
          c.id = (await controller.read.nextRedemptionId()) - 1n;
        }
      }
    }

    // (d) settle due claims (T+delay; queued claims later), constrained by the
    //     liquid assets the snapshot attested.
    for (const c of [...claims]) {
      if (c.due > day) continue;
      const available = fromWad(await controller.read.currentLiquidAssets());
      const pay = Math.min(c.amount, available);
      if (pay <= 0.01) {
        c.due = day + 1;
        m.settlementDaysDeferred += 1;
        continue;
      }
      if (cash < pay && etf > 0) {
        // Sell the ETF sleeve first (T+1 settlement).
        const sell = Math.min(etf, pay - cash);
        etf -= sell;
        cash += sell;
        m.billSalesForSettlementUsd += sell;
      }
      if (cash < pay) {
        // Raise cash by selling the shortest bills at today's market price.
        const { curve } = liquidAndValues(day);
        for (const maturity of [...bills.keys()].sort((a, b) => a - b)) {
          if (cash >= pay) break;
          const face = bills.get(maturity)!;
          const p = billPrice(curve, maturity - day);
          // Sell the shortest bills first (in practice bills inside the
        // liquidity horizon, which the snapshot already counted as liquid).
        const sellFace = Math.min(face, (pay - cash) / p);
          bills.set(maturity, face - sellFace);
          if (face - sellFace <= 1e-6) bills.delete(maturity);
          cash += sellFace * p;
          m.billSalesForSettlementUsd += sellFace * p;
        }
      }
      const rec = await controller.read.redemptions([c.id]);
      const remainingWad: bigint = rec[1] - rec[2];
      const amountWad = toWad(pay) < remainingWad ? toWad(pay) : remainingWad;
      const hash = await controller.write.confirmSettlement([c.id, amountWad], {
        account: admin.account,
      });
      gas.confirmSettlement.push((await client.getTransactionReceipt({ hash })).gasUsed);
      cash -= pay;
      c.amount -= pay;
      m.maxQueueAgeDays = Math.max(m.maxQueueAgeDays, day - c.requestedDay);
      if (c.amount <= 0.01) claims.splice(claims.indexOf(c), 1);
      else {
        c.due = day + 1;
        m.settlementDaysDeferred += 1;
      }
    }

    // (e) the day's real net flow
    // Observed net flow as a fraction of the previous outstanding value,
    // applied to the modelled supply.
    // Supply mode: observed net supply change (fraction of yesterday's supply)
    // applied to the modelled units, valued at today's NAV.
    const fu = SUPPLY ? (day === 0 ? 0 : supplyFlows.frac[day] * units) : 0;
    const f = SUPPLY ? fu * obs[day].nav : day === 0 ? 0 : (flow[day] / obs[day - 1].value) * tokens;
    if (f > 0) {
      m.subscriptionDays += 1;
      m.subscriptionUsd += f;
      const { gross } = liquidAndValues(day);
      // AggregatePoRBaseline rule (gross >= liabilities after mint), given the
      // same incoming cash, for a like-for-like comparison.
      const porOk =
        gross + f * (1 + cfg.bufferBps / 10_000) >= tokens + pendingTotal() + f;
      if (porOk) m.porAccepted += 1;
      const amount = SUPPLY ? toWad(fu) : toWad(f);
      // v1 shadow: same on-chain state, settlement cash not deducted.
      const credited = fromWad(await controller.read.creditedSubscriptionCash());
      const consumed = fromWad(await controller.read.liquidAssetsConsumed());
      const liabNow = fromWad(await controller.read.currentTotalLiabilities());
      // Operating policy: the issuer posts the buffer on new subscriptions
      // (top-up from issuer capital, later released by the sweep), so the
      // custodian receipt covers subscription cash plus top-up.
      const topUp = (cfg.bufferBps / 10_000) * f;
      const received = toWad(f + topUp);
      const mintLiab = SUPPLY ? fromWad(await controller.read.mintLiabilityOf([amount])) : f;
      const v1After = (snapshotEligible + credited + f + topUp) / (liabNow + mintLiab);
      const trueAfter = (snapshotEligible + credited - consumed + f + topUp) / (liabNow + mintLiab);
      const ok: boolean =
        cfg.mintRule === "receipt"
          ? await controller.read.canMintWithReceipt([amount, received])
          : await controller.read.canMint([amount]);
      if (!ok) {
        const bcrNow = Number(((await controller.read.currentBCR()) * 1_000_000n) / WAD) / 1e6;
        const rlcNow = await controller.read.currentRLC();
        const bcrAfter =
          cfg.mintRule === "receipt"
            ? trueAfter
            : Number(((await controller.read.bcrAfterMint([amount])) * 1_000_000n) / WAD) / 1e6;
        if (bcrAfter < cfg.thetaS) m.rejectedBcr += 1;
        else if (cfg.priceAccrualBps > 0) {
          // BCR at the attested price passes; the stressed-price check fails.
          const stressedLiab = fromWad(await controller.read.mintCheckLiabilities([amount]));
          const stressedAfter =
            cfg.mintRule === "receipt"
              ? (snapshotEligible + credited - consumed + f + topUp) / stressedLiab
              : fromWad(await controller.read.currentEligibleReserves()) / stressedLiab;
          if (stressedAfter < cfg.thetaS) m.rejectedPriceRisk += 1;
        }
        if (cfg.liquidityPolicy && rlcNow < BigInt(Math.round(cfg.thetaL * 1e6)) * 10n ** 12n) m.rejectedRlc += 1;
        void bcrNow;
      }
      if (v1After >= cfg.thetaS && !ok) m.v1WouldAcceptV2Rejects += 1;
      if (v1After >= cfg.thetaS && trueAfter < cfg.thetaS) {
        m.v1UnsafeMints += 1;
        m.v1UnsafeMintUsd += f;
      }
      if (ok && cfg.mintRule === "no-receipt") {
        // Cash arrives off-chain and is attested only at the next snapshot.
        const hash = await controller.write.authorizeMint([amount], { account: admin.account });
        gas.authorizeMintWithReceipt.push((await client.getTransactionReceipt({ hash })).gasUsed);
      }
      if (ok) {
        if (cfg.mintRule === "receipt") {
          const nonce = BigInt(day);
          const receipt = await signSubscriptionReceipt(custodian, chainId, controller.address, {
            epoch: snapshotEpoch,
            amount: received,
            nonce,
          });
          const hash = await controller.write.authorizeMintWithReceipt([amount, received, nonce, receipt], {
            account: admin.account,
          });
          gas.authorizeMintWithReceipt.push((await client.getTransactionReceipt({ hash })).gasUsed);
        }
        // v2 safety: post-mint true BCR (all cash movements) meets theta_S.
        const v2Bcr = Number(((await controller.read.currentBCR()) * 1_000_000n) / WAD) / 1e6;
        if (v2Bcr < cfg.thetaS) {
          m.unsafeMints += 1;
          m.unsafeMintUsd += f;
        }
        if (SUPPLY) {
          // The controller prices liabilities at the snapshot NAV; the issuer
          // NAV has accrued since. Post-mint BCR at today's NAV:
          const onElig = fromWad(await controller.read.currentEligibleReserves());
          const onPend = fromWad(await controller.read.currentPendingRedemptions());
          const atNav = onElig / (onPend + (units + fu) * obs[day].nav);
          m.maxPriceLagBcrPp = Math.max(m.maxPriceLagBcrPp, (v2Bcr - atNav) * 100);
          m.minMintBcrAttested = Math.min(m.minMintBcrAttested, v2Bcr);
          m.minMintBcrAtNav = Math.min(m.minMintBcrAtNav, atNav);
          if (atNav < cfg.thetaS) m.priceLagUnsafeMints += 1;
          units += fu;
        }
        tokens += f;
        cash += f + topUp;
        m.issuerTopUpUsd += topUp;
        m.pobAccepted += 1;
      } else {
        m.pobRejected += 1;
        m.pobRejectedUsd += f;
        if (porOk) m.porAcceptPobReject += 1;
      }
    } else if (f < 0) {
      // A redemption cannot exceed outstanding tokens. On-chain token
      // liabilities omit intra-interval accrual, so cap at the on-chain value.
      const onchainTokens = fromWad(await controller.read.currentTokenLiabilities());
      const onchainUnits = SUPPLY ? fromWad(await controller.read.tokenUnits()) : onchainTokens;
      const ru = SUPPLY ? Math.min(-fu, units, onchainUnits) : 0;
      let r = SUPPLY ? ru * snapPrice : Math.min(-f, tokens, onchainTokens);
      if (SUPPLY ? ru < -fu - 0.01 : r < -f - 0.01) m.redemptionsCapped += 1;
      if (r > 0.01) {
        m.redemptionRequests += 1;
        const hash = await controller.write.requestRedemption(
          [holder.account.address, SUPPLY ? toWad(ru) : toWad(r)],
          { account: admin.account },
        );
        gas.requestRedemption.push((await client.getTransactionReceipt({ hash })).gasUsed);
        const id = (await controller.read.nextRedemptionId()) - 1n;
        const rec = await controller.read.redemptions([id]);
        const queued = Number(rec[3]) === 1;
        if (SUPPLY) r = fromWad(rec[1]); // claim fixed at the snapshot price
        m.redemptionUsd += r;
        if (queued) {
          m.queued += 1;
          m.queuedUsd += r;
        } else m.instant += 1;
        if (SUPPLY) {
          units -= ru;
          tokens = units * obs[day].nav;
        } else tokens -= r;
        claims.push({
          amount: r,
          id,
          requestedDay: day,
          due: day + cfg.settlementDelayDays + (queued ? cfg.queueExtraDays : 0),
        });
      }
    }

    // (f) record the on-chain state
    const bcrWad: bigint = await controller.read.currentBCR();
    const rlcWad: bigint = await controller.read.currentRLC();
    const bcr = bcrWad > 10n ** 30n ? Infinity : Number((bcrWad * 1_000_000n) / WAD) / 1e6;
    const rlc = rlcWad > 10n ** 30n ? Infinity : Number((rlcWad * 1_000_000n) / WAD) / 1e6;
    {
      const credited = fromWad(await controller.read.creditedSubscriptionCash());
      const liab = fromWad(await controller.read.currentTotalLiabilities());
      const v1Bcr = (snapshotEligible + credited) / liab;
      if (Number.isFinite(bcr) && liab > 0) {
        m.maxBcrOverstatementPp = Math.max(m.maxBcrOverstatementPp, (v1Bcr - bcr) * 100);
      }
    }
    if (Number.isFinite(bcr)) {
      m.minBcr = Math.min(m.minBcr, bcr);
      m.maxBcr = Math.max(m.maxBcr, bcr);
      if (bcr < cfg.thetaS) m.bcrBelowThresholdDays += 1;
    }
    if (Number.isFinite(rlc)) {
      m.minRlc = Math.min(m.minRlc, rlc);
      m.daysWithPending += 1;
      if (rlc < cfg.thetaL) m.rlcBelowThresholdDays += 1;
    }
    if (cfg.persistent) {
      // Liability conservation on the persistent controller: on-chain total
      // liabilities equal the off-chain ledger (tokens + open claims).
      const onTotal = fromWad(await controller.read.currentTotalLiabilities());
      const ledger = (SUPPLY ? units * snapPrice : tokens) + pendingTotal();
      if (Math.abs(onTotal - ledger) > 1 + 1e-6 * ledger) m.liabilityConservationViolations += 1;
    }
    const { gross, eligible, liquid } = liquidAndValues(day);
    // Consistency of the on-chain view with the modelled portfolio: the
    // controller should never see more liquid or eligible value than exists.
    {
      const onLiquid = fromWad(await controller.read.currentLiquidAssets());
      const onEligible = fromWad(await controller.read.currentEligibleReserves());
      if (onLiquid > liquid * (1 + 1e-6) + 1) m.onchainLiquidAboveActualDays += 1;
      if (onEligible > eligible * (1 + 1e-3) + 1) m.onchainEligibleAboveActualDays += 1;
    }
    daily.push(
      [
        obs[day].date,
        obs[day].value.toFixed(2),
        tokens.toFixed(2),
        pendingTotal().toFixed(2),
        gross.toFixed(2),
        eligible.toFixed(2),
        liquid.toFixed(2),
        Number.isFinite(bcr) ? pct2(bcr) : "",
        Number.isFinite(rlc) ? pct2(rlc) : "",
        f.toFixed(2),
        (discountRate(curveForDate(curves, obs[day].date), 91) * 100).toFixed(2),
      ].join(","),
    );

    await networkHelpers.time.increase(DAY);
  }

  const mean = (xs: bigint[]) =>
    xs.length ? Number(xs.reduce((a, b) => a + b, 0n) / BigInt(xs.length)) : 0;
  return {
    cfg,
    horizon,
    netted,
    metrics: m,
    daily,
    gas: Object.fromEntries(Object.entries(gas).map(([k, v]) => [k, mean(v)])),
  };
}

// ---------------------------------------------------------------- test ----

describe(`Real-data replay (${FULL ? "full 1,043 days" : "70-day smoke run"})`, function () {
  it("replays observed USDY flows against real Treasury bill prices on-chain", async function () {
    const obs = await loadLiabilities();
    const curves = await loadBillCurves();
    assert.equal(obs.length, 1043);
    assert.ok(curves.size >= 700, "Treasury bill curves loaded");

    const configs: Config[] = FULL
      ? [
          { ...BASE },
          { ...BASE, name: "encumbered-4pct", encumberedBps: 400 },
          { ...BASE, name: "buffer-1.5pct", bufferBps: 150 },
          { ...BASE, name: "buffer-5pct", bufferBps: 500 },
          { ...BASE, name: "settlement-T+0", settlementDelayDays: 0 },
          { ...BASE, name: "settlement-T+3", settlementDelayDays: 3 },
          { ...BASE, name: "snapshot-daily", snapshotEveryDays: 1 },
          { ...BASE, name: "snapshot-30d", snapshotEveryDays: 30 },
          { ...BASE, name: "cleaned-series", cleaned: true },
          { ...BASE, ...ONDO_MIX, name: "ondo-mix" },
          { ...BASE, ...ONDO_MIX, name: "ondo-mix-encumbered-4pct", encumberedBps: 400 },
          // Ablation (review point 3): same data, thresholds and event sequence.
          { ...BASE, name: "ablation-A1-bcr-only", attestation: "single", mintRule: "no-receipt", liquidityPolicy: false },
          { ...BASE, name: "ablation-A2-bcr-rlc", attestation: "single", mintRule: "no-receipt" },
          { ...BASE, name: "ablation-A3-bcr-rlc-receipts", attestation: "single" },
          { ...BASE, name: "ablation-A1-bcr-only-encumbered-4pct", attestation: "single", mintRule: "no-receipt", liquidityPolicy: false, encumberedBps: 400 },
          // Encumbrance sweep around the threshold crossing (review point 5).
          ...[100, 200, 250, 300, 350].map((b) => ({ ...BASE, name: `encumbered-${b / 100}pct`, encumberedBps: b })),
          // Alternative accrual estimates (review point 5).
          { ...BASE, name: "accrual-7d", accrualWindow: 7 },
          { ...BASE, name: "accrual-91d", accrualWindow: 91 },
          { ...BASE, name: "accrual-tbill", accrualSource: "tbill" },
          // One persistent controller for the whole series (review point 8).
          { ...BASE, name: "persistent", persistent: true },
          { ...BASE, name: "persistent-encumbered-4pct", persistent: true, encumberedBps: 400 },
          // Valuation haircut under a 200 bp instead of 100 bp rate shock.
          { ...BASE, name: "haircut-200bp", rateShockBps: 200 },
          // v2.2: observed supply changes and issuer NAV as the authenticated
          // redemption price, on one persistent controller.
          ...SUPPLY_CONFIGS,
        ]
      : [
          { ...BASE },
          { ...BASE, name: "encumbered-4pct", encumberedBps: 400 },
          { ...BASE, name: "ablation-A1-bcr-only", attestation: "single", mintRule: "no-receipt", liquidityPolicy: false },
          { ...BASE, name: "persistent", persistent: true },
          { ...SUPPLY_BASE },
        ];

    // RWA_POB_CONFIGS=name1,name2 runs only those configurations and writes
    // to *-subset.csv files (for re-running single sensitivity cases).
    const only = process.env.RWA_POB_CONFIGS?.split(",").filter(Boolean);
    const selected = only ? configs.filter((c) => only.includes(c.name)) : configs;
    const rows: string[] = [];
    const gasRows: string[] = [];
    for (const cfg of selected) {
      const r = await runReplay(cfg, obs, curves);
      const m = r.metrics;
      // Accounting sanity: every request is classified exactly once.
      assert.equal(m.instant + m.queued, m.redemptionRequests);
      assert.equal(m.pobAccepted + m.pobRejected, m.subscriptionDays);
      assert.equal(m.unsafeMints, 0);
      // The controller never sees more liquid or eligible value than the
      // modelled portfolio holds (conservative between-snapshot view).
      assert.equal(m.onchainLiquidAboveActualDays, 0);
      assert.equal(m.onchainEligibleAboveActualDays, 0);
      assert.equal(m.liabilityConservationViolations, 0);
      rows.push(
        [
          cfg.name,
          r.horizon,
          m.snapshots,
          cfg.bufferBps / 100,
          pct2(cfg.thetaS),
          cfg.settlementDelayDays,
          cfg.snapshotEveryDays,
          cfg.encumberedBps / 100,
          cfg.cleaned,
          r.netted,
          m.subscriptionDays,
          m.porAccepted,
          m.pobAccepted,
          m.pobRejected,
          (m.pobRejectedUsd / 1e6).toFixed(2),
          m.porAcceptPobReject,
          m.redemptionRequests,
          (m.redemptionUsd / 1e6).toFixed(2),
          m.instant,
          m.queued,
          (m.queuedUsd / 1e6).toFixed(2),
          m.settlementDaysDeferred,
          m.maxQueueAgeDays,
          (m.billSalesForSettlementUsd / 1e6).toFixed(2),
          pct2(m.minBcr),
          pct2(m.maxBcr),
          m.bcrBelowThresholdDays,
          Number.isFinite(m.minRlc) ? pct2(m.minRlc) : "",
          m.daysWithPending,
          m.rlcBelowThresholdDays,
          m.onchainLiquidAboveActualDays,
          m.onchainEligibleAboveActualDays,
          m.unsafeMints,
          (m.unsafeMintUsd / 1e6).toFixed(2),
          m.rejectedBcr,
          m.rejectedRlc,
          (m.issuerTopUpUsd / 1e6).toFixed(2),
          (m.sweptUsd / 1e6).toFixed(2),
          m.v1WouldAcceptV2Rejects,
          m.v1UnsafeMints,
          (m.v1UnsafeMintUsd / 1e6).toFixed(2),
          m.maxBcrOverstatementPp.toFixed(2),
          m.redemptionsCapped,
          cfg.attestation,
          cfg.mintRule,
          cfg.liquidityPolicy,
          cfg.persistent,
          cfg.accrualSource === "tbill" ? "tbill" : cfg.accrualWindow,
          m.liabilityConservationViolations,
          cfg.flowSource,
          m.priceLagUnsafeMints,
          m.maxPriceLagBcrPp.toFixed(3),
          cfg.priceAccrualBps / 100,
          m.rejectedPriceRisk,
          Number.isFinite(m.minMintBcrAttested) ? (m.minMintBcrAttested * 100).toFixed(3) : "",
          Number.isFinite(m.minMintBcrAtNav) ? (m.minMintBcrAtNav * 100).toFixed(3) : "",
        ].join(","),
      );
      gasRows.push(
        [cfg.name, r.gas.submitSnapshot, r.gas.authorizeMintWithReceipt, r.gas.requestRedemption, r.gas.confirmSettlement].join(","),
      );
      if (FULL && cfg.name === "supply-baseline" && !only) {
        await writeFile(
          "data/results/real-replay-daily-supply.csv",
          "date,observed_value_usd,model_token_liabilities_usd,pending_usd,gross_usd,eligible_usd,liquid_usd,onchain_bcr_pct,onchain_rlc_pct,net_flow_usd,bill_13w_discount_pct\n" +
            r.daily.join("\n") +
            "\n",
        );
      }
      if (FULL && cfg.name === "baseline" && !only) {
        await mkdir("data/results", { recursive: true });
        await writeFile(
          "data/results/real-replay-daily-baseline.csv",
          "date,observed_value_usd,model_token_liabilities_usd,pending_usd,gross_usd,eligible_usd,liquid_usd,onchain_bcr_pct,onchain_rlc_pct,net_flow_usd,bill_13w_discount_pct\n" +
            r.daily.join("\n") +
            "\n",
        );
      }
    }

    const header =
      "config,days,snapshots,buffer_pct,theta_s_pct,settlement_delay_days,snapshot_every_days,encumbered_pct,cleaned,round_trips_netted," +
      "subscription_days,por_mint_accepted,pob_mint_accepted,pob_mint_rejected,pob_rejected_usd_m,por_accept_pob_reject," +
      "redemption_requests,redemption_usd_m,instant,queued,queued_usd_m,settlement_days_deferred,max_claim_age_days,bill_sales_for_settlement_usd_m," +
      "min_bcr_pct,max_bcr_pct,days_bcr_below_threshold,min_rlc_pct,days_with_pending,days_rlc_below_threshold,days_onchain_liquid_above_actual,days_onchain_eligible_above_actual,unsafe_mints,unsafe_mint_usd_m,rejected_bcr,rejected_rlc,issuer_topup_usd_m,swept_usd_m,v1_accept_v2_reject,v1_unsafe_mints,v1_unsafe_mint_usd_m,max_v1_bcr_overstatement_pp,redemptions_capped,attestation,mint_rule,liquidity_policy,persistent,accrual,liability_conservation_violations,flow_source,price_lag_unsafe_mints,max_price_lag_bcr_pp,price_risk_accrual_pct,rejected_price_risk,min_post_mint_bcr_attested_pct,min_post_mint_bcr_at_nav_pct";
    const suffix = only ? "-subset" : "";
    const out = FULL ? `data/results/real-replay-summary${suffix}.csv` : `data/results/real-replay-smoke${suffix}.csv`;
    await mkdir("data/results", { recursive: true });
    await writeFile(out, `${header}\n${rows.join("\n")}\n`);
    await writeFile(
      FULL ? `data/results/real-replay-gas${suffix}.csv` : `data/results/real-replay-gas-smoke${suffix}.csv`,
      `config,mean_gas_submit_snapshot,mean_gas_mint_authorization,mean_gas_request_redemption,mean_gas_confirm_settlement\n${gasRows.join("\n")}\n`,
    );
  });
});
