import assert from "node:assert/strict";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { merkleRoot, quoteCashRedemption, scoreSleep, sha256Hex, simulatedChainReceipt } from "../src/domain.mjs";
import server from "../src/index.mjs";

test("uses 1x, 2x and the full 3x Deep weight at the 25 percent model target", () => {
  const result = scoreSleep({ coreMinutes: 300, remMinutes: 60, deepMinutes: 120 });
  assert.equal(result.countedMinutes, 480);
  assert.equal(result.deepRatioPercent, 25);
  assert.equal(result.effectiveDeepWeight, 3);
  assert.equal(result.rawPoints, 780);
  assert.equal(result.awardedPoints, 780);
  assert.equal(result.trustGrade, "SANDBOX");
});

test("scales the whole night to eight hours", () => {
  const result = scoreSleep({ coreMinutes: 360, remMinutes: 120, deepMinutes: 120 });
  assert.equal(result.countedMinutes, 480);
  assert.equal(result.rawPoints, 730);
  assert.deepEqual(result.sourceStageMinutes, { asleep: 0, core: 360, rem: 120, deep: 120, awake: 0, conflicting: 0 });
  assert.deepEqual(result.stageMinutes, { asleep: 0, core: 288, rem: 96, deep: 96, awake: 0, conflicting: 0 });
});

test("recalculates the September 4 screenshot example from disclosed inputs", () => {
  const result = scoreSleep({
    coreMinutes: 250,
    remMinutes: 50,
    deepMinutes: 105,
    awakeMinutes: 31,
    interruptionCount: 6,
    scheduleDeviationMinutes: 565,
  });
  assert.equal(result.sourceMinutes, 405);
  assert.equal(result.deepRatioPercent, 25.9);
  assert.equal(result.effectiveDeepWeight, 2.926);
  assert.equal(result.effectiveDeepWeightBasisPoints, 29_260);
  assert.equal(result.stagePoints, 657);
  assert.equal(result.continuityFactor, 0.849);
  assert.equal(result.continuityFactorBasisPoints, 8_490);
  assert.equal(result.regularityFactor, 0.7);
  assert.equal(result.awardedPoints, 390);
});

test("rewards the 25 percent Deep target more than equal-length lower or higher ratios", () => {
  const low = scoreSleep({ coreMinutes: 420, deepMinutes: 60 });
  const target = scoreSleep({ coreMinutes: 360, deepMinutes: 120 });
  const high = scoreSleep({ coreMinutes: 300, deepMinutes: 180 });
  assert.ok(target.awardedPoints > low.awardedPoints);
  assert.ok(target.awardedPoints > high.awardedPoints);
});

test("interruptions and schedule deviation can only lower a matching score", () => {
  const base = { coreMinutes: 300, remMinutes: 60, deepMinutes: 120, awakeMinutes: 20 };
  const uninterrupted = scoreSleep(base);
  const interrupted = scoreSleep({ ...base, interruptionCount: 3 });
  const irregular = scoreSleep({ ...base, interruptionCount: 3, scheduleDeviationMinutes: 120 });
  assert.ok(interrupted.awardedPoints < uninterrupted.awardedPoints);
  assert.ok(irregular.awardedPoints < interrupted.awardedPoints);
});

test("rejects invalid minutes", () => {
  assert.throws(() => scoreSleep({ deepMinutes: -1 }), /deepMinutes/);
  assert.throws(() => scoreSleep({}), /required/);
});

test("quotes cash redemption using integer fen without floating-point money", () => {
  assert.deepEqual(quoteCashRedemption(390, 100), {
    points: 390,
    rateFenPer100Points: 100,
    amountFen: 390,
  });
  assert.deepEqual(quoteCashRedemption(199, 85), {
    points: 199,
    rateFenPer100Points: 85,
    amountFen: 169,
  });
  assert.throws(() => quoteCashRedemption(0, 100), /points/);
});

test("builds a deterministic order-independent Merkle root", async () => {
  const one = await sha256Hex("claim-one");
  const two = await sha256Hex("claim-two");
  const first = await merkleRoot([one, two]);
  const second = await merkleRoot([two, one]);
  assert.equal(first, second);
  assert.match(first, /^[0-9a-f]{64}$/);
});

