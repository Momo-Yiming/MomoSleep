import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { decodeFunctionData, encodeAbiParameters, encodeEventTopics, getAddress, keccak256, stringToHex } from 'viem';
import server from '../src/index.mjs';
import { prepareSubmission, recoverSubmissions, settleSubmission } from '../src/chain-submission.mjs';
import { processMint, reconcileMint, reconcileMints, reserveMint, TOKEN_ABI } from '../src/token-mint.mjs';

const contract = getAddress('0x' + 'e6'.repeat(20));
const recipient = '0x' + '11'.repeat(20), otherRecipient = '0x' + '22'.repeat(20);
const policy = { contractAddress: contract, maxMints: 20 };
function environment({ beforeRecoveryMigration = false } = {}) {
  const db = new DatabaseSync(':memory:');
  for (const name of readdirSync(new URL('../migrations/', import.meta.url)).sort()) {
    if (beforeRecoveryMigration && name.startsWith('0007')) continue;
    db.exec(readFileSync(new URL('../migrations/' + name, import.meta.url), 'utf8'));
  }
  const env = { db, MONAD_CHAIN_ID: '10143', MONAD_RPC_URL: 'https://audit.invalid', MONAD_PRIVATE_KEY: '0x' + '0'.repeat(63) + '1', SLEEP_TOKEN_ADDRESS: contract, MONAD_EXPLORER_URL: 'https://testnet.monadscan.com' };
  const prepare = (sql, args = []) => ({
    bind(...values) { return prepare(sql, values); },
    async first() {
      const value = db.prepare(sql).get(...args) ?? null;
      if (env.pauseFirst?.match && sql.includes(env.pauseFirst.match)) { const pause = env.pauseFirst; env.pauseFirst = null; await pause.wait(); }
      return value;
    },
    async all() { return { results: db.prepare(sql).all(...args) }; },
    async run() {
      const fault = env.fault?.match && sql.includes(env.fault.match) ? env.fault : null;
      if (fault) env.fault = null;
      if (fault && !fault.afterCommit) throw new Error('injected D1 write failure');
      const result = db.prepare(sql).run(...args);
      if (fault) throw new Error('injected lost D1 commit response');
      return { meta: { changes: result.changes } };
    },
  });
  env.DB = { prepare, async batch(items) { db.exec('BEGIN'); try { const result = []; for (const item of items) result.push(await item.run()); db.exec('COMMIT'); return result; } catch (e) { db.exec('ROLLBACK'); throw e; } } };
  return env;
}
function seedClaim(env) {
  const accountId = 'audit-' + crypto.randomUUID(), id = crypto.randomUUID(), commitment = keccak256(stringToHex(id)).slice(2), now = new Date().toISOString();
  env.db.prepare('INSERT INTO accounts(id, created_at) VALUES (?, ?)').run(accountId, now);
  env.db.prepare("INSERT INTO claims(id, account_id, night_key, commitment, asleep_minutes, core_minutes, rem_minutes, deep_minutes, raw_points, awarded_points, trust_grade, status, created_at) VALUES (?, ?, 'disclosed-example-a', ?, 0, 250, 50, 105, 657, 390, 'SANDBOX', 'accepted', ?)").run(id, accountId, commitment, now);
  return { accountId, claim: { id, commitment, awardedPoints: 390 } };
}
const mintRow = (env, id) => env.db.prepare('SELECT * FROM token_mints WHERE id = ?').get(id);
function rpcMock() {
  const account = { address: '0x' + 'aa'.repeat(20) };
  const config = { autoConfirm: true, balance: 10n ** 18n, chainId: 10143, owner: account.address };
  const signed = new Map(), receipts = new Map(), calls = { signatures: 0, sends: [], nonces: [] };
  function receiptFor(raw, status = 'success') {
    const request = signed.get(raw), hash = keccak256(raw);
    const { args } = decodeFunctionData({ abi: TOKEN_ABI, data: request.data });
    return { status, transactionHash: hash, blockNumber: 123n, logs: status === 'success' ? [{ address: request.to, topics: encodeEventTopics({ abi: TOKEN_ABI, eventName: 'SleepRewardMinted', args: { recipient: args[0], claimCommitment: args[2] } }), data: encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }], [args[1], args[1] * 10n ** 18n]) }] : [] };
  }
  const clients = {
    account,
    client: {
      async getChainId() { return config.chainId; },
      async getTransactionCount() { return 0; },
      async getBalance() { return config.balance; },
      async readContract() { return config.owner; },
      async simulateContract() { if (config.onSimulate) await config.onSimulate(); if (config.simulateError) throw new Error('injected simulation RPC error'); return { request: {} }; },
      async getTransactionReceipt({ hash }) { if (!receipts.has(hash)) throw new Error('receipt not found'); return receipts.get(hash); },
      async waitForTransactionReceipt({ hash }) { if (!receipts.has(hash)) throw new Error('injected receipt timeout'); return receipts.get(hash); },
    },
    wallet: {
      async prepareTransactionRequest(request) { calls.nonces.push(request.nonce); return { ...request, gas: 100_000n, maxFeePerGas: 1n }; },
      async signTransaction(request) {
        calls.signatures++;
        if (config.onSign) await config.onSign();
        const raw = encodeAbiParameters([{ type: 'uint256' }, { type: 'bytes' }], [BigInt(request.nonce), request.data]);
        signed.set(raw, request); return raw;
      },
      async sendRawTransaction({ serializedTransaction: raw }) {
        calls.sends.push(raw);
        if (config.autoConfirm) receipts.set(keccak256(raw), receiptFor(raw));
        if (config.sendError) throw new Error('injected ambiguous broadcast response');
        return keccak256(raw);
      },
    },
  };
  return { clients, config, calls, signed, receipts, receiptFor };
}
async function reserve(env, seed = seedClaim(env), address = recipient, selectedPolicy = policy) {
  return reserveMint(env, { ...seed, recipient: address, policy: selectedPolicy });
}
async function post(env, path, body) {
  const response = await server.fetch(new Request('https://audit.invalid' + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }), env);
  return { status: response.status, body: await response.json() };
}

