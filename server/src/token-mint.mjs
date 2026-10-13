import { parseEventLogs } from 'viem';
import { MintHTTPError, prepareSubmission, settleSubmission, submissionFor } from './chain-submission.mjs';

export const TOKEN_ABI = [
  { type: 'function', name: 'owner', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'address' }] },
  { type: 'function', name: 'mintSleepReward', stateMutability: 'nonpayable', inputs: [{ name: 'recipient', type: 'address' }, { name: 'points', type: 'uint256' }, { name: 'claimCommitment', type: 'bytes32' }], outputs: [{ name: 'amount', type: 'uint256' }] },
  { type: 'event', name: 'SleepRewardMinted', inputs: [{ name: 'recipient', type: 'address', indexed: true }, { name: 'claimCommitment', type: 'bytes32', indexed: true }, { name: 'points', type: 'uint256', indexed: false }, { name: 'tokenAmount', type: 'uint256', indexed: false }] },
];
const rowSQL = 'SELECT id, account_id AS accountId, claim_id AS claimId, claim_commitment AS claimCommitment, recipient, points, status, transaction_hash AS transactionHash, contract_address AS contractAddress, updated_at AS updatedAt, attempt_id AS attemptId FROM token_mints';
const readMint = (env, id) => env.DB.prepare(`${rowSQL} WHERE id = ?`).bind(id).first();
const activeCount = "SELECT COUNT(*) FROM token_mints WHERE status NOT IN ('failed', 'reverted')";

export async function reserveMint(env, { accountId, claim, recipient, policy }) {
  const matches = (await env.DB.prepare(`${rowSQL} WHERE claim_commitment = ? OR recipient = ?`).bind(claim.commitment, recipient).all()).results;
  const same = matches.find(row => row.accountId === accountId && row.claimId === claim.id && row.claimCommitment === claim.commitment);
  if (matches.some(row => row.recipient === recipient && row.id !== same?.id)) throw new MintHTTPError(409, '该收款地址已用于另一份睡眠凭证，请使用新的地址。');
  const now = new Date().toISOString(), attemptId = crypto.randomUUID();
  if (same) {
    // Old Workers may still write during a rolling deployment after migration.
    // Their failures are not known to precede broadcast; quarantine them too.
    if (same.status === 'failed' && (same.transactionHash || !same.attemptId)) {
      await env.DB.prepare("UPDATE token_mints SET status = ?, updated_at = ?, error_message = ? WHERE id = ? AND status = 'failed'")
        .bind(same.transactionHash ? 'submitted' : 'needs_review', now, '旧版本交易结果待核对，尚未生成新的交易。', same.id).run();
      if (same.recipient !== recipient) throw new MintHTTPError(409, '这份睡眠凭证已绑定其他收款地址。');
      return { mint: await readMint(env, same.id), process: false };
    }
    const retryable = ['failed', 'reverted'].includes(same.status);
    if (same.recipient !== recipient && !retryable) throw new MintHTTPError(409, '这份睡眠凭证已绑定其他收款地址。');
    const stale = same.status === 'preparing' && same.attemptId && Date.parse(same.updatedAt) < Date.now() - 120_000;
    if (!retryable && !stale) return { mint: same, process: false };
    const result = await env.DB.prepare(
      `UPDATE token_mints SET recipient = ?, status = 'preparing', transaction_hash = NULL, block_number = NULL, confirmed_at = NULL, error_message = NULL, updated_at = ?, attempt_id = ? WHERE id = ? AND (status IN ('failed', 'reverted') OR (status = 'preparing' AND updated_at = ?)) AND (SELECT COUNT(*) FROM token_mints WHERE id != ? AND status NOT IN ('failed', 'reverted')) < ? AND NOT EXISTS (SELECT 1 FROM chain_transactions WHERE operation_key = ? AND status != 'reverted')`,
    ).bind(recipient, now, attemptId, same.id, same.updatedAt, same.id, policy.maxMints, `mint:${same.id}`).run();
    if (Number(result.meta?.changes ?? 0) !== 1) {
      const latest = await readMint(env, same.id);
      if (latest.status !== 'failed' && latest.status !== 'reverted') return { mint: latest, process: false };
      throw new MintHTTPError(409, `公开演示已达到 ${policy.maxMints} 笔上限`);
    }
    return { mint: await readMint(env, same.id), process: true };
  }
  const id = crypto.randomUUID();
  const inserted = await env.DB.prepare(
    `INSERT INTO token_mints(id, account_id, claim_id, claim_commitment, recipient, points, token_amount_wei, status, contract_address, created_at, updated_at, attempt_id) SELECT ?, ?, ?, ?, ?, ?, ?, 'preparing', ?, ?, ?, ? WHERE (${activeCount}) < ? AND NOT EXISTS (SELECT 1 FROM token_mints WHERE claim_commitment = ? OR recipient = ?)`,
  ).bind(id, accountId, claim.id, claim.commitment, recipient, claim.awardedPoints, (BigInt(claim.awardedPoints) * 10n ** 18n).toString(), policy.contractAddress, now, now, attemptId, policy.maxMints, claim.commitment, recipient).run();
  if (Number(inserted.meta?.changes ?? 0) !== 1) {
    // A competing request may have won after our initial read. Resolve its
    // identity precisely instead of treating another person's mint as success.
    const latest = (await env.DB.prepare(`${rowSQL} WHERE claim_commitment = ? OR recipient = ?`).bind(claim.commitment, recipient).all()).results;
    const exact = latest.find(row => row.accountId === accountId && row.claimId === claim.id && row.claimCommitment === claim.commitment && row.recipient === recipient);
    if (exact) return { mint: exact, process: false };
    throw new MintHTTPError(409, latest.length ? '该睡眠凭证或收款地址已经提交过铸币' : `公开演示已达到 ${policy.maxMints} 笔上限`);
  }
  return { mint: await readMint(env, id), process: true };
}

