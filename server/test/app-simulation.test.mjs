import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import server from "../src/index.mjs";
import { scoreSleep } from "../src/domain.mjs";
import { sleepSimulation } from "../src/sleep-simulation.mjs";

const uuid = number => `00000000-0000-4000-8000-${number.toString(16).padStart(12, "0")}`;
function environment(t) {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  for (const name of readdirSync(new URL("../migrations/", import.meta.url)).sort()) db.exec(readFileSync(new URL("../migrations/" + name, import.meta.url), "utf8"));
  const env = { db, ADMIN_TOKEN: "synthetic-admin-test-only" };
  const prepare = (sql, args = []) => ({
    bind(...values) { return prepare(sql, values); },
    async first() { return db.prepare(sql).get(...args) ?? null; },
    async all() { return { results: db.prepare(sql).all(...args) }; },
    run() { return { meta: { changes: db.prepare(sql).run(...args).changes } }; },
  });
  env.DB = { prepare, async batch(statements) {
    db.exec("BEGIN");
    try {
      const result = statements.map((statement, index) => {
        if (env.failBatchStep === index + 1) { env.failBatchStep = null; throw new Error("injected transaction fault"); }
        return statement.run();
      });
      db.exec("COMMIT");
      return result;
    } catch (error) { db.exec("ROLLBACK"); throw error; }
  } };
  return env;
}
async function request(env, path, body, headers = {}) {
  const response = await server.fetch(new Request("https://test.invalid" + path, {
    method: body ? "POST" : "GET",
    headers: { ...(body ? { "Content-Type": "application/json" } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  }), env);
  return { status: response.status, body: await response.json() };
}
const state = (env, accountId, simulationId) => request(env, `/api/demo/state?accountId=${accountId}${simulationId ? `&simulationId=${simulationId}` : ""}`);
const claim = (env, accountId, simulationId, extras = {}) => request(env, "/api/demo/claims", { accountId, profile: "simulation", simulationId, ...extras });
const exchange = (env, accountId, requestId, points = 100, extras = {}) => request(env, "/api/demo/token-exchanges", { accountId, requestId, points, ...extras });
const count = (env, table) => env.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;

test("a UUID produces stable fictional people/nights and server-calculated bounded scores", () => {
  const records = Array.from({ length: 40 }, (_, i) => sleepSimulation(uuid(i + 1)));
  assert.equal(new Set(records.map(item => item.summary.person.nameEn)).size, 5);
  assert.ok(new Set(records.map(item => item.summary.nightDate)).size > 10);
  assert.ok(new Set(records.map(item => item.score.awardedPoints)).size > 10);
  for (const item of records) {
    assert.deepEqual(sleepSimulation(item.summary.simulationId.toUpperCase()), item);
    assert.deepEqual(item.score, scoreSleep(item.input));
    assert.equal(item.summary.source, "synthetic");
    assert.equal(item.summary.status, "synthetic");
    assert.equal(item.summary.windowMinutes, item.summary.sleepMinutes + item.summary.awakeMinutes);
    assert.equal(item.summary.stageMinutes.core + item.summary.stageMinutes.rem + item.summary.stageMinutes.deep, item.summary.sleepMinutes);
    const breakdown = item.summary.scoreBreakdown;
    assert.equal(breakdown.visibleStageMinutes + breakdown.unclassifiedWindowMinutes, item.summary.windowMinutes);
    const proportions = ["core", "rem", "deep", "awake"].map(stage => item.summary.stageMinutes[stage] / breakdown.visibleStageMinutes * 100);
    assert.ok(proportions.every(Number.isFinite));
    assert.ok(Math.abs(proportions.reduce((sum, value) => sum + value, 0) - 100) < 1e-9);
    assert.ok(item.score.countedMinutes <= 480 && item.score.awardedPoints > 0 && item.score.awardedPoints <= 1440);
    assert.deepEqual(item.scoreBreakdown.summary, item.summary);
    assert.doesNotThrow(() => JSON.stringify(item));
  }
  records[0].summary.person.nameEn = "mutated";
  assert.notEqual(sleepSimulation(uuid(1)).summary.person.nameEn, "mutated");
});

test("state retains sample A and restores the selected simulation without a stored simulation table", async t => {
  const env = environment(t), accountId = uuid(100);
  const initial = await state(env, accountId);
  assert.equal(initial.status, 200);
  assert.equal(initial.body.sampleSleep.scoreBreakdown.awardedPoints, 390);
  assert.equal(initial.body.simulationSleep, null);
  assert.equal(initial.body.currentSimulationClaim, null);
  assert.deepEqual(initial.body.stats, { earnedPoints: 0, spentPoints: 0, claimedNights: 0, orderCount: 0, virtualTokenBalance: 0 });
  const selected = await state(env, accountId, uuid(101));
  assert.deepEqual(selected.body.simulationSleep, sleepSimulation(uuid(101)).summary);
  const invalid = await request(env, `/api/demo/state?accountId=${uuid(102)}&simulationId=bad`);
  assert.equal(invalid.status, 400);
  assert.equal(count(env, "accounts"), 1);
});

test("simulation claim ignores client score/input overrides and credits one stable night once", async t => {
  const env = environment(t), accountId = uuid(110), simulationId = uuid(111);
  const expected = sleepSimulation(simulationId);
  const first = await claim(env, accountId, simulationId, { points: 999999, score: { awardedPoints: 999999 }, coreMinutes: 0, status: "accepted" });
  assert.equal(first.status, 201);
  assert.equal(first.body.account.points, expected.score.awardedPoints);
  assert.equal(first.body.currentSimulationClaim.status, "simulated");
  assert.equal(first.body.currentSimulationClaim.scoreBreakdown.source, "synthetic");
  assert.deepEqual(first.body.currentSimulationClaim.scoreBreakdown.summary, first.body.simulationSleep);
  const duplicate = await claim(env, accountId, simulationId.toUpperCase());
  assert.equal(duplicate.status, 409);
  assert.equal(count(env, "claims"), 1);
  assert.equal(count(env, "point_entries"), 1);
  assert.equal((await state(env, accountId, simulationId)).body.account.points, expected.score.awardedPoints);
});

test("concurrent duplicate claims credit once while different accounts retain independent sandbox nights", async t => {
  const env = environment(t), accountId = uuid(120), simulationId = uuid(121);
  const responses = await Promise.all([claim(env, accountId, simulationId), claim(env, accountId, simulationId)]);
  assert.deepEqual(responses.map(item => item.status).sort(), [201, 409]);
  assert.equal(count(env, "claims"), 1);
  assert.equal(count(env, "point_entries"), 1);
  assert.equal((await claim(env, uuid(122), simulationId)).status, 201);
  assert.equal(count(env, "claims"), 2);
});

test("a failed claim transaction rolls back both the night and reward", async t => {
  const env = environment(t), accountId = uuid(130), simulationId = uuid(131);
  t.mock.method(console, "error", () => {});
  env.failBatchStep = 3;
  assert.equal((await claim(env, accountId, simulationId)).status, 500);
  assert.equal(count(env, "claims"), 0);
  assert.equal((await state(env, accountId)).body.account.points, 0);
  assert.equal((await claim(env, accountId, simulationId)).status, 201);
});

test("selected old nights and all-time statistics stay correct beyond recent-history limits", async t => {
  const env = environment(t), accountId = uuid(140);
  const original = await request(env, "/api/demo/claims", { accountId, profile: "screenshot" });
  env.db.prepare("UPDATE claims SET created_at = '2026-08-01T00:00:00Z' WHERE id = ?").run(original.body.currentClaim.id);
  let total = 390;
  for (let i = 1; i <= 25; i++) {
    const result = await claim(env, accountId, uuid(200 + i));
    assert.equal(result.status, 201);
    total += result.body.currentSimulationClaim.awardedPoints;
    env.db.prepare("UPDATE claims SET created_at = ? WHERE id = ?").run(new Date(Date.UTC(2026, 9, i)).toISOString(), result.body.currentSimulationClaim.id);
  }
  const result = await state(env, accountId, uuid(201));
  assert.equal(result.body.claims.length, 20);
  assert.ok(!result.body.claims.some(item => item.nightKey === `simulation-${uuid(201)}`));
  assert.equal(result.body.currentSimulationClaim.nightKey, `simulation-${uuid(201)}`);
  assert.equal(result.body.stats.claimedNights, 26);
  assert.equal(result.body.stats.earnedPoints, total);
  assert.equal(result.body.account.points, total);
  assert.equal(result.body.currentClaim.id, result.body.currentSimulationClaim.id);
  const sample = await state(env, accountId);
  assert.ok(!sample.body.claims.some(item => item.nightKey === "disclosed-example-a"));
  assert.equal(sample.body.currentClaim.id, original.body.currentClaim.id);
  assert.equal(sample.body.currentSimulationClaim, null);
  assert.equal((await request(env, "/api/demo/claims", { accountId, profile: "screenshot" })).status, 409);
});

test("synthetic nights cannot enter live minting or admin batches, even if their status is mislabeled", async t => {
  const env = environment(t), accountId = uuid(150), simulationId = uuid(151);
  await claim(env, accountId, simulationId);
  env.SLEEP_TOKEN_ADDRESS = "0x" + "11".repeat(20);
  env.MONAD_PRIVATE_KEY = "0x" + "0".repeat(63) + "1";
  env.db.prepare("UPDATE claims SET status = 'accepted'").run();
  const mint = await request(env, "/api/demo/token-mints", { accountId, recipient: "0x" + "22".repeat(20) });
  assert.equal(mint.status, 409);
  assert.equal((await request(env, "/api/demo/token-mints", { accountId, simulationId, recipient: "0x" + "22".repeat(20) })).status, 409);
  assert.equal(count(env, "token_mints"), 0);
  const headers = { Authorization: `Bearer ${env.ADMIN_TOKEN}` };
  assert.equal((await request(env, "/api/admin/batches/prepare", {}, headers)).status, 409);
  assert.equal(count(env, "anchor_batches"), 0);
  assert.equal((await request(env, "/api/demo/claims", { accountId, profile: "screenshot" })).status, 201);
  const batch = await request(env, "/api/admin/batches/prepare", {}, headers);
  assert.equal(batch.status, 201);
  assert.equal(batch.body.claimCount, 1);
  assert.equal(env.db.prepare("SELECT batch_id FROM claims WHERE night_key = ?").get(`simulation-${simulationId}`).batch_id, null);
});

test("virtual exchange deducts sandbox points once and records separate virtual SLEEP", async t => {
  const env = environment(t), accountId = uuid(160), simulationId = uuid(161), requestId = uuid(162);
  const awarded = (await claim(env, accountId, simulationId)).body.account.points;
  const first = await exchange(env, accountId, requestId, 100, { simulationId });
  const replay = await exchange(env, accountId, requestId.toUpperCase(), 100, { simulationId });
  assert.equal(first.status, 201);
  assert.equal(replay.status, 201);
  assert.equal(replay.body.account.points, awarded - 100);
  assert.equal(replay.body.stats.virtualTokenBalance, 100);
  assert.equal(replay.body.stats.spentPoints, 100);
  assert.deepEqual(replay.body.tokenExchanges, first.body.tokenExchanges);
  assert.equal(replay.body.tokenExchanges[0].status, "sandbox_completed");
  assert.equal(replay.body.tokenExchanges[0].tokenAmount, 100);
  assert.equal(replay.body.tokenExchangePolicy.onchain, false);
  assert.equal(replay.body.simulationSleep.simulationId, simulationId);
  assert.equal(count(env, "token_mints"), 0);
  assert.equal(count(env, "chain_transactions"), 0);
});

test("concurrent virtual-token retries cannot double-debit or double-credit", async t => {
  const env = environment(t), accountId = uuid(170), requestId = uuid(171);
  await request(env, "/api/demo/claims", { accountId, profile: "screenshot" });
  const result = await Promise.all([exchange(env, accountId, requestId), exchange(env, accountId, requestId)]);
  assert.deepEqual(result.map(item => item.status), [201, 201]);
  const latest = (await state(env, accountId)).body;
  assert.equal(latest.account.points, 290);
  assert.equal(latest.stats.virtualTokenBalance, 100);
  assert.equal(count(env, "sandbox_token_exchanges"), 1);
});

test("concurrent cross-account token collisions cannot debit or expose the losing account", async t => {
  const env = environment(t), firstId = uuid(175), secondId = uuid(176), requestId = uuid(177);
  for (const accountId of [firstId, secondId]) await request(env, "/api/demo/claims", { accountId, profile: "screenshot" });
  const responses = await Promise.all([exchange(env, firstId, requestId), exchange(env, secondId, requestId)]);
  assert.deepEqual(responses.map(item => item.status).sort(), [201, 409]);
  assert.deepEqual(Object.keys(responses.find(item => item.status === 409).body), ["error"]);
  const states = await Promise.all([state(env, firstId), state(env, secondId)]);
  assert.deepEqual(states.map(item => item.body.account.points).sort((a, b) => a - b), [290, 390]);
  assert.equal(states.reduce((sum, item) => sum + item.body.stats.virtualTokenBalance, 0), 100);
  assert.equal(count(env, "sandbox_token_exchanges"), 1);
});

test("virtual-token request identity prevents different amounts, cross-account reuse, and order collisions", async t => {
  const env = environment(t), accountId = uuid(180), otherId = uuid(181), requestId = uuid(182);
  for (const id of [accountId, otherId]) await request(env, "/api/demo/claims", { accountId: id, profile: "screenshot" });
  await exchange(env, accountId, requestId);
  assert.equal((await exchange(env, accountId, requestId, 101)).status, 409);
  assert.equal((await exchange(env, otherId, requestId)).status, 409);
  assert.equal((await state(env, otherId)).body.account.points, 390);
  assert.equal((await request(env, "/api/demo/orders", { accountId, productId: "sleep-mask", requestId })).status, 409);
  const orderId = uuid(183);
  assert.equal((await request(env, "/api/demo/orders", { accountId, productId: "sleep-mask", requestId: orderId })).status, 201);
  assert.equal((await exchange(env, accountId, orderId, 1)).status, 409);
  const latest = (await state(env, accountId)).body;
  assert.equal(latest.account.points, 110);
  assert.equal(latest.stats.spentPoints, 280);
  assert.equal(latest.stats.orderCount, 1);
  assert.equal(latest.stats.virtualTokenBalance, 100);
});

test("invalid virtual-token amounts and IDs are rejected; insufficient attempts reserve nothing", async t => {
  const env = environment(t), accountId = uuid(190), requestId = uuid(191);
  for (const points of [0, -1, 10001, 1.5, "100", null]) assert.equal((await exchange(env, accountId, requestId, points)).status, 400);
  assert.equal((await exchange(env, accountId, "bad", 1)).status, 400);
  assert.equal((await exchange(env, accountId, requestId)).status, 409);
  assert.equal(count(env, "sandbox_token_exchanges"), 0);
  await request(env, "/api/demo/claims", { accountId, profile: "screenshot" });
  assert.equal((await exchange(env, accountId, requestId)).status, 201);
});

test("virtual-token ledger faults roll back the exchange and balance together", async t => {
  const env = environment(t), accountId = uuid(300), requestId = uuid(301);
  t.mock.method(console, "error", () => {});
  await request(env, "/api/demo/claims", { accountId, profile: "screenshot" });
  env.failBatchStep = 3;
  assert.equal((await exchange(env, accountId, requestId)).status, 500);
  const failed = (await state(env, accountId)).body;
  assert.equal(failed.account.points, 390);
  assert.equal(failed.stats.virtualTokenBalance, 0);
  assert.equal(count(env, "sandbox_token_exchanges"), 0);
  assert.equal((await exchange(env, accountId, requestId)).status, 201);
});

test("cash cancellation is owner-scoped, idempotent and frees only the pending application slot", async t => {
  const env = environment(t), accountId = uuid(310), otherId = uuid(311);
  await request(env, "/api/demo/claims", { accountId, profile: "screenshot" });
  const created = await request(env, "/api/demo/cash-redemptions", { accountId, points: 200 });
  assert.equal(created.status, 201);
  const requestId = created.body.cashRedemptions[0].id;
  assert.equal(created.body.account.points, 390);
  assert.equal((await request(env, "/api/demo/cash-redemptions/cancel", { accountId: otherId, requestId })).status, 404);
  assert.equal((await request(env, "/api/demo/cash-redemptions", { accountId, points: 100 })).status, 409);
  for (let i = 0; i < 2; i++) {
    const cancelled = await request(env, "/api/demo/cash-redemptions/cancel", { accountId, requestId });
    assert.equal(cancelled.status, 200);
    assert.equal(cancelled.body.cashRedemptions[0].status, "cancelled");
    assert.equal(cancelled.body.account.points, 390);
  }
  const next = await request(env, "/api/demo/cash-redemptions", { accountId, points: 100 });
  assert.equal(next.status, 201);
  assert.equal(next.body.cashRedemptions.length, 2);
  assert.equal(next.body.cashPolicy.payoutEnabled, false);
  assert.equal(next.body.account.points, 390);
});

test("reset clears virtual balances with the sandbox without altering chain ledgers", async t => {
  const env = environment(t), accountId = uuid(320);
  await claim(env, accountId, uuid(321));
  await exchange(env, accountId, uuid(322), 1);
  const reset = await request(env, "/api/demo/reset", { accountId });
  assert.equal(reset.status, 200);
  assert.equal(reset.body.account.points, 0);
  assert.deepEqual(reset.body.stats, { earnedPoints: 0, spentPoints: 0, claimedNights: 0, orderCount: 0, virtualTokenBalance: 0 });
  assert.equal(count(env, "token_mints"), 0);
  assert.equal(count(env, "chain_transactions"), 0);
});
