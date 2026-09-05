const MAXIMUM_MINUTES = 480;
const DAILY_POINT_CAP = 1_440;
const TARGET_DEEP_RATIO = 0.25;
const MIN_QUALITY_BASIS_POINTS = 7_000;

export const SCORING_VERSION = 2;

export function quoteCashRedemption(points, rateFenPer100Points) {
  if (!Number.isInteger(points) || points < 1 || points > 100_000) {
    throw new Error("points must be an integer from 1 to 100000");
  }
  if (!Number.isInteger(rateFenPer100Points) || rateFenPer100Points < 1 || rateFenPer100Points > 10_000) {
    throw new Error("rateFenPer100Points must be an integer from 1 to 10000");
  }
  const amountFen = Math.floor(points * rateFenPer100Points / 100);
  return { points, rateFenPer100Points, amountFen };
}

function minuteValue(value, name) {
  if (!Number.isInteger(value) || value < 0 || value > 1_440) {
    throw new Error(`${name} must be an integer from 0 to 1440`);
  }
  return value;
}

export function scoreSleep(input) {
  const asleep = minuteValue(input.asleepMinutes ?? 0, "asleepMinutes");
  const core = minuteValue(input.coreMinutes ?? 0, "coreMinutes");
  const rem = minuteValue(input.remMinutes ?? 0, "remMinutes");
  const deep = minuteValue(input.deepMinutes ?? 0, "deepMinutes");
  const awake = minuteValue(input.awakeMinutes ?? 0, "awakeMinutes");
  const interruptions = minuteValue(input.interruptionCount ?? 0, "interruptionCount");
  const scheduleDeviation = input.scheduleDeviationMinutes == null
    ? null
    : minuteValue(input.scheduleDeviationMinutes, "scheduleDeviationMinutes");
  const total = asleep + core + rem + deep;
  if (total === 0) throw new Error("sleep minutes are required");
  const deepRatio = deep / total;
  const depthClosenessBasisPoints = Math.max(
    0,
    10_000 - Math.round(Math.abs(4 * deep - total) * 10_000 / total),
  );
  const effectiveDeepWeightBasisPoints = 10_000 + 2 * depthClosenessBasisPoints;
  const weightedBasisPoints =
    (asleep + core) * 10_000
    + rem * 20_000
    + deep * effectiveDeepWeightBasisPoints;
  const stagePoints = Math.min(
    DAILY_POINT_CAP,
    Math.round(weightedBasisPoints * Math.min(total, MAXIMUM_MINUTES) / total / 10_000),
  );
  const continuityFactorBasisPoints = Math.max(
    MIN_QUALITY_BASIS_POINTS,
    10_000 - 200 * interruptions - 10 * awake,
  );
  const regularityFactorBasisPoints = scheduleDeviation == null
    ? 10_000
    : Math.max(MIN_QUALITY_BASIS_POINTS, 10_000 - Math.round(scheduleDeviation * 10_000 / 600));
  const awardedPoints = Math.round(
    stagePoints * continuityFactorBasisPoints * regularityFactorBasisPoints / 100_000_000,
  );
  const counted = Math.min(total, MAXIMUM_MINUTES);
  const sourceStageMinutes = { asleep, core, rem, deep, awake, conflicting: 0 };
  return {
    scoringVersion: SCORING_VERSION,
    sourceMinutes: total,
    countedMinutes: counted,
    sourceStageMinutes,
    stageMinutes: {
      asleep: Math.floor(asleep * counted / total),
      core: Math.floor(core * counted / total),
      rem: Math.floor(rem * counted / total),
      deep: Math.floor(deep * counted / total),
      awake,
      conflicting: 0,
    },
    awakeMinutes: awake,
    interruptionCount: interruptions,
    deepRatioPercent: Number((deepRatio * 100).toFixed(1)),
    targetDeepPercent: TARGET_DEEP_RATIO * 100,
    depthClosenessPercent: Number((depthClosenessBasisPoints / 100).toFixed(1)),
    depthClosenessBasisPoints,
    effectiveDeepWeight: Number((effectiveDeepWeightBasisPoints / 10_000).toFixed(3)),
    effectiveDeepWeightBasisPoints,
    stagePoints,
    continuityFactor: continuityFactorBasisPoints / 10_000,
    continuityFactorBasisPoints,
    scheduleDeviationMinutes: scheduleDeviation,
    regularityFactor: regularityFactorBasisPoints / 10_000,
    regularityFactorBasisPoints,
    rawPoints: stagePoints,
    awardedPoints,
    trustGrade: "SANDBOX",
  };
}

export function hexToBytes(hex) {
  if (!/^[0-9a-f]{64}$/i.test(hex)) throw new Error("expected a 32-byte hex value");
  return Uint8Array.from(hex.match(/.{2}/g), (pair) => Number.parseInt(pair, 16));
}

export function bytesToHex(bytes) {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function sha256Hex(value) {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  return bytesToHex(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)));
}

export async function simulatedChainReceipt({ recordId, commitment, createdAt, sequence = 1, recordType = "sleep" }) {
  if (typeof recordId !== "string" || !recordId) throw new Error("recordId is required");
  if (!/^[a-z-]{3,24}$/.test(recordType)) throw new Error("valid recordType is required");
  hexToBytes(commitment);
  const timestamp = Date.parse(createdAt);
  if (!Number.isFinite(timestamp)) throw new Error("valid createdAt is required");
  if (!Number.isInteger(sequence) || sequence < 1) throw new Error("sequence must be positive");
  const anchorTime = Date.parse("2026-09-04T12:38:15Z");
  const blockNumber = 59_626_845 + Math.max(1, Math.floor((timestamp - anchorTime) / 1_000)) + sequence;
  return {
    kind: "simulation",
    recordType,
    status: "simulated_confirmed",
    claimHash: `0x${commitment}`,
    transactionHash: `0x${await sha256Hex(`${recordType}-demo-tx:v1:${recordId}:${commitment}`)}`,
    blockNumber,
    confirmations: 12,
    recordedAt: createdAt,
  };
}

async function leafHash(commitment) {
  const value = hexToBytes(commitment);
  const bytes = new Uint8Array(1 + value.length);
  bytes.set(value, 1);
  return hexToBytes(await sha256Hex(bytes));
}

async function parentHash(left, right) {
  const bytes = new Uint8Array(1 + left.length + right.length);
  bytes[0] = 1;
  bytes.set(left, 1);
  bytes.set(right, 1 + left.length);
  return hexToBytes(await sha256Hex(bytes));
}

export async function merkleRoot(commitments) {
  if (!commitments.length) throw new Error("at least one commitment is required");
  let level = await Promise.all([...commitments].sort().map(leafHash));
  while (level.length > 1) {
    const next = [];
    for (let index = 0; index < level.length; index += 2) {
      next.push(await parentHash(level[index], level[index + 1] ?? level[index]));
    }
    level = next;
  }
  return bytesToHex(level[0]);
}
