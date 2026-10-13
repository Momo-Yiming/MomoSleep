import { scoreSleep } from "./domain.mjs";

const people = [
  { nameZh: "小林", nameEn: "Lin", roleZh: "虚构上班族", roleEn: "Fictional office worker", minutes: 450, bedtime: 23 * 60 },
  { nameZh: "小宇", nameEn: "Yu", roleZh: "虚构学生", roleEn: "Fictional student", minutes: 410, bedtime: 24 * 60 },
  { nameZh: "小安", nameEn: "An", roleZh: "虚构轮班者", roleEn: "Fictional shift worker", minutes: 390, bedtime: 8 * 60 },
  { nameZh: "小禾", nameEn: "He", roleZh: "虚构自由职业者", roleEn: "Fictional freelancer", minutes: 440, bedtime: 22 * 60 },
  { nameZh: "小宁", nameEn: "Ning", roleZh: "虚构晨型作息者", roleEn: "Fictional early riser", minutes: 470, bedtime: 21 * 60 },
];

export function canonicalSimulationId(value) {
  if (typeof value !== "string" || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(value)) {
    throw new Error("simulationId must be a UUID");
  }
  return value.toLowerCase();
}

export function sleepSimulation(value) {
  const simulationId = canonicalSimulationId(value);
  let seed = 2166136261;
  for (const char of simulationId) seed = Math.imul(seed ^ char.charCodeAt(0), 16777619) >>> 0;
  const personIndex = seed % people.length;
  const random = (minimum, maximum) => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return minimum + seed % (maximum - minimum + 1);
  };
  const { minutes, bedtime, ...person } = people[personIndex];
  // A fixed synthetic calendar keeps the same UUID stable across refreshes/days.
  const nightDate = new Date(Date.UTC(2026, 8, 1 + random(0, 42))).toISOString().slice(0, 10);
  const total = minutes + random(-70, 80);
  const deep = Math.round(total * random(10, 31) / 100);
  const rem = Math.round(total * random(15, 28) / 100);
  const awake = random(5, 65);
  const start = (bedtime + random(-75, 90) + 1440) % 1440;
  const end = (start + total + awake) % 1440;
  const circularDistance = (left, right) => Math.min(Math.abs(left - right), 1440 - Math.abs(left - right));
  const input = {
    asleepMinutes: 0,
    coreMinutes: total - deep - rem,
    remMinutes: rem,
    deepMinutes: deep,
    awakeMinutes: awake,
    interruptionCount: random(0, 7),
    scheduleDeviationMinutes: Math.round((circularDistance(start, 23 * 60) + circularDistance(end, 7 * 60)) / 2),
  };
  const score = scoreSleep(input);
  const clock = minute => `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
  const nightKey = `simulation-${simulationId}`;
  const summary = {
    sample: false,
    source: "synthetic",
    status: "synthetic",
    profile: "simulation",
    profileLabel: "随机生成的虚构睡眠记录",
    simulationId,
    person,
    nightDate,
    nightKey,
    windowLabel: `${clock(start)}–${clock(end)}`,
    windowMinutes: total + awake,
    sleepMinutes: total,
    awakeMinutes: awake,
    unclassifiedWindowMinutes: 0,
    stageMinutes: { ...score.sourceStageMinutes },
  };
  const details = {
    ...score,
    source: "synthetic",
    simulationId,
    person,
    nightDate,
    sourceLabel: summary.profileLabel,
    windowLabel: summary.windowLabel,
    visibleStageMinutes: total + awake,
    unclassifiedWindowMinutes: 0,
    regularityBasis: "虚构作息与 23:00–07:00 目标比较，不是个人多晚基线",
    inputNotes: ["人物、日期和全部数值均由 UUID 种子模拟生成，不来自设备或健康记录", "实验性激励参数，不是医学标准；模拟记录不可用于真实铸币或管理员批次"],
  };
  const fullSummary = { ...summary, scoreBreakdown: details };
  const scoreBreakdown = { ...details, summary: fullSummary };
  const fingerprintData = { format: "synthetic-sleep-v1", source: "synthetic", simulationId, nightKey, scoringVersion: score.scoringVersion, ...input, awardedPoints: score.awardedPoints };
  return { profile: "simulation", nightKey, input, score, scoreBreakdown, fingerprintData, summary: fullSummary };
}
