import { encodeFunctionData, keccak256 } from 'viem';

export class MintHTTPError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export const submissionFor = (env, operationKey) => env.DB.prepare(
  "SELECT * FROM chain_transactions WHERE operation_key = ? AND status != 'reverted' ORDER BY created_at DESC LIMIT 1",
).bind(operationKey).first();

// Both minting and batch anchoring share this durable nonce reservation. A
// signed transaction is persisted before any broadcast; retries reuse it.
export async function prepareSubmission(env, clients, call) {
  let existing = await submissionFor(env, call.operationKey);
  if (existing) return existing;
  const sender = clients.account.address.toLowerCase();
  const chainId = Number(env.MONAD_CHAIN_ID ?? 10143);
  const name = `${chainId}:${sender}`;
  const holder = crypto.randomUUID();
  const now = Date.now();
  const lease = await env.DB.prepare(
    'INSERT INTO chain_submission_locks(name, holder, expires_at) VALUES (?, ?, ?) ON CONFLICT(name) DO UPDATE SET holder = excluded.holder, expires_at = excluded.expires_at WHERE expires_at <= ? RETURNING holder',
  ).bind(name, holder, now + 90_000, now).first();
  if (lease?.holder !== holder) throw new MintHTTPError(503, '测试网签名队列忙，请稍后重试。');
  try {
    existing = await submissionFor(env, call.operationKey);
    if (existing) return existing;
    if (chainId !== 10143 || await clients.client.getChainId() !== chainId) throw new MintHTTPError(503, 'RPC 网络不匹配，已停止签名；当前只支持 Monad Testnet 10143。');
    const pending = await clients.client.getTransactionCount({ address: clients.account.address, blockTag: 'pending' });
    const reserved = await env.DB.prepare('SELECT MAX(nonce) AS nonce FROM chain_transactions WHERE chain_id = ? AND sender = ?').bind(chainId, sender).first();
    const nonce = Math.max(pending, reserved?.nonce == null ? 0 : Number(reserved.nonce) + 1);
    const request = await clients.wallet.prepareTransactionRequest({
      account: clients.account, to: call.address, nonce,
      data: encodeFunctionData({ abi: call.abi, functionName: call.functionName, args: call.args }),
    });
    const fee = request.maxFeePerGas ?? request.gasPrice;
    if (request.gas == null || fee == null) throw new MintHTTPError(503, '无法取得测试网 gas 报价，请稍后重试。');
    if (await clients.client.getBalance({ address: clients.account.address }) < request.gas * fee + (request.value ?? 0n)) throw new MintHTTPError(503, '服务器测试网 MON 余额不足，尚未发送交易。');
    const signedTransaction = await clients.wallet.signTransaction(request);
    const transactionHash = keccak256(signedTransaction);
    const timestamp = new Date().toISOString();
    const id = crypto.randomUUID();
    const inserted = await env.DB.prepare(
      `INSERT INTO chain_transactions(id, operation_key, chain_id, sender, nonce, transaction_hash, signed_transaction, status, created_at, updated_at) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM chain_submission_locks WHERE name = ? AND holder = ? AND expires_at > ?)${call.mintGuard ? " AND EXISTS (SELECT 1 FROM token_mints WHERE id = ? AND attempt_id = ? AND status = 'preparing' AND recipient = ? AND claim_commitment = ? AND contract_address = ? AND points = ?)" : ''}`,
    ).bind(id, call.operationKey, chainId, sender, nonce, transactionHash, signedTransaction, 'submitted', timestamp, timestamp, name, holder, Date.now(), ...(call.mintGuard ? [call.mintGuard.id, call.mintGuard.attemptId, call.mintGuard.recipient, call.mintGuard.claimCommitment, call.mintGuard.contractAddress, call.mintGuard.points] : [])).run();
    if (Number(inserted.meta?.changes ?? 0) !== 1) throw new MintHTTPError(503, '签名队列租约已过期，请重试；尚未广播交易。');
    return submissionFor(env, call.operationKey);
  } finally {
    await env.DB.prepare('DELETE FROM chain_submission_locks WHERE name = ? AND holder = ?').bind(name, holder).run();
  }
}

export async function settleSubmission(env, clients, submission, { broadcast = true, waitMs = 8_000 } = {}) {
  let receipt;
  try { receipt = await clients.client.getTransactionReceipt({ hash: submission.transaction_hash }); } catch {}
  if (!receipt && broadcast && submission.signed_transaction) {
    // Lost responses and "already known" errors are not proof of failure.
    // Sending identical signed bytes cannot create a second transaction.
    try { await clients.wallet.sendRawTransaction({ serializedTransaction: submission.signed_transaction }); } catch {}
  }
  if (!receipt && waitMs > 0) {
    try { receipt = await clients.client.waitForTransactionReceipt({ hash: submission.transaction_hash, timeout: waitMs, pollingInterval: 1_000, retryCount: 0 }); } catch {}
  }
  if (receipt) {
    await env.DB.prepare('UPDATE chain_transactions SET status = ?, updated_at = ? WHERE transaction_hash = ?')
      .bind(receipt.status === 'success' ? 'confirmed' : 'reverted', new Date().toISOString(), submission.transaction_hash).run();
  }
  return receipt ?? null;
}

export async function recoverSubmissions(env, clientFactory, { limit = 20 } = {}) {
  const rows = (await env.DB.prepare("SELECT * FROM chain_transactions WHERE status = 'submitted' ORDER BY chain_id, sender, nonce LIMIT ?").bind(limit).all()).results;
  if (!rows.length) return;
  const clients = clientFactory(env);
  for (const row of rows) {
    try { await settleSubmission(env, clients, row, { waitMs: 0 }); } catch { console.error('Saved transaction recovery pending', row.id); }
  }
}
