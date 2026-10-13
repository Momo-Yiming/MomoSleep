import { scoreSleep } from "./domain.mjs";

export function disclosedSleepSample() {
  const profile = "screenshot";
  const profileLabel = "用户授权公开的单夜样例";
  const nightKey = "disclosed-example-a";
  const input = {
    asleepMinutes: 0,
    coreMinutes: 250,
    remMinutes: 50,
    deepMinutes: 105,
    awakeMinutes: 31,
    interruptionCount: 6,
    scheduleDeviationMinutes: 565,
  };
  const score = scoreSleep(input);
  const scoreBreakdown = {
    ...score,
    sourceLabel: profileLabel,
    windowLabel: "07:36–15:13",
    regularityBasis: "演示目标 21:00–07:00；入睡圆周偏差 636 分钟、醒来偏差 493 分钟，平均 565；不是多晚个人基线",
    vendorReportedDeepPercent: 24.1,
    visibleStageMinutes: 436,
    unclassifiedWindowMinutes: 21,
    inputNotes: [
      "清醒、REM、浅睡和深睡分钟来自截图汇总",
      "设备口径 24.1% = 105 / 436（含清醒）；计分口径 25.9% = 105 / 405（仅实际睡眠）",
      "6 次中断为图中可见片段估计，待原始逐分钟导出校准",
      "25% 是可版本化激励参数，不是医学诊断阈值",
    ],
  };
  const fingerprintData = {
    format: "sleep-claim-v2",
    nightKey,
    scoringVersion: score.scoringVersion,
    ...input,
    depthClosenessBasisPoints: score.depthClosenessBasisPoints,
    effectiveDeepWeightBasisPoints: score.effectiveDeepWeightBasisPoints,
    stagePoints: score.stagePoints,
    continuityFactorBasisPoints: score.continuityFactorBasisPoints,
    regularityFactorBasisPoints: score.regularityFactorBasisPoints,
    awardedPoints: score.awardedPoints,
  };
  const summary = {
    sample: true,
    source: "screenshot_summary",
    profile,
    profileLabel,
    nightKey,
    windowLabel: scoreBreakdown.windowLabel,
    windowMinutes: 457,
    sleepMinutes: score.sourceMinutes,
    awakeMinutes: input.awakeMinutes,
    unclassifiedWindowMinutes: scoreBreakdown.unclassifiedWindowMinutes,
    stageMinutes: { ...score.sourceStageMinutes },
    scoreBreakdown,
  };
  return { profile, profileLabel, nightKey, input, score, scoreBreakdown, fingerprintData, summary };
}