export async function reconcileMint(env, mint, clients, options = {}) {
  mint = await readMint(env, mint.id);
  if (mint.status === 'confirmed' || mint.status === 'reverted') return mint;
  const operationKey = `mint:${mint.id}`;
  let submission = await submissionFor(env, operationKey);
  if (!submission && mint.transactionHash) submission = { transaction_hash: mint.transactionHash };
  if (!submission) {
    if (mint.status === 'preparing' && mint.attemptId && Date.parse(mint.updatedAt) < Date.now() - 120_000) {
      await env.DB.prepare("UPDATE token_mints SET status = 'failed', error_message = ?, updated_at = ? WHERE id = ? AND attempt_id = ? AND transaction_hash IS NULL AND NOT EXISTS (SELECT 1 FROM chain_transactions WHERE operation_key = ? AND status != 'reverted')")
        .bind('广播前处理已中断，可以安全重试。', new Date().toISOString(), mint.id, mint.attemptId, operationKey).run();
    }
    return readMint(env, mint.id);
  }
  const adopted = await env.DB.prepare("UPDATE token_mints SET status = 'submitted', transaction_hash = ?, updated_at = ? WHERE id = ? AND status != 'confirmed' AND (transaction_hash IS NULL OR transaction_hash = ?) AND attempt_id IS ?")
    .bind(submission.transaction_hash, new Date().toISOString(), mint.id, submission.transaction_hash, mint.attemptId).run();
  if (Number(adopted.meta?.changes ?? 0) !== 1) return readMint(env, mint.id);
  const receipt = await settleSubmission(env, clients, submission, options);
  if (!receipt) {
    await env.DB.prepare('UPDATE token_mints SET error_message = ? WHERE id = ? AND status = ? AND transaction_hash = ?').bind('等待测试网确认；刷新会恢复同一交易，不会重复铸币。', mint.id, 'submitted', submission.transaction_hash).run();
    return readMint(env, mint.id);
  }
  if (receipt.status === 'reverted') {
    await env.DB.prepare("UPDATE token_mints SET status = 'reverted', error_message = ?, block_number = ?, updated_at = ? WHERE id = ? AND transaction_hash = ?")
      .bind('交易已明确回滚，可以重试。', Number(receipt.blockNumber), new Date().toISOString(), mint.id, submission.transaction_hash).run();
    return readMint(env, mint.id);
  }
  const matching = parseEventLogs({ abi: TOKEN_ABI, eventName: 'SleepRewardMinted', logs: receipt.logs ?? [], strict: false }).some(log =>
    log.address.toLowerCase() === mint.contractAddress.toLowerCase() && log.args.recipient?.toLowerCase() === mint.recipient.toLowerCase()
    && log.args.claimCommitment?.toLowerCase() === `0x${mint.claimCommitment}`.toLowerCase()
    && log.args.points === BigInt(mint.points) && log.args.tokenAmount === BigInt(mint.points) * 10n ** 18n);
  await env.DB.prepare('UPDATE token_mints SET status = ?, block_number = ?, confirmed_at = ?, updated_at = ?, error_message = ? WHERE id = ? AND transaction_hash = ?')
    .bind(matching ? 'confirmed' : 'needs_review', Number(receipt.blockNumber), matching ? new Date().toISOString() : null, new Date().toISOString(), matching ? null : '交易已确认但铸币事件不匹配，需要人工核查。', mint.id, submission.transaction_hash).run();
  return readMint(env, mint.id);
}

export async function processMint(env, mint, clients) {
  try {
    if (Number(env.MONAD_CHAIN_ID ?? 10143) !== 10143 || await clients.client.getChainId() !== 10143) throw new MintHTTPError(503, 'RPC 网络不匹配，已停止铸币；需要 Monad Testnet 10143。');
    const owner = await clients.client.readContract({ address: mint.contractAddress, abi: TOKEN_ABI, functionName: 'owner' });
    if (owner.toLowerCase() !== clients.account.address.toLowerCase()) throw new MintHTTPError(503, '服务器签名地址不是合约 owner，已停止铸币。');
    await clients.client.simulateContract({ account: clients.account, address: mint.contractAddress, abi: TOKEN_ABI, functionName: 'mintSleepReward', args: [mint.recipient, BigInt(mint.points), `0x${mint.claimCommitment}`] });
    await prepareSubmission(env, clients, { operationKey: `mint:${mint.id}`, address: mint.contractAddress, abi: TOKEN_ABI, functionName: 'mintSleepReward', args: [mint.recipient, BigInt(mint.points), `0x${mint.claimCommitment}`], mintGuard: mint });
    return await reconcileMint(env, await readMint(env, mint.id), clients);
  } catch (error) {
    // This conditional also protects an ambiguous D1 commit response: a saved
    // signed transaction must never be released as a pre-broadcast failure.
    await env.DB.prepare("UPDATE token_mints SET status = 'failed', error_message = ?, updated_at = ? WHERE id = ? AND attempt_id = ? AND transaction_hash IS NULL AND NOT EXISTS (SELECT 1 FROM chain_transactions WHERE operation_key = ? AND status != 'reverted')")
      .bind('广播前检查或签名未完成，可以安全重试。', new Date().toISOString(), mint.id, mint.attemptId, `mint:${mint.id}`).run();
    throw new MintHTTPError(503, error instanceof MintHTTPError ? error.message : '测试网处理暂时不可用，请刷新状态后重试。');
  }
}

export async function reconcileMints(env, clientFactory, { accountId, limit = 5, waitMs = 0 } = {}) {
  const rows = (await env.DB.prepare(`${rowSQL} WHERE (status IN ('preparing', 'submitted') OR (status = 'needs_review' AND transaction_hash IS NOT NULL))${accountId ? ' AND account_id = ?' : ''} ORDER BY updated_at LIMIT ?`).bind(...(accountId ? [accountId, limit] : [limit])).all()).results;
  if (!rows.length) return;
  const clients = clientFactory(env);
  for (const row of rows) {
    try { await reconcileMint(env, row, clients, { waitMs }); } catch { console.error('Mint reconciliation pending', row.id); }
  }
}