test("builds stable unique simulated receipts for sleep and purchase records", async () => {
  const commitment = await sha256Hex("claim-one");
  const first = await simulatedChainReceipt({
    recordId: "claim-1", commitment, createdAt: "2026-09-05T00:00:00Z", sequence: 1,
  });
  const repeat = await simulatedChainReceipt({
    recordId: "claim-1", commitment, createdAt: "2026-09-05T00:00:00Z", sequence: 1,
  });
  const next = await simulatedChainReceipt({
    recordId: "claim-2", commitment: await sha256Hex("claim-two"), createdAt: "2026-09-05T00:00:01Z", sequence: 2,
  });
  const purchase = await simulatedChainReceipt({
    recordId: "order-1", recordType: "purchase", commitment, createdAt: "2026-09-05T00:00:02Z", sequence: 10_001,
  });
  assert.deepEqual(first, repeat);
  assert.notEqual(first.transactionHash, next.transactionHash);
  assert.notEqual(first.claimHash, next.claimHash);
  assert.ok(next.blockNumber > first.blockNumber);
  assert.equal(first.kind, "simulation");
  assert.equal(purchase.recordType, "purchase");
  assert.notEqual(purchase.transactionHash, first.transactionHash);
});

test("serves the original screenshot with four accessible interactive stage targets", async () => {
  const response = await server.fetch(new Request("https://example.test/"), {});
  const html = await response.text();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store, max-age=0");
  assert.match(html, /Website v1\.1/);
  assert.match(html, /让睡眠成为可信资产/);
  assert.match(html, /更聚焦、更容易做小闭环验证/);
  assert.match(html, /<section class="card manifesto"[^>]*><strong[^>]*>Make Your Sleep Count\.<\/strong><\/section>/);
  assert.match(html, /<h2>每一分都能从睡眠数据复算<\/h2>/);
  assert.match(html, /localStorage\.removeItem\('sleepDemoAccount'\);location\.reload\(\)/);
  assert.doesNotMatch(html, /让睡眠成为可信证据，而不是新的投机资产/);
  assert.doesNotMatch(html, /不是“全面完胜”，而是/);
  assert.doesNotMatch(html, /AI 不需要睡眠，人类需要/);
  assert.doesNotMatch(html, /不是随手发 660 分：/);
  assert.match(html, /睡眠满八小时<span class="question-mark">？<\/span>/);
  assert.match(html, /id="team"/);
  assert.match(html, /team-portrait-hero-v2\.png/);
  assert.match(html, /team-portrait-frank-cutout-v3\.png/);
  assert.match(html, /team-portrait-momo-cutout-v5\.png/);
  assert.match(html, /class="team-portrait-momo-default" src="\/assets\/team\/team-portrait-momo-cutout-v5\.png"/);
  assert.match(html, /team-portrait-anne-cutout-v3\.png/);
  assert.equal(html.match(/class="team-member /g)?.length, 3);
  assert.equal(html.match(/<h1[ >]/g)?.length, 1);
  assert.ok(html.indexOf('id="opening"') < html.indexOf('id="team"'));
  assert.ok(html.indexOf('id="team"') < html.indexOf('id="project"'));
  assert.match(html, /aria-controls="team-detail"/);
  assert.match(html, /aria-describedby="team-hint"/);
  assert.match(html, /aria-live="polite" aria-atomic="true"/);
  assert.match(html, /selectTeamMember/);
  assert.match(html, /北京大学 · 集成电路专业/);
  assert.match(html, /广东外语外贸大学 · 语言学背景/);
  assert.match(html, /认知科学与社会学研究/);
  assert.match(html, /广东外语外贸大学 · 金融专业背景/);
  assert.match(html, /AI 自媒体博主/);
  const team = runInNewContext(`(${html.match(/const teamPeople=(.*);\nconst teamStage/)[1]})`, { t: zh => zh });
  assert.equal(team.frank.tags.join(","), "ENTJ,丁火男");
  assert.equal(team.anne.tags.join(","), "INFP,丙火女");
  assert.match(html, /sleep-stage-sample-a\.jpg/);
  assert.equal(html.match(/class="stage-hotspot /g)?.length, 4);
  assert.match(html, /mouseenter/);
  assert.match(html, /快速眼动：每分钟 2 分/);
  assert.match(html, /深睡：本晚每分钟 2\.926 分/);
  assert.match(html, /最终连续性系数/);
  assert.match(html, /每分钟积分/);
  assert.match(html, /积分如何兑换成人民币/);
  assert.match(html, /品牌预算兑付/);
  assert.match(html, /当前没有真实打款/);
  assert.match(html, /\/api\/demo\/cash-redemptions/);
  assert.match(html, /海外版：把睡眠积分真实铸造成 SLEEP/);
  assert.match(html, /Owner-only ERC-20 mint/);
  assert.match(html, /\/api\/demo\/token-mints/);
  assert.match(html, /SLEEP 是有上限的可转账测试代币/);
  assert.ok(html.indexOf('id="cashout"') < html.indexOf('id="tokenize"'));
  const anchorIndex = html.indexOf("真实 Monad 测试网锚点");
  const stepnIndex = html.indexOf('id="stepn"');
  const marketIndex = html.indexOf("Market opportunity · China first");
  const hardwareIndex = html.indexOf("Hardware entry · Wearables & rings");
  const mainHtml = html.match(/<main class="wrap">[\s\S]*?<\/main>/)?.[0] ?? "";
  const positioningIndex = mainHtml.indexOf("Positioning · 中国切入假设");
  const manifestoIndex = mainHtml.indexOf('<section class="card manifesto"');
  assert.ok(html.indexOf("兑换记录与唯一凭证（动态模拟）") < anchorIndex);
  assert.ok(anchorIndex < stepnIndex);
  assert.ok(stepnIndex < marketIndex);
  assert.ok(marketIndex < hardwareIndex);
  assert.ok(hardwareIndex < html.indexOf("Positioning · 中国切入假设"));
  assert.ok(positioningIndex < manifestoIndex);
  assert.equal(manifestoIndex, mainHtml.lastIndexOf("<section"));
  assert.match(html, /STEPN：爆发增长，也快速回落/);
  assert.match(html, /MOMO 的教训/);
  assert.match(html, /MOMO 的机会/);
  assert.match(html, /戒指的作用/);
  assert.doesNotMatch(html, /四个月约增长 282 倍，也能在七个月后回落 93\.6%/);
  assert.doesNotMatch(html, /中国大陆定位服务停止是加速失速的外部冲击/);
  const nav = html.match(/<nav class="nav"[^>]*>[\s\S]*?<\/nav>/)?.[0] ?? "";
  assert.ok(nav.indexOf('href="#tokenize"') < nav.indexOf('href="#stepn"'));
  assert.ok(nav.indexOf('href="#stepn"') < nav.indexOf('href="#market"'));
  assert.doesNotMatch(html, /id="(?:inspirations|history|cudis|business)"/);
  assert.doesNotMatch(html, /href="#(?:inspirations|history|cudis|business)"/);
  assert.doesNotMatch(html, /我们不是凭空发明了一个概念/);
  assert.doesNotMatch(html, /从“奖励行为”走向“为可用证据付费”/);
  assert.doesNotMatch(html, /CUDIS 验证了产品形态/);
  assert.doesNotMatch(html, /枕头厂商出研究预算/);
  assert.doesNotMatch(html, /基础分 0；1 − 6×2%/);
  assert.doesNotMatch(html, /class="stage-strip"/);

});

test("uses a continuous restored backdrop and a single layer per team member", async () => {
  const response = await server.fetch(new Request("https://example.test/"), {});
  const html = await response.text();
  const stage = html.match(/<div class="team-stage"[\s\S]*?<\/div>/)[0];
  assert.match(stage, /data-active="momo"/);
  assert.match(stage, /team-backdrop-restored-v1\.png/);
  assert.match(stage, /mask="url\(#team-original-background\)"/);
  assert.equal(stage.match(/<img /g)?.length, 3);
  assert.doesNotMatch(stage, /class="team-glow/);
  const momoImage = stage.match(/<img class="team-portrait-momo-default"[^>]*>/)[0];
  assert.match(momoImage, /team-portrait-momo-cutout-v5\.png/);
});

test("redirects the old team preview to the current section, preserving language", async () => {
  for (const query of ["", "?lang=en"]) {
    const response = await server.fetch(new Request(`https://example.test/team-preview${query}`), {});
    assert.equal(response.status, 302);
    assert.equal(response.headers.get("location"), `/${query}#team`);
  }
});