test('recipient collision is HTTP 409; only the exact confirmed account/claim/address is idempotent', async () => {
  const env = environment(), first = seedClaim(env), second = seedClaim(env);
  const { mint } = await reserve(env, first);
  env.db.prepare("UPDATE token_mints SET status = 'confirmed', transaction_hash = ? WHERE id = ?").run('0x' + 'ab'.repeat(32), mint.id);
  assert.equal((await post(env, '/api/demo/token-mints', { accountId: second.accountId, recipient })).status, 409);
  assert.equal((await post(env, '/api/demo/token-mints', { accountId: first.accountId, recipient: otherRecipient })).status, 409);
  const repeat = await post(env, '/api/demo/token-mints', { accountId: first.accountId, recipient });
  assert.equal(repeat.status, 201); assert.equal(repeat.body.tokenMints.length, 1); assert.equal(repeat.body.tokenMints[0].retryable, false);
  assert.doesNotMatch(JSON.stringify(repeat.body), /signed_transaction|attempt_id|signedTransaction/);
  assert.equal((await post(env, '/api/demo/token-mints', { accountId: second.accountId, recipient: '0x' + '0'.repeat(40) })).status, 400);
  env.db.close();
});

test('a pre-broadcast RPC failure can retry the same claim without losing or duplicating the reward', async () => {
  const env = environment(), seed = seedClaim(env), rpc = rpcMock();
  const { mint } = await reserve(env, seed); rpc.config.simulateError = true;
  await assert.rejects(processMint(env, mint, rpc.clients), error => error.status === 503);
  assert.equal(mintRow(env, mint.id).status, 'failed'); assert.equal(rpc.calls.signatures, 0); assert.equal(rpc.calls.sends.length, 0);
  const retry = await reserve(env, seed, otherRecipient); assert.equal(retry.mint.id, mint.id); assert.equal(retry.process, true);
  rpc.config.simulateError = false;
  assert.equal((await processMint(env, retry.mint, rpc.clients)).status, 'confirmed');
  assert.equal(rpc.calls.signatures, 1); assert.equal(rpc.calls.sends.length, 1);
  env.db.close();
});

