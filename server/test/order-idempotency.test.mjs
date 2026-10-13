import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import server from "../src/index.mjs";

function environment(t) {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  for (const name of readdirSync(new URL("../migrations/", import.meta.url)).sort()) {
    db.exec(readFileSync(new URL("../migrations/" + name, import.meta.url), "utf8"));
  }
  const env = { db, batches: 0 };
  const prepare = (sql, args = []) => ({
    bind(...values) { return prepare(sql, values); },
    async first() { return db.prepare(sql).get(...args) ?? null; },
    async all() { return { results: db.prepare(sql).all(...args) }; },
    run() { return { meta: { changes: db.prepare(sql).run(...args).changes } }; },
  });
  env.DB = {
    prepare,
    async batch(statements) {
      env.batches++;
      db.exec("BEGIN");
      try {
        const results = statements.map((statement, index) => {
          if (env.failBatchStep === index + 1) {
            env.failBatchStep = null;
            throw new Error("injected batch failure");
          }
          return statement.run();
        });
        db.exec("COMMIT");
        return results;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
  };
  return env;
}

function account(env, points = 390) {
  const id = "order-test-" + crypto.randomUUID();
  env.db.prepare("INSERT INTO accounts (id, points, created_at) VALUES (?, ?, ?)").run(id, points, new Date().toISOString());
  return id;
}
async function order(env, accountId, requestId, productId = "sleep-mask") {
  const response = await server.fetch(new Request("https://test.invalid/api/demo/orders", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ accountId, productId, requestId }),
  }), env);
  return { status: response.status, body: await response.json() };
}
const balance = (env, id) => env.db.prepare("SELECT points FROM accounts WHERE id = ?").get(id).points;
const count = (env, table) => env.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count;

test("replaying a committed request retains one order, one debit, and its original receipt", async t => {
  const env = environment(t), accountId = account(env), requestId = crypto.randomUUID();
  const first = await order(env, accountId, requestId);
  // A retry must still return the committed order after availability changes.
  env.db.prepare("UPDATE products SET stock = 0 WHERE id = 'sleep-mask'").run();
  const replay = await order(env, accountId, requestId);
  assert.equal(first.status, 201);
  assert.equal(replay.status, 201);
  assert.equal(balance(env, accountId), 210);
  assert.equal(count(env, "orders"), 1);
  assert.equal(count(env, "point_entries"), 1);
  assert.deepEqual(replay.body.orders, first.body.orders);
  assert.equal(replay.body.orders[0].id, requestId);
});

test("concurrent identical requests use the transaction guard to debit once", async t => {
  const env = environment(t), accountId = account(env), requestId = crypto.randomUUID();
  const responses = await Promise.all([order(env, accountId, requestId), order(env, accountId, requestId)]);
  assert.deepEqual(responses.map(response => response.status), [201, 201]);
  assert.equal(env.batches, 2, "both requests reached the batch after their initial absent-order reads");
  assert.equal(balance(env, accountId), 210);
  assert.equal(count(env, "orders"), 1);
  assert.equal(count(env, "point_entries"), 1);
});

test("a request ID cannot be reused for another product", async t => {
  const env = environment(t), accountId = account(env, 1000), requestId = crypto.randomUUID();
  await order(env, accountId, requestId);
  const response = await order(env, accountId, requestId, "white-noise");
  assert.equal(response.status, 409);
  assert.deepEqual(Object.keys(response.body), ["error"]);
  assert.equal(balance(env, accountId), 820);
  assert.equal(count(env, "orders"), 1);
  assert.equal(count(env, "point_entries"), 1);
});

test("cross-account request collision exposes no order and changes neither account", async t => {
  const env = environment(t), owner = account(env), other = account(env), requestId = crypto.randomUUID();
  await order(env, owner, requestId);
  const response = await order(env, other, requestId);
  assert.equal(response.status, 409);
  assert.deepEqual(Object.keys(response.body), ["error"]);
  assert.equal(balance(env, owner), 210);
  assert.equal(balance(env, other), 390);
  assert.equal(count(env, "orders"), 1);
  assert.equal(count(env, "point_entries"), 1);
});

test("concurrent cross-account collisions cannot debit the losing account", async t => {
  const env = environment(t), accounts = [account(env), account(env)], requestId = crypto.randomUUID();
  const responses = await Promise.all(accounts.map(id => order(env, id, requestId)));
  assert.deepEqual(responses.map(response => response.status).sort(), [201, 409]);
  assert.equal(env.batches, 2);
  const owner = env.db.prepare("SELECT account_id FROM orders WHERE id = ?").get(requestId).account_id;
  for (const id of accounts) assert.equal(balance(env, id), id === owner ? 210 : 390);
  assert.deepEqual(Object.keys(responses.find(response => response.status === 409).body), ["error"]);
  assert.equal(count(env, "orders"), 1);
  assert.equal(count(env, "point_entries"), 1);
});

test("an insufficient request reserves nothing and can succeed later with the same ID", async t => {
  const env = environment(t), accountId = account(env, 0), requestId = crypto.randomUUID();
  assert.equal((await order(env, accountId, requestId)).status, 409);
  assert.equal(count(env, "orders"), 0);
  assert.equal(count(env, "point_entries"), 0);
  env.db.prepare("UPDATE accounts SET points = 390 WHERE id = ?").run(accountId);
  assert.equal((await order(env, accountId, requestId)).status, 201);
  assert.equal(balance(env, accountId), 210);
});

test("a failure in the ledger insert rolls back the order and debit together", async t => {
  t.mock.method(console, "error", () => {});
  const env = environment(t), accountId = account(env), requestId = crypto.randomUUID();
  env.failBatchStep = 3;
  assert.equal((await order(env, accountId, requestId)).status, 500);
  assert.equal(balance(env, accountId), 390);
  assert.equal(count(env, "orders"), 0);
  assert.equal(count(env, "point_entries"), 0);
  assert.equal((await order(env, accountId, requestId)).status, 201);
  assert.equal(balance(env, accountId), 210);
});

test("request IDs cannot collide with an existing sleep-reward ledger reference", async t => {
  const env = environment(t), accountId = account(env), requestId = crypto.randomUUID();
  env.db.prepare("INSERT INTO point_entries (id, account_id, points, kind, reference_id, note, created_at) VALUES (?, ?, 390, 'sleep_reward', ?, 'test reward', ?)").run(crypto.randomUUID(), accountId, requestId, new Date().toISOString());
  assert.equal((await order(env, accountId, requestId)).status, 409);
  assert.equal(balance(env, accountId), 390);
  assert.equal(count(env, "orders"), 0);
  assert.equal(count(env, "point_entries"), 1);
});

test("legacy clients without request IDs keep creating separate redemptions", async t => {
  const env = environment(t), accountId = account(env, 1000);
  const first = await order(env, accountId);
  const second = await order(env, accountId);
  assert.equal(first.status, 201);
  assert.equal(second.status, 201);
  assert.equal(new Set(second.body.orders.map(item => item.id)).size, 2);
  assert.equal(balance(env, accountId), 640);
  assert.equal(count(env, "point_entries"), 2);
});

test("malformed explicit request IDs are rejected before any debit", async t => {
  const env = environment(t), accountId = account(env);
  for (const requestId of [null, "short", "unsafe/path", 42, []]) {
    assert.equal((await order(env, accountId, requestId)).status, 400);
  }
  assert.equal(balance(env, accountId), 390);
  assert.equal(count(env, "orders"), 0);
});
