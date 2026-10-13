import assert from "node:assert/strict";
import test from "node:test";
import { scoreSleep } from "../src/domain.mjs";
import { disclosedSleepSample } from "../src/sleep-sample.mjs";

test("the disclosed screenshot sample retains its 390-point calculation", () => {
  const sample = disclosedSleepSample();
  assert.deepEqual(sample.score, scoreSleep(sample.input));
  assert.equal(sample.nightKey, "disclosed-example-a");
  assert.equal(sample.profile, "screenshot");
  assert.equal(sample.score.stagePoints, 657);
  assert.equal(sample.score.continuityFactor, 0.849);
  assert.equal(sample.score.regularityFactor, 0.7);
  assert.equal(sample.score.awardedPoints, 390);
  assert.equal(sample.fingerprintData.format, "sleep-claim-v2");
  assert.equal(sample.fingerprintData.awardedPoints, sample.summary.scoreBreakdown.awardedPoints);
});

test("summary accounts for the full known window without treating awake or unknown minutes as sleep", () => {
  const { summary } = disclosedSleepSample();
  const { asleep, core, rem, deep, awake, conflicting } = summary.stageMinutes;
  assert.equal(asleep + core + rem + deep, 405);
  assert.equal(summary.sleepMinutes, 405);
  assert.equal(awake, 31);
  assert.equal(conflicting, 0);
  assert.equal(summary.unclassifiedWindowMinutes, 21);
  assert.equal(summary.windowMinutes, (15 * 60 + 13) - (7 * 60 + 36));
  assert.equal(summary.sleepMinutes + summary.awakeMinutes + summary.unclassifiedWindowMinutes, summary.windowMinutes);
  assert.equal(summary.scoreBreakdown.visibleStageMinutes, summary.sleepMinutes + summary.awakeMinutes);
  assert.equal(summary.sample, true);
  assert.equal(summary.source, "screenshot_summary");
  assert.equal(summary.windowLabel, "07:36–15:13");
  assert.match(summary.scoreBreakdown.regularityBasis, /不是多晚个人基线/);
  assert.match(summary.scoreBreakdown.inputNotes.join(" "), /估计.*不是医学诊断阈值/);
  assert.equal(summary.timeline, undefined);
  assert.equal(summary.deviceConnected, undefined);
});

test("a caller cannot change the sample returned to a later request", () => {
  const first = disclosedSleepSample();
  first.input.deepMinutes = 0;
  first.summary.stageMinutes.deep = 0;
  first.scoreBreakdown.inputNotes.length = 0;
  const next = disclosedSleepSample();
  assert.equal(next.input.deepMinutes, 105);
  assert.equal(next.summary.stageMinutes.deep, 105);
  assert.equal(next.scoreBreakdown.inputNotes.length, 4);
  assert.equal(next.score.awardedPoints, 390);
});