test('unknown receipt keeps its quota and recovers the original hash without another signature', async () => {
  const env = environment(), seed = seedClaim(env), rpc = rpcMock(); rpc.config.autoConfirm = false;
  const { mint } = await reserve(env, seed, recipient, { ...policy, maxMints: 1 });
  const pending = await processMint(env, mint, rpc.clients);
  assert.equal(pending.status, 'submitted'); assert.ok(pending.transactionHash);
  await assert.rejects(reserve(env, seedClaim(env), otherRecipient, { ...policy, maxMints: 1 }), error => error.status === 409);
  const raw = rpc.calls.sends[0]; rpc.receipts.set(keccak256(raw), rpc.receiptFor(raw));
  await reconcileMints(env, () => rpc.clients, { accountId: seed.accountId });
  assert.equal(mintRow(env, mint.id).status, 'confirmed'); assert.equal(mintRow(env, mint.id).transaction_hash, pending.transactionHash);
  const repeat = await reserve(env, seed); assert.equal(repeat.process, false);
  await reconcileMint(env, repeat.mint, rpc.clients);
  assert.equal(rpc.calls.signatures, 1); assert.equal(rpc.calls.sends.length, 1);
  env.db.close();
});

test('an accepted broadcast with a lost RPC response is confirmed instead of failed', async () => {
  const env = environment(), rpc = rpcMock(); rpc.config.sendError = true;
  const { mint } = await reserve(env);
  assert.equal((await processMint(env, mint, rpc.clients)).status, 'confirmed');
  assert.equal(rpc.calls.signatures, 1); assert.equal(rpc.calls.sends.length, 1);
  env.db.close();
});

for (const [name, match, afterCommit] of [
  ['lost response after durable signed-transaction commit', 'INSERT INTO chain_transactions', true],
  ['business hash update fails before commit', "UPDATE token_mints SET status = 'submitted'", false],
  ['lost response after business hash commit', "UPDATE token_mints SET status = 'submitted'", true],
  ['lost response after confirmed business commit', 'UPDATE token_mints SET status = ?, block_number', true],
]) test(`recovery after ${name} never signs a replacement`, async () => {
  const env = environment(), rpc = rpcMock(), seed = seedClaim(env);
  const { mint } = await reserve(env, seed);
  env.fault = { match, afterCommit };
  await assert.rejects(processMint(env, mint, rpc.clients), error => error.status === 503);
  assert.notEqual(mintRow(env, mint.id).status, 'failed');
  const saved = env.db.prepare('SELECT * FROM chain_transactions').get(); assert.ok(saved.transaction_hash);
  const retry = await reserve(env, seed); assert.equal(retry.process, false);
  await reconcileMint(env, retry.mint, rpc.clients);
  assert.equal(mintRow(env, mint.id).status, 'confirmed'); assert.equal(mintRow(env, mint.id).transaction_hash, saved.transaction_hash);
  assert.equal(rpc.calls.signatures, 1); assert.equal(new Set(rpc.calls.sends).size, 1);
  env.db.close();
});

test('an explicit chain revert can retry with a new nonce, keeping the old attempt in the private ledger', async () => {
  const env = environment(), rpc = rpcMock(), seed = seedClaim(env); rpc.config.autoConfirm = false;
  const { mint } = await reserve(env, seed); await processMint(env, mint, rpc.clients);
  const raw = rpc.calls.sends[0]; rpc.receipts.set(keccak256(raw), rpc.receiptFor(raw, 'reverted'));
  assert.equal((await reconcileMint(env, mint, rpc.clients)).status, 'reverted');
  const retry = await reserve(env, seed); assert.equal(retry.process, true); rpc.config.autoConfirm = true;
  assert.equal((await processMint(env, retry.mint, rpc.clients)).status, 'confirmed');
  assert.deepEqual(rpc.calls.nonces, [0, 1]); assert.equal(env.db.prepare('SELECT COUNT(*) AS n FROM chain_transactions').get().n, 2);
  env.db.close();
});

test('wrong network, wrong owner and insufficient MON stop before signing and leave retryable failures', async () => {
  for (const change of [{ chainId: 143 }, { owner: '0x' + 'bb'.repeat(20) }, { balance: 0n }]) {
    const env = environment(), rpc = rpcMock(); Object.assign(rpc.config, change);
    const { mint } = await reserve(env); await assert.rejects(processMint(env, mint, rpc.clients), error => error.status === 503);
    assert.equal(mintRow(env, mint.id).status, 'failed'); assert.equal(rpc.calls.signatures, 0); assert.equal(rpc.calls.sends.length, 0);
    env.db.close();
  }
});

