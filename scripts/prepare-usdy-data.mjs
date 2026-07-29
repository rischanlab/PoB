import {
  mkdir,
  readFile,
  writeFile,
} from "node:fs/promises";

const INPUT_FILE =
  "data/raw/rwa-xyz-treasury-market-caps.csv";

const OUTPUT_CSV =
  "data/input/usdy-observed-liabilities.csv";

const OUTPUT_JSON =
  "data/input/usdy-calibration.json";

const PRODUCT_COLUMN = "Ondo U.S. Dollar Yield";
const EXPECTED_MEASURE = "Bridged Token Value (Dollar)";

/**
 * Parse one CSV row while respecting quoted fields.
 *
 * This is sufficient for the downloaded RWA.xyz file and avoids
 * introducing another npm dependency.
 */
function parseCsvLine(line) {
  const values = [];
  let current = "";
  let insideQuotes = false;

  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];

    if (character === '"') {
      const nextCharacter = line[index + 1];

      if (insideQuotes && nextCharacter === '"') {
        current += '"';
        index += 1;
      } else {
        insideQuotes = !insideQuotes;
      }
    } else if (character === "," && !insideQuotes) {
      values.push(current);
      current = "";
    } else {
      current += character;
    }
  }

  values.push(current);
  return values;
}

function csvEscape(value) {
  const text = String(value);

  if (/[",\n]/.test(text)) {
    return `"${text.replaceAll('"', '""')}"`;
  }

  return text;
}

function parseNumber(value) {
  const cleaned = String(value ?? "")
    .trim()
    .replaceAll("$", "")
    .replaceAll(",", "");

  if (cleaned === "") {
    return null;
  }

  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : null;
}

const fileContents = await readFile(INPUT_FILE, "utf8");

const lines = fileContents
  .replace(/^\uFEFF/, "")
  .split(/\r?\n/)
  .filter((line) => line.trim() !== "");

if (lines.length < 2) {
  throw new Error(`No data found in ${INPUT_FILE}`);
}

const headers = parseCsvLine(lines[0]);

const dateIndex = headers.indexOf("Date");
const measureIndex = headers.indexOf("Measure");
const productIndex = headers.indexOf(PRODUCT_COLUMN);

if (dateIndex === -1) {
  throw new Error('Required column "Date" was not found.');
}

if (measureIndex === -1) {
  throw new Error('Required column "Measure" was not found.');
}

if (productIndex === -1) {
  throw new Error(
    `Required product column "${PRODUCT_COLUMN}" was not found.`,
  );
}

const observations = [];

for (const line of lines.slice(1)) {
  const row = parseCsvLine(line);

  const date = row[dateIndex]?.trim();
  const measure = row[measureIndex]?.trim();
  const observedValueUsd = parseNumber(row[productIndex]);

  if (
    !date ||
    observedValueUsd === null ||
    observedValueUsd <= 0
  ) {
    continue;
  }

  if (measure !== EXPECTED_MEASURE) {
    continue;
  }

  observations.push({
    date,
    measure,
    observedValueUsd,
  });
}

observations.sort(
  (left, right) =>
    new Date(left.date).getTime() -
    new Date(right.date).getTime(),
);

if (observations.length === 0) {
  throw new Error(
    `No usable observations were found for ${PRODUCT_COLUMN}.`,
  );
}

const processed = observations.map(
  (observation, index) => {
    const previous =
      index === 0
        ? null
        : observations[index - 1].observedValueUsd;

    const dailyChangeUsd =
      previous === null
        ? null
        : observation.observedValueUsd - previous;

    const dailyChangeRate =
      previous === null || previous === 0
        ? null
        : dailyChangeUsd / previous;

    return {
      ...observation,
      dailyChangeUsd,
      dailyChangeRate,
    };
  },
);

await mkdir("data/input", { recursive: true });

const outputHeaders = [
  "date",
  "measure",
  "observed_token_value_usd",
  "daily_change_usd",
  "daily_change_rate",
];

const outputRows = processed.map((row) =>
  [
    row.date,
    row.measure,
    row.observedValueUsd.toFixed(6),
    row.dailyChangeUsd === null
      ? ""
      : row.dailyChangeUsd.toFixed(6),
    row.dailyChangeRate === null
      ? ""
      : row.dailyChangeRate.toFixed(10),
  ]
    .map(csvEscape)
    .join(","),
);

await writeFile(
  OUTPUT_CSV,
  [outputHeaders.join(","), ...outputRows].join("\n") +
    "\n",
);

const latest = processed.at(-1);
const first = processed[0];

const calibration = {
  source: "RWA.xyz downloaded CSV",
  sourceFile: INPUT_FILE,
  product: PRODUCT_COLUMN,
  measure: EXPECTED_MEASURE,
  interpretation:
    "Observed token value used to calibrate liabilities; " +
    "not treated as independently verified reserve value.",
  observations: processed.length,
  firstDate: first.date,
  lastDate: latest.date,
  latestObservedTokenValueUsd:
    latest.observedValueUsd.toFixed(6),
  latestDailyChangeUsd:
    latest.dailyChangeUsd === null
      ? null
      : latest.dailyChangeUsd.toFixed(6),
};

await writeFile(
  OUTPUT_JSON,
  `${JSON.stringify(calibration, null, 2)}\n`,
);

console.log(`Product: ${PRODUCT_COLUMN}`);
console.log(`Measure: ${EXPECTED_MEASURE}`);
console.log(`Observations: ${processed.length}`);
console.log(`First date: ${first.date}`);
console.log(`Last date: ${latest.date}`);
console.log(
  `Latest observed value: $${latest.observedValueUsd.toLocaleString(
    "en-US",
    {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    },
  )}`,
);
console.log(`Saved: ${OUTPUT_CSV}`);
console.log(`Saved: ${OUTPUT_JSON}`);