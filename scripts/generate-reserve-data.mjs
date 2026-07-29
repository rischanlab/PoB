import { mkdir, readFile, writeFile } from "node:fs/promises";
import { StandardMerkleTree } from "@openzeppelin/merkle-tree";

const CALIBRATION_FILE = "data/input/usdy-calibration.json";
const OUTPUT_DIRECTORY = "data/input/usdy-scenarios";

const SEED = 42;
const POSITION_COUNT = 100;
const USD_DECIMALS = 6;
const BPS_DENOMINATOR = 10_000n;

// Scenario assumptions. These are controlled experimental parameters,
// not claims about USDY's actual reserve composition.
const TARGET_GROSS_RESERVE_BPS = 11_500n; // 115% of observed token value
const VALID_LIQUID_ASSET_BPS = 1_000n; // 10% of observed token value
const STRESS_LIQUID_ASSET_BPS = 200n; // 2% of observed token value
const ENCUMBERED_TARGET_ELIGIBLE_BPS = 9_800n; // below token value

function lcg(seed) {
  let state = BigInt(seed);
  return () => {
    state = (1_664_525n * state + 1_013_904_223n) % 4_294_967_296n;
    return Number(state) / 4_294_967_296;
  };
}

function parseDecimal(value, decimals = USD_DECIMALS) {
  const text = String(value).trim();
  if (!/^\d+(\.\d+)?$/.test(text)) {
    throw new Error(`Invalid non-negative decimal value: ${value}`);
  }

  const [whole, fraction = ""] = text.split(".");
  const normalizedFraction = fraction.padEnd(decimals, "0").slice(0, decimals);
  return (
    BigInt(whole) * 10n ** BigInt(decimals) +
    BigInt(normalizedFraction || "0")
  );
}

function formatDecimal(value, decimals = USD_DECIMALS) {
  const divisor = 10n ** BigInt(decimals);
  const whole = value / divisor;
  const fraction = (value % divisor).toString().padStart(decimals, "0");
  return `${whole}.${fraction}`;
}

function clonePositions(positions) {
  return positions.map((position) => ({ ...position }));
}

function allocateLiquidValue(positions, targetLiquidValue) {
  for (const position of positions) {
    position.liquidValue = 0n;
  }

  let remaining = targetLiquidValue;
  const ordered = [...positions].sort((left, right) => {
    if (left.maturityDays !== right.maturityDays) {
      return Number(left.maturityDays - right.maturityDays);
    }
    return left.positionId.localeCompare(right.positionId);
  });

  for (const position of ordered) {
    if (remaining <= 0n) {
      break;
    }

    const allocated =
      position.eligibleValue < remaining ? position.eligibleValue : remaining;
    position.liquidValue = allocated;
    remaining -= allocated;
  }

  if (remaining > 0n) {
    throw new Error("Eligible reserves are insufficient for the liquid target.");
  }
}

function totalOf(positions, field) {
  return positions.reduce((sum, position) => sum + position[field], 0n);
}

function buildBasePositions(targetGrossReserves) {
  const random = lcg(SEED);
  const weights = Array.from(
    { length: POSITION_COUNT },
    () => BigInt(Math.floor(100 + random() * 900)),
  );
  const totalWeight = weights.reduce((sum, value) => sum + value, 0n);

  const positions = [];
  let allocatedMarketValue = 0n;

  for (let index = 0; index < POSITION_COUNT; index += 1) {
    const isLast = index === POSITION_COUNT - 1;
    const marketValue = isLast
      ? targetGrossReserves - allocatedMarketValue
      : (targetGrossReserves * weights[index]) / totalWeight;

    allocatedMarketValue += marketValue;

    const priceBps = BigInt(Math.floor(9_700 + random() * 300));
    const faceValue = (marketValue * BPS_DENOMINATOR) / priceBps;
    const haircutBps = BigInt(Math.floor(5 + random() * 45));
    const maturityDays = BigInt(Math.floor(1 + random() * 365));
    const eligibleValue =
      (marketValue * (BPS_DENOMINATOR - haircutBps)) / BPS_DENOMINATOR;

    positions.push({
      positionId: `POS-${String(index + 1).padStart(4, "0")}`,
      instrumentId: `SYNTH-${String(index + 1).padStart(6, "0")}`,
      faceValue,
      marketValue,
      eligibleValue,
      liquidValue: 0n,
      maturityDays,
      haircutBps,
      encumbered: false,
      legallyEligible: true,
      settlementFinal: true,
    });
  }

  return positions;
}