test('successful receipt without the exact mint event remains needs_review and consumes quota', async () => {
  const env = environment(), rpc = rpcMock(); rpc.config.autoConfirm = false;
  const { mint } = await reserve(env, undefined, recipient, { ...policy, maxMints: 1 }); await processMint(env, mint, rpc.clients);
  const raw = rpc.calls.sends[0], receipt = rpc.receiptFor(raw); receipt.logs = [];
  rpc.receipts.set(keccak256(raw), receipt);
  assert.equal((await reconcileMint(env, mint, rpc.clients)).status, 'needs_review');
  await assert.rejects(reserve(env, seedClaim(env), otherRecipient, { ...policy, maxMints: 1 }), error => error.status === 409);
  assert.equal(rpc.calls.signatures, 1); env.db.close();
});

test('mint and anchor share a durable nonce sequence even if RPC pending nonce is stale', async () => {
  const env = environment(), rpc = rpcMock();
  const call = { address: contract, abi: TOKEN_ABI, functionName: 'mintSleepReward', args: [recipient, 390n, '0x' + 'ac'.repeat(32)] };
  const mint = await prepareSubmission(env, rpc.clients, { ...call, operationKey: 'mint:fixture' });
  const repeat = await prepareSubmission(env, rpc.clients, { ...call, operationKey: 'mint:fixture' });
  const anchorABI = [{ type: 'function', name: 'anchorBatch', stateMutability: 'nonpayable', inputs: [{ type: 'bytes32', name: 'batchId' }, { type: 'bytes32', name: 'merkleRoot' }, { type: 'uint32', name: 'scoringVersion' }, { type: 'uint32', name: 'claimCount' }], outputs: [] }];
  const anchor = await prepareSubmission(env, rpc.clients, { address: contract, abi: anchorABI, functionName: 'anchorBatch', args: ['0x' + '01'.repeat(32), '0x' + '02'.repeat(32), 2, 1], operationKey: 'anchor:fixture' });
  assert.equal(mint.transaction_hash, repeat.transaction_hash); assert.deepEqual(rpc.calls.nonces, [0, 1]); assert.equal(anchor.nonce, 1); assert.equal(rpc.calls.signatures, 2);
  const ledgerBefore = env.db.prepare('SELECT COUNT(*) AS n FROM chain_transactions').get().n;
  rpc.config.autoConfirm = false;
  await settleSubmission(env, rpc.clients, anchor, { waitMs: 0 });
  const recoverAnchor = await prepareSubmission(env, rpc.clients, { ...call, operationKey: 'anchor:fixture' });
  assert.equal(recoverAnchor.transaction_hash, anchor.transaction_hash); assert.equal(rpc.calls.signatures, 2); assert.equal(env.db.prepare('SELECT COUNT(*) AS n FROM chain_transactions').get().n, ledgerBefore);
  env.db.close();
});

test('an expired signing lease cannot publish a transaction after another attempt takes over', async () => {
  const env = environment(), rpc = rpcMock(), seed = seedClaim(env);
  const { mint } = await reserve(env, seed);
  let resume, started;
  const begun = new Promise(resolve => { started = resolve; });
  rpc.config.onSign = async () => { rpc.config.onSign = null; started(); await new Promise(resolve => { resume = resolve; }); };
  const oldProcess = processMint(env, mint, rpc.clients).catch(error => error);
  await begun;
  env.db.prepare('UPDATE token_mints SET updated_at = ? WHERE id = ?').run('2020-01-01T00:00:00Z', mint.id);
  await reconcileMint(env, mint, rpc.clients, { waitMs: 0 });
  assert.equal(mintRow(env, mint.id).status, 'failed');
  const next = await reserve(env, seed, otherRecipient);
  env.db.prepare('UPDATE chain_submission_locks SET expires_at = 0').run();
  assert.equal((await processMint(env, next.mint, rpc.clients)).status, 'confirmed');
  resume(); assert.equal((await oldProcess).status, 503);
  const saved = mintRow(env, mint.id); assert.equal(saved.recipient, otherRecipient); assert.equal(saved.status, 'confirmed');
  assert.equal(rpc.calls.sends.length, 1); assert.equal(env.db.prepare('SELECT COUNT(*) AS n FROM chain_transactions').get().n, 1);
  env.db.close();
});

test('an old reconciliation cannot reattach a reverted hash to a new retry attempt', async () => {
  const env = environment(), rpc = rpcMock(), seed = seedClaim(env); rpc.config.autoConfirm = false;
  const { mint } = await reserve(env, seed); await processMint(env, mint, rpc.clients);
  let resume, started;
  const begun = new Promise(resolve => { started = resolve; });
  env.pauseFirst = { match: 'SELECT * FROM chain_transactions', async wait() { started(); await new Promise(resolve => { resume = resolve; }); } };
  const oldReconciliation = reconcileMint(env, mint, rpc.clients, { waitMs: 0 });
  await begun;
  env.db.prepare("UPDATE chain_transactions SET status = 'reverted'").run();
  env.db.prepare("UPDATE token_mints SET status = 'reverted' WHERE id = ?").run(mint.id);
  const next = await reserve(env, seed, otherRecipient);
  resume(); await oldReconciliation;
  let saved = mintRow(env, mint.id); assert.equal(saved.status, 'preparing'); assert.equal(saved.transaction_hash, null); assert.equal(saved.attempt_id, next.mint.attemptId);
  rpc.config.autoConfirm = true;
  assert.equal((await processMint(env, next.mint, rpc.clients)).status, 'confirmed');
  saved = mintRow(env, mint.id); assert.equal(saved.recipient, otherRecipient); assert.equal(new Set(rpc.calls.sends).size, 2);
  env.db.close();
});

test('shared recovery replays an unsent anchor nonce and preserves the later mint nonce', async () => {
  const env = environment(), rpc = rpcMock();
  const call = { address: contract, abi: TOKEN_ABI, functionName: 'mintSleepReward', args: [recipient, 390n, '0x' + 'ac'.repeat(32)] };
  const anchor = await prepareSubmission(env, rpc.clients, { ...call, operationKey: 'anchor:interrupted' });
  const later = await prepareSubmission(env, rpc.clients, { ...call, operationKey: 'mint:later' });
  assert.equal(rpc.calls.sends.length, 0);
  await recoverSubmissions(env, () => rpc.clients);
  assert.deepEqual(rpc.calls.sends.map(raw => rpc.signed.get(raw).nonce), [0, 1]);
  assert.equal(keccak256(rpc.calls.sends[0]), anchor.transaction_hash); assert.equal(keccak256(rpc.calls.sends[1]), later.transaction_hash);
  await recoverSubmissions(env, () => rpc.clients);
  assert.equal(rpc.calls.signatures, 2); assert.equal(new Set(rpc.calls.sends).size, 2);
  env.db.close();
});

test('legacy uncertain failures are quarantined; saved hashes remain submitted for reconciliation', () => {
  const env = environment({ beforeRecoveryMigration: true });
  for (const transactionHash of [null, '0x' + 'ef'.repeat(32)]) {
    const seed = seedClaim(env);
    env.db.prepare("INSERT INTO token_mints(id, account_id, claim_id, claim_commitment, recipient, points, token_amount_wei, status, transaction_hash, contract_address, created_at) VALUES (?, ?, ?, ?, ?, 390, ?, 'failed', ?, ?, ?)").run(crypto.randomUUID(), seed.accountId, seed.claim.id, seed.claim.commitment, transactionHash ? otherRecipient : recipient, (390n * 10n ** 18n).toString(), transactionHash, contract, new Date().toISOString());
  }
  env.db.exec(readFileSync(new URL('../migrations/0007_mint_recovery.sql', import.meta.url), 'utf8'));
  const rows = env.db.prepare('SELECT status, transaction_hash FROM token_mints').all();
  assert.equal(rows.find(row => row.transaction_hash == null).status, 'needs_review'); assert.equal(rows.find(row => row.transaction_hash).status, 'submitted');
  env.db.close();
});

test('legacy failures written during rolling deployment cannot be mistaken for safe new retries', async () => {
  const env = environment();
  for (const [address, transactionHash] of [[recipient, null], [otherRecipient, '0x' + 'ad'.repeat(32)]]) {
    const seed = seedClaim(env), { mint } = await reserve(env, seed, address);
    env.db.prepare("UPDATE token_mints SET status = 'failed', attempt_id = NULL, transaction_hash = ? WHERE id = ?").run(transactionHash, mint.id);
    const retry = await reserve(env, seed, address);
    assert.equal(retry.process, false); assert.equal(retry.mint.status, transactionHash ? 'submitted' : 'needs_review');
  }
  assert.equal(env.db.prepare('SELECT COUNT(*) AS n FROM chain_transactions').get().n, 0);
  env.db.close();
});