function createScenarios(basePositions, tokenLiabilities) {
  const valid = clonePositions(basePositions);
  allocateLiquidValue(
    valid,
    (tokenLiabilities * VALID_LIQUID_ASSET_BPS) / BPS_DENOMINATOR,
  );

  const encumbered = clonePositions(valid);
  const targetEligible =
    (tokenLiabilities * ENCUMBERED_TARGET_ELIGIBLE_BPS) / BPS_DENOMINATOR;

  // Prefer encumbering non-liquid positions so that this scenario isolates
  // backing eligibility rather than liquidity.
  const candidates = [...encumbered].sort((left, right) => {
    const leftIsLiquid = left.liquidValue > 0n ? 1 : 0;
    const rightIsLiquid = right.liquidValue > 0n ? 1 : 0;
    if (leftIsLiquid !== rightIsLiquid) {
      return leftIsLiquid - rightIsLiquid;
    }
    if (left.marketValue === right.marketValue) {
      return left.positionId.localeCompare(right.positionId);
    }
    return left.marketValue > right.marketValue ? -1 : 1;
  });

  let encumberedEligibleTotal = totalOf(encumbered, "eligibleValue");
  for (const position of candidates) {
    if (encumberedEligibleTotal <= targetEligible) {
      break;
    }
    encumberedEligibleTotal -= position.eligibleValue;
    position.encumbered = true;
    position.eligibleValue = 0n;
    position.liquidValue = 0n;
  }

  const liquidityStress = clonePositions(basePositions);
  allocateLiquidValue(
    liquidityStress,
    (tokenLiabilities * STRESS_LIQUID_ASSET_BPS) / BPS_DENOMINATOR,
  );

  return [
    {
      name: "valid",
      description:
        "Eligible backing exceeds the BCR threshold and liquid assets cover a 5% redemption request.",
      positions: valid,
    },
    {
      name: "encumbered-assets",
      description:
        "Gross reserves remain unchanged, but selected positions are ineligible because they are encumbered.",
      positions: encumbered,
    },
    {
      name: "liquidity-stress",
      description:
        "Eligible backing remains sufficient, but only 2% of observed token value is liquid within the test horizon.",
      positions: liquidityStress,
    },
  ];
}

function buildTree(positions) {
  const values = positions.map((position) => [
    position.positionId,
    position.instrumentId,
    position.faceValue.toString(),
    position.marketValue.toString(),
    position.eligibleValue.toString(),
    position.liquidValue.toString(),
    position.maturityDays.toString(),
    position.haircutBps.toString(),
    position.encumbered,
    position.legallyEligible,
    position.settlementFinal,
  ]);

  const leafTypes = [
    "string",
    "string",
    "uint256",
    "uint256",
    "uint256",
    "uint256",
    "uint256",
    "uint256",
    "bool",
    "bool",
    "bool",
  ];

  return StandardMerkleTree.of(values, leafTypes);
}

function toCsv(positions) {
  const headers = [
    "position_id",
    "instrument_id",
    "face_value_usd",
    "market_value_usd",
    "eligible_value_usd",
    "liquid_value_usd",
    "maturity_days",
    "haircut_bps",
    "encumbered",
    "legally_eligible",
    "settlement_final",
  ];

  const rows = positions.map((position) =>
    [
      position.positionId,
      position.instrumentId,
      formatDecimal(position.faceValue),
      formatDecimal(position.marketValue),
      formatDecimal(position.eligibleValue),
      formatDecimal(position.liquidValue),
      position.maturityDays,
      position.haircutBps,
      position.encumbered,
      position.legallyEligible,
      position.settlementFinal,
    ].join(","),
  );

  return [headers.join(","), ...rows].join("\n") + "\n";
}

const calibration = JSON.parse(await readFile(CALIBRATION_FILE, "utf8"));
const tokenLiabilities = parseDecimal(
  calibration.latestObservedTokenValueUsd,
);
const targetGrossReserves =
  (tokenLiabilities * TARGET_GROSS_RESERVE_BPS) / BPS_DENOMINATOR;

const basePositions = buildBasePositions(targetGrossReserves);
const scenarios = createScenarios(basePositions, tokenLiabilities);

await mkdir(OUTPUT_DIRECTORY, { recursive: true });

for (const scenario of scenarios) {
  const tree = buildTree(scenario.positions);
  const grossReserves = totalOf(scenario.positions, "marketValue");
  const eligibleReserves = totalOf(scenario.positions, "eligibleValue");
  const liquidAssets = totalOf(scenario.positions, "liquidValue");

  const summary = {
    scenario: scenario.name,
    description: scenario.description,
    seed: SEED,
    positionCount: POSITION_COUNT,
    valueUnit: `USD with ${USD_DECIMALS} decimal places`,
    liabilitySource: calibration.source,
    liabilityProduct: calibration.product,
    liabilityMeasure: calibration.measure,
    liabilityDate: calibration.lastDate,
    tokenLiabilitiesUsd: formatDecimal(tokenLiabilities),
    grossReservesUsd: formatDecimal(grossReserves),
    eligibleReservesUsd: formatDecimal(eligibleReserves),
    liquidAssetsUsd: formatDecimal(liquidAssets),
    merkleRoot: tree.root,
    assumptions: {
      targetGrossReserveBps: TARGET_GROSS_RESERVE_BPS.toString(),
      validLiquidAssetBps: VALID_LIQUID_ASSET_BPS.toString(),
      stressLiquidAssetBps: STRESS_LIQUID_ASSET_BPS.toString(),
      encumberedTargetEligibleBps:
        ENCUMBERED_TARGET_ELIGIBLE_BPS.toString(),
    },
  };

  await writeFile(
    `${OUTPUT_DIRECTORY}/${scenario.name}-positions.csv`,
    toCsv(scenario.positions),
  );
  await writeFile(
    `${OUTPUT_DIRECTORY}/${scenario.name}-tree.json`,
    `${JSON.stringify(tree.dump(), null, 2)}\n`,
  );
  await writeFile(
    `${OUTPUT_DIRECTORY}/${scenario.name}-summary.json`,
    `${JSON.stringify(summary, null, 2)}\n`,
  );

  console.log(`Scenario: ${scenario.name}`);
  console.log(`  Liability date: ${calibration.lastDate}`);
  console.log(`  Token liabilities: $${formatDecimal(tokenLiabilities)}`);
  console.log(`  Gross reserves: $${formatDecimal(grossReserves)}`);
  console.log(`  Eligible reserves: $${formatDecimal(eligibleReserves)}`);
  console.log(`  Liquid assets: $${formatDecimal(liquidAssets)}`);
  console.log(`  Merkle root: ${tree.root}`);
}
