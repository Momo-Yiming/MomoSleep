import {
  createPublicClient,
  createWalletClient,
  defineChain,
  getAddress,
  http,
  isAddress,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { merkleRoot, quoteCashRedemption, scoreSleep, sha256Hex, simulatedChainReceipt } from "./domain.mjs";

const BUILD_ID = "1.1-final-order-reset";

class HTTPError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const CONTRACT_ABI = [
  {
    type: "function",
    name: "anchorBatch",
    stateMutability: "nonpayable",
    inputs: [
      { name: "batchId", type: "bytes32" },
      { name: "merkleRoot", type: "bytes32" },
      { name: "scoringVersion", type: "uint32" },
      { name: "claimCount", type: "uint32" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "batches",
    stateMutability: "view",
    inputs: [{ name: "batchId", type: "bytes32" }],
    outputs: [
      { name: "merkleRoot", type: "bytes32" },
      { name: "scoringVersion", type: "uint32" },
      { name: "claimCount", type: "uint32" },
      { name: "anchoredAt", type: "uint64" },
    ],
  },
];

const TOKEN_ABI = [
  {
    type: "function",
    name: "mintSleepReward",
    stateMutability: "nonpayable",
    inputs: [
      { name: "recipient", type: "address" },
      { name: "points", type: "uint256" },
      { name: "claimCommitment", type: "bytes32" },
    ],
    outputs: [{ name: "amount", type: "uint256" }],
  },
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "totalSupply",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
];

const securityHeaders = {
  "Content-Security-Policy": "default-src 'self'; img-src 'self' data: https://smart-sleep-economy-demo.pages.dev; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
};

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

const htmlHeaders = {
  "Content-Type": "text/html; charset=utf-8",
  "Cache-Control": "no-store, max-age=0",
  ...securityHeaders,
};

function json(value, status = 200) {
  return Response.json(value, { status, headers: { ...corsHeaders, ...securityHeaders } });
}

function validAccountId(value) {
  return typeof value === "string" && /^[A-Za-z0-9-]{8,80}$/.test(value);
}

async function bodyFrom(request) {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) throw new HTTPError(400, "JSON body required");
  try {
    return await request.json();
  } catch {
    throw new HTTPError(400, "invalid JSON body");
  }
}

function parsedJSON(value) {
  if (!value) return null;
  try { return JSON.parse(value); } catch { return null; }
}

function cashPolicy(env) {
  const configuredRate = Number(env.CASH_RATE_FEN_PER_100_POINTS ?? 100);
  const rateFenPer100Points = Number.isInteger(configuredRate) && configuredRate >= 1 && configuredRate <= 10_000
    ? configuredRate
    : 100;
  return {
    mode: "integration_pending",
    sponsorProgram: "品牌预付预算试点（待签约）",
    sponsorBudgetStatus: "尚未接收真实品牌资金",
    rateFenPer100Points,
    rateFloorFenPer100Points: 80,
    rateCeilingFenPer100Points: 120,
    minimumPoints: 100,
    maximumPoints: 10_000,
    quoteVersion: env.CASH_QUOTE_VERSION ?? "pilot-2026-09-05-a",
    quoteUpdatedAt: "2026-09-05T07:00:00Z",
    payoutChannel: "微信商家转账到零钱（待商户开通）",
    payoutEnabled: false,
    requirements: ["品牌预付预算", "企业支付商户", "用户实名与单独同意", "财税和反作弊审核"],
  };
}

function tokenPolicy(env) {
  const maxMints = Number(env.SLEEP_TOKEN_MAX_MINTS ?? 20);
  const contractAddress = isAddress(env.SLEEP_TOKEN_ADDRESS ?? "") ? getAddress(env.SLEEP_TOKEN_ADDRESS) : null;
  return {
    mode: "monad_testnet_live",
    region: "海外演示路径",
    tokenName: "MOMO Sleep Test Token",
    tokenSymbol: "SLEEP",
    decimals: 18,
    pointsPerToken: 1,
    maxPointsPerMint: 1_000,
    maxMints: Number.isInteger(maxMints) && maxMints >= 1 && maxMints <= 100 ? maxMints : 20,
    maxSupplyTokens: 20_000,
    contractAddress,
    deploymentTransactionHash: env.SLEEP_TOKEN_DEPLOYMENT_TX ?? null,
    mintingEnabled: Boolean(contractAddress && /^0x[0-9a-fA-F]{64}$/.test(env.MONAD_PRIVATE_KEY ?? "")),
    disclaimer: "Monad Testnet 演示代币，无主网价值、无流动性、不是投资或收益承诺。",
  };
}

async function ensureAccount(env, accountId) {
  if (!validAccountId(accountId)) throw new HTTPError(400, "invalid accountId");
  await env.DB.prepare(
    "INSERT OR IGNORE INTO accounts (id, display_name, points, created_at) VALUES (?, '睡眠体验用户', 0, ?)",
  ).bind(accountId, new Date().toISOString()).run();
}

async function demoState(env, accountId) {
  await ensureAccount(env, accountId);
  const [account, claims, products, orders, entries, cashRedemptions, tokenMints, publicTokenMints, batches] = await Promise.all([
    env.DB.prepare("SELECT id, display_name AS displayName, points, created_at AS createdAt FROM accounts WHERE id = ?").bind(accountId).first(),
    env.DB.prepare("SELECT id, night_key AS nightKey, commitment, raw_points AS rawPoints, awarded_points AS awardedPoints, scoring_version AS scoringVersion, score_breakdown_json AS scoreBreakdownJSON, trust_grade AS trustGrade, status, batch_id AS batchId, created_at AS createdAt FROM claims WHERE account_id = ? ORDER BY created_at DESC LIMIT 20").bind(accountId).all(),
    env.DB.prepare("SELECT id, title, price_points AS pricePoints, stock FROM products ORDER BY price_points").all(),
    env.DB.prepare("SELECT orders.id, orders.product_id AS productId, products.title, orders.price_points AS pricePoints, orders.status, orders.created_at AS createdAt, ROW_NUMBER() OVER (ORDER BY orders.created_at ASC, orders.id ASC) AS receiptSequence FROM orders JOIN products ON products.id = orders.product_id WHERE orders.account_id = ? ORDER BY orders.created_at DESC LIMIT 20").bind(accountId).all(),
    env.DB.prepare("SELECT id, points, kind, note, created_at AS createdAt FROM point_entries WHERE account_id = ? ORDER BY created_at DESC LIMIT 30").bind(accountId).all(),
    env.DB.prepare("SELECT id, points, rate_fen_per_100_points AS rateFenPer100Points, amount_fen AS amountFen, quote_version AS quoteVersion, payout_channel AS payoutChannel, status, created_at AS createdAt FROM cash_redemptions WHERE account_id = ? ORDER BY created_at DESC LIMIT 20").bind(accountId).all(),
    env.DB.prepare("SELECT id, claim_id AS claimId, claim_commitment AS claimCommitment, recipient, points, token_amount_wei AS tokenAmountWei, status, transaction_hash AS transactionHash, contract_address AS contractAddress, block_number AS blockNumber, created_at AS createdAt, confirmed_at AS confirmedAt FROM token_mints WHERE account_id = ? ORDER BY created_at DESC LIMIT 20").bind(accountId).all(),
    env.DB.prepare("SELECT id, claim_commitment AS claimCommitment, recipient, points, token_amount_wei AS tokenAmountWei, status, transaction_hash AS transactionHash, contract_address AS contractAddress, block_number AS blockNumber, confirmed_at AS confirmedAt FROM token_mints WHERE status = 'confirmed' ORDER BY confirmed_at DESC LIMIT 10").all(),
    env.DB.prepare("SELECT id, merkle_root AS merkleRoot, claim_count AS claimCount, scoring_version AS scoringVersion, chain_status AS chainStatus, transaction_hash AS transactionHash, contract_address AS contractAddress, block_number AS blockNumber, created_at AS createdAt, anchored_at AS anchoredAt FROM anchor_batches ORDER BY created_at DESC LIMIT 10").all(),
  ]);
  const claimReceipts = await Promise.all(claims.results.map(async (claim) => {
    const { scoreBreakdownJSON, ...publicClaim } = claim;
    return {
      ...publicClaim,
      scoreBreakdown: parsedJSON(scoreBreakdownJSON),
      chainReceipt: await simulatedChainReceipt({
        recordId: claim.id,
        commitment: claim.commitment,
        createdAt: claim.createdAt,
        sequence: Number(claim.nightKey.match(/(\d+)$/)?.[1] ?? 1),
      }),
    };
  }));
  const orderReceipts = await Promise.all(orders.results.map(async (order) => {
    const commitment = await sha256Hex(JSON.stringify({
      id: order.id,
      productId: order.productId,
      pricePoints: order.pricePoints,
      createdAt: order.createdAt,
    }));
    return {
      id: order.id,
      title: order.title,
      pricePoints: order.pricePoints,
      status: order.status,
      createdAt: order.createdAt,
      chainReceipt: await simulatedChainReceipt({
        recordId: order.id,
        recordType: "purchase",
        commitment,
        createdAt: order.createdAt,
        sequence: 10_000 + Number(order.receiptSequence),
      }),
    };
  }));
  return {
    mode: "sandbox",
    account,
    claims: claimReceipts,
    products: products.results,
    orders: orderReceipts,
    entries: entries.results,
    cashPolicy: cashPolicy(env),
    cashRedemptions: cashRedemptions.results,
    tokenPolicy: tokenPolicy(env),
    tokenMints: tokenMints.results,
    publicTokenMints: publicTokenMints.results,
    batches: batches.results,
    network: {
      name: "Monad Testnet",
      chainId: Number(env.MONAD_CHAIN_ID ?? 10143),
      explorerURL: env.MONAD_EXPLORER_URL,
      contractAddress: env.CONTRACT_ADDRESS ?? null,
    },
  };
}

async function createDemoClaim(env, payload) {
  const accountId = payload.accountId;
  await ensureAccount(env, accountId);
  if (payload.profile !== "screenshot") throw new HTTPError(409, "沙盒计分已升级，请更新 App 后使用四维样例 A");
  const profile = "screenshot";
  const minutes = { asleepMinutes: 0, coreMinutes: 250, remMinutes: 50, deepMinutes: 105, awakeMinutes: 31, interruptionCount: 6, scheduleDeviationMinutes: 565 };
  const score = scoreSleep(minutes);
  const nightKey = "disclosed-example-a";
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const scoreBreakdown = {
    ...score,
    sourceLabel: "用户授权公开的单夜样例",
    windowLabel: "07:36–15:13",
    regularityBasis: "演示目标 21:00–07:00；入睡圆周偏差 636 分钟、醒来偏差 493 分钟，平均 565；不是多晚个人基线",
    vendorReportedDeepPercent: 24.1,
    visibleStageMinutes: 436,
    unclassifiedWindowMinutes: 21,
    inputNotes: ["清醒、REM、浅睡和深睡分钟来自截图汇总", "设备口径 24.1% = 105 / 436（含清醒）；计分口径 25.9% = 105 / 405（仅实际睡眠）", "6 次中断为图中可见片段估计，待原始逐分钟导出校准", "25% 是可版本化激励参数，不是医学诊断阈值"],
  };
  const commitment = await sha256Hex(JSON.stringify({
    format: "sleep-claim-v2",
    id,
    accountId,
    nightKey,
    scoringVersion: score.scoringVersion,
    asleepMinutes: minutes.asleepMinutes,
    coreMinutes: minutes.coreMinutes,
    remMinutes: minutes.remMinutes,
    deepMinutes: minutes.deepMinutes,
    awakeMinutes: minutes.awakeMinutes,
    interruptionCount: minutes.interruptionCount,
    scheduleDeviationMinutes: minutes.scheduleDeviationMinutes,
    depthClosenessBasisPoints: score.depthClosenessBasisPoints,
    effectiveDeepWeightBasisPoints: score.effectiveDeepWeightBasisPoints,
    stagePoints: score.stagePoints,
    continuityFactorBasisPoints: score.continuityFactorBasisPoints,
    regularityFactorBasisPoints: score.regularityFactorBasisPoints,
    awardedPoints: score.awardedPoints,
  }));
  const results = await env.DB.batch([
    env.DB.prepare("INSERT OR IGNORE INTO claims (id, account_id, night_key, commitment, asleep_minutes, core_minutes, rem_minutes, deep_minutes, raw_points, awarded_points, scoring_version, score_breakdown_json, trust_grade, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'SANDBOX', 'accepted', ?)")
      .bind(id, accountId, nightKey, commitment, minutes.asleepMinutes, minutes.coreMinutes, minutes.remMinutes, minutes.deepMinutes, score.rawPoints, score.awardedPoints, score.scoringVersion, JSON.stringify(scoreBreakdown), now),
    env.DB.prepare("UPDATE accounts SET points = points + ? WHERE id = ? AND EXISTS (SELECT 1 FROM claims WHERE id = ?)")
      .bind(score.awardedPoints, accountId, id),
    env.DB.prepare("INSERT INTO point_entries (id, account_id, points, kind, reference_id, note, created_at) SELECT ?, ?, ?, 'sleep_reward', ?, ?, ? WHERE EXISTS (SELECT 1 FROM claims WHERE id = ?)")
      .bind(crypto.randomUUID(), accountId, score.awardedPoints, id, `${nightKey} 沙盒睡眠奖励`, now, id),
  ]);
  if (Number(results[0].meta?.changes ?? 0) !== 1) throw new HTTPError(409, "这个模拟夜晚已经领取过积分");
  return demoState(env, accountId);
}

async function createDemoOrder(env, payload) {
  const { accountId, productId } = payload;
  await ensureAccount(env, accountId);
  if (typeof productId !== "string") throw new HTTPError(400, "invalid productId");
  const product = await env.DB.prepare("SELECT id, title, price_points AS pricePoints FROM products WHERE id = ? AND stock > 0").bind(productId).first();
  if (!product) throw new HTTPError(404, "商品不存在或已售罄");
  const id = crypto.randomUUID();
  const entryId = crypto.randomUUID();
  const now = new Date().toISOString();
  // ponytail: D1 batch is sufficient for this zero-value sandbox; use a reservation service if real inventory is introduced.
  const results = await env.DB.batch([
    env.DB.prepare("INSERT INTO orders (id, account_id, product_id, price_points, status, created_at) SELECT ?, ?, ?, ?, 'sandbox_completed', ? FROM accounts WHERE id = ? AND points >= ?")
      .bind(id, accountId, product.id, product.pricePoints, now, accountId, product.pricePoints),
    env.DB.prepare("UPDATE accounts SET points = points - ? WHERE id = ? AND EXISTS (SELECT 1 FROM orders WHERE id = ?)")
      .bind(product.pricePoints, accountId, id),
    env.DB.prepare("INSERT INTO point_entries (id, account_id, points, kind, reference_id, note, created_at) SELECT ?, ?, ?, 'shop_purchase', ?, ?, ? WHERE EXISTS (SELECT 1 FROM orders WHERE id = ?)")
      .bind(entryId, accountId, -product.pricePoints, id, `沙盒兑换：${product.title}`, now, id),
  ]);
  if (Number(results[0].meta?.changes ?? 0) !== 1) throw new HTTPError(409, "沙盒积分不足");
  return demoState(env, accountId);
}

async function createCashRedemptionApplication(env, payload) {
  const { accountId } = payload;
  const points = Number(payload.points);
  await ensureAccount(env, accountId);
  const policy = cashPolicy(env);
  if (!Number.isInteger(points)) throw new HTTPError(400, "兑换积分必须是整数");
  if (points < policy.minimumPoints) throw new HTTPError(409, `最低兑换 ${policy.minimumPoints} 积分`);
  if (points > policy.maximumPoints) throw new HTTPError(409, `单次最多兑换 ${policy.maximumPoints} 积分`);
  const account = await env.DB.prepare("SELECT points FROM accounts WHERE id = ?").bind(accountId).first();
  if (!account || account.points < points) throw new HTTPError(409, "当前积分不足");
  const quote = quoteCashRedemption(points, policy.rateFenPer100Points);
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const result = await env.DB.prepare(
    "INSERT INTO cash_redemptions (id, account_id, points, rate_fen_per_100_points, amount_fen, quote_version, payout_channel, status, created_at) SELECT ?, ?, ?, ?, ?, ?, ?, 'integration_pending', ? WHERE NOT EXISTS (SELECT 1 FROM cash_redemptions WHERE account_id = ? AND status = 'integration_pending')",
  ).bind(id, accountId, quote.points, quote.rateFenPer100Points, quote.amountFen, policy.quoteVersion, policy.payoutChannel, now, accountId).run();
  if (Number(result.meta?.changes ?? 0) !== 1) throw new HTTPError(409, "已有一笔待接入兑付申请，请先完成或取消");
  // Current public accounts are anonymous sandbox accounts. Do not reserve points or call a payment API
  // until the sponsor budget, legal entity, KYC consent and merchant-transfer channel are active.
  return demoState(env, accountId);
}

function monadClients(env) {
  if (!/^0x[0-9a-fA-F]{64}$/.test(env.MONAD_PRIVATE_KEY ?? "")) throw new Error("MONAD_PRIVATE_KEY is not configured");
  if (typeof env.MONAD_RPC_URL !== "string" || !env.MONAD_RPC_URL.startsWith("https://")) throw new Error("MONAD_RPC_URL is not configured");
  const chain = defineChain({
    id: Number(env.MONAD_CHAIN_ID ?? 10143),
    name: "Monad Testnet",
    nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
    rpcUrls: { default: { http: [env.MONAD_RPC_URL] } },
  });
  const account = privateKeyToAccount(env.MONAD_PRIVATE_KEY);
  const transport = http(env.MONAD_RPC_URL);
  return {
    account,
    wallet: createWalletClient({ account, chain, transport }),
    client: createPublicClient({ chain, transport }),
  };
}

async function createTokenMint(env, payload) {
  const { accountId } = payload;
  await ensureAccount(env, accountId);
  if (!isAddress(payload.recipient ?? "")) throw new HTTPError(400, "请输入有效的 EVM 钱包地址");
  const recipient = getAddress(payload.recipient);
  const policy = tokenPolicy(env);
  if (!policy.mintingEnabled || !policy.contractAddress) throw new HTTPError(503, "测试网铸币暂未开放");
  const claim = await env.DB.prepare(
    "SELECT id, commitment, awarded_points AS awardedPoints FROM claims WHERE account_id = ? AND status = 'accepted' AND awarded_points BETWEEN 1 AND ? ORDER BY created_at DESC LIMIT 1",
  ).bind(accountId, policy.maxPointsPerMint).first();
  if (!claim) throw new HTTPError(409, "请先计算并领取样例 A 的睡眠积分");

  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const tokenAmountWei = (BigInt(claim.awardedPoints) * 10n ** 18n).toString();
  const inserted = await env.DB.prepare(
    "INSERT INTO token_mints (id, account_id, claim_id, claim_commitment, recipient, points, token_amount_wei, status, contract_address, created_at) SELECT ?, ?, ?, ?, ?, ?, ?, 'preparing', ?, ? WHERE (SELECT COUNT(*) FROM token_mints WHERE status IN ('preparing', 'submitted', 'confirmed')) < ? AND NOT EXISTS (SELECT 1 FROM token_mints WHERE claim_commitment = ? OR recipient = ?)",
  ).bind(id, accountId, claim.id, claim.commitment, recipient, claim.awardedPoints, tokenAmountWei, policy.contractAddress, now, policy.maxMints, claim.commitment, recipient).run();
  if (Number(inserted.meta?.changes ?? 0) !== 1) {
    const existing = await env.DB.prepare("SELECT status FROM token_mints WHERE claim_commitment = ? OR recipient = ? LIMIT 1").bind(claim.commitment, recipient).first();
    if (existing?.status === "confirmed") return demoState(env, accountId);
    throw new HTTPError(409, existing ? "该睡眠凭证或收款地址已经提交过铸币" : `公开演示已达到 ${policy.maxMints} 笔上限`);
  }

  try {
    const { account, wallet, client } = monadClients(env);
    const simulation = await client.simulateContract({
      account,
      address: policy.contractAddress,
      abi: TOKEN_ABI,
      functionName: "mintSleepReward",
      args: [recipient, BigInt(claim.awardedPoints), `0x${claim.commitment}`],
    });
    const transactionHash = await wallet.writeContract(simulation.request);
    await env.DB.prepare("UPDATE token_mints SET status = 'submitted', transaction_hash = ? WHERE id = ?")
      .bind(transactionHash, id).run();
    const receipt = await client.waitForTransactionReceipt({ hash: transactionHash });
    if (receipt.status !== "success") throw new Error("token mint transaction reverted");
    await env.DB.prepare("UPDATE token_mints SET status = 'confirmed', block_number = ?, confirmed_at = ? WHERE id = ?")
      .bind(Number(receipt.blockNumber), new Date().toISOString(), id).run();
    return demoState(env, accountId);
  } catch (error) {
    await env.DB.prepare("UPDATE token_mints SET status = 'failed', error_message = ? WHERE id = ?")
      .bind(String(error?.shortMessage ?? error?.message ?? error).slice(0, 240), id).run();
    throw error;
  }
}

async function resetDemo(env, accountId) {
  await ensureAccount(env, accountId);
  await env.DB.batch([
    env.DB.prepare("DELETE FROM point_entries WHERE account_id = ?").bind(accountId),
    env.DB.prepare("DELETE FROM cash_redemptions WHERE account_id = ?").bind(accountId),
    env.DB.prepare("DELETE FROM orders WHERE account_id = ?").bind(accountId),
    env.DB.prepare("DELETE FROM claims WHERE account_id = ? AND batch_id IS NULL AND NOT EXISTS (SELECT 1 FROM token_mints WHERE token_mints.claim_id = claims.id)").bind(accountId),
    env.DB.prepare("UPDATE accounts SET points = 0 WHERE id = ?").bind(accountId),
  ]);
  return demoState(env, accountId);
}

function constantTimeEqual(left, right) {
  if (typeof left !== "string" || typeof right !== "string" || left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index++) difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return difference === 0;
}

function requireAdmin(request, env) {
  const supplied = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  if (!env.ADMIN_TOKEN || !constantTimeEqual(supplied, env.ADMIN_TOKEN)) throw new HTTPError(401, "unauthorized");
}

async function prepareBatch(env) {
  const next = await env.DB.prepare("SELECT scoring_version AS scoringVersion FROM claims WHERE status = 'accepted' AND batch_id IS NULL ORDER BY created_at LIMIT 1").first();
  if (!next) throw new HTTPError(409, "no unbatched claims");
  const rows = (await env.DB.prepare("SELECT id, commitment FROM claims WHERE status = 'accepted' AND batch_id IS NULL AND scoring_version = ? ORDER BY created_at LIMIT 256").bind(next.scoringVersion).all()).results;
  if (!rows.length) throw new HTTPError(409, "no unbatched claims");
  const root = await merkleRoot(rows.map((row) => row.commitment));
  const id = `batch-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare("INSERT INTO anchor_batches (id, merkle_root, scoring_version, claim_count, chain_status, created_at) VALUES (?, ?, ?, ?, 'prepared', ?)").bind(id, root, next.scoringVersion, rows.length, now),
    ...rows.map((row) => env.DB.prepare("UPDATE claims SET batch_id = ? WHERE id = ? AND batch_id IS NULL").bind(id, row.id)),
  ]);
  return env.DB.prepare("SELECT id, merkle_root AS merkleRoot, scoring_version AS scoringVersion, claim_count AS claimCount, chain_status AS chainStatus, created_at AS createdAt FROM anchor_batches WHERE id = ?").bind(id).first();
}

async function anchorBatch(env, batchId) {
  const batch = await env.DB.prepare("SELECT id, merkle_root AS merkleRoot, scoring_version AS scoringVersion, claim_count AS claimCount, chain_status AS chainStatus, transaction_hash AS transactionHash FROM anchor_batches WHERE id = ?").bind(batchId).first();
  if (!batch) throw new HTTPError(404, "batch not found");
  if (batch.chainStatus === "anchored") return batch;
  if (!/^0x[0-9a-fA-F]{40}$/.test(env.CONTRACT_ADDRESS ?? "")) throw new Error("CONTRACT_ADDRESS is not configured");
  const { wallet, client } = monadClients(env);
  const batchHash = `0x${await sha256Hex(batch.id)}`;
  const onchain = await client.readContract({
    address: env.CONTRACT_ADDRESS,
    abi: CONTRACT_ABI,
    functionName: "batches",
    args: [batchHash],
  });
  if (onchain[3] > 0n) {
    if (onchain[0].toLowerCase() !== `0x${batch.merkleRoot}`) throw new Error("on-chain batch root mismatch");
    await env.DB.prepare("UPDATE anchor_batches SET chain_status = 'anchored', contract_address = ?, anchored_at = COALESCE(anchored_at, ?) WHERE id = ?")
      .bind(env.CONTRACT_ADDRESS, new Date().toISOString(), batch.id).run();
    return env.DB.prepare("SELECT id, merkle_root AS merkleRoot, claim_count AS claimCount, scoring_version AS scoringVersion, chain_status AS chainStatus, transaction_hash AS transactionHash, contract_address AS contractAddress, block_number AS blockNumber, anchored_at AS anchoredAt FROM anchor_batches WHERE id = ?").bind(batch.id).first();
  }
  const transactionHash = await wallet.writeContract({
    address: env.CONTRACT_ADDRESS,
    abi: CONTRACT_ABI,
    functionName: "anchorBatch",
    args: [batchHash, `0x${batch.merkleRoot}`, Number(batch.scoringVersion), Number(batch.claimCount)],
  });
  await env.DB.prepare("UPDATE anchor_batches SET chain_status = 'submitted', transaction_hash = ?, contract_address = ? WHERE id = ?")
    .bind(transactionHash, env.CONTRACT_ADDRESS, batch.id).run();
  const receipt = await client.waitForTransactionReceipt({ hash: transactionHash });
  if (receipt.status !== "success") throw new Error("anchor transaction reverted");
  const anchoredAt = new Date().toISOString();
  await env.DB.prepare("UPDATE anchor_batches SET chain_status = 'anchored', transaction_hash = ?, contract_address = ?, block_number = ?, anchored_at = ? WHERE id = ?")
    .bind(transactionHash, env.CONTRACT_ADDRESS, Number(receipt.blockNumber), anchoredAt, batch.id).run();
  return env.DB.prepare("SELECT id, merkle_root AS merkleRoot, claim_count AS claimCount, scoring_version AS scoringVersion, chain_status AS chainStatus, transaction_hash AS transactionHash, contract_address AS contractAddress, block_number AS blockNumber, anchored_at AS anchoredAt FROM anchor_batches WHERE id = ?").bind(batch.id).first();
}

function teamPreviewPage() {
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>MOMO 团队互动横幅预览</title><style>
:root{color-scheme:dark;--ink:#eef5ff;--muted:#a9bbd4;--blue:#7dc8ff;--deep:#050b15}*{box-sizing:border-box}body{margin:0;min-height:100vh;color:var(--ink);font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;background:radial-gradient(circle at 50% 12%,#183b66 0,transparent 38%),var(--deep)}main{width:min(1120px,calc(100% - 32px));margin:0 auto;padding:52px 0 64px}.eyebrow{margin:0 0 10px;color:#9bcfff;font:700 12px/1.3 ui-monospace,SFMono-Regular,monospace;letter-spacing:.14em}h1{margin:0;font-size:clamp(30px,5vw,54px);letter-spacing:-.045em}header p{max-width:610px;margin:15px 0 28px;color:var(--muted)}.stage{position:relative;isolation:isolate;overflow:hidden;aspect-ratio:16/9;min-height:360px;border:1px solid rgba(172,215,255,.24);border-radius:28px;background:#071326;box-shadow:0 30px 80px rgba(0,0,0,.42)}.portrait{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;z-index:-2}.stage::after{content:"";position:absolute;inset:0;pointer-events:none;background:linear-gradient(90deg,rgba(3,10,20,.32),transparent 23%,transparent 76%,rgba(3,10,20,.32)),linear-gradient(0deg,rgba(3,10,20,.2),transparent 32%)}.member{position:absolute;z-index:2;bottom:2%;height:82%;padding:0;border:0;border-radius:48% 48% 16% 16% / 20% 20% 7% 7%;background:transparent;cursor:pointer;outline:none;transition:transform .22s ease}.member::before{content:"";position:absolute;inset:-3% -8% -2%;border:2px solid transparent;border-radius:48% 48% 16% 16% / 20% 20% 7% 7%;opacity:0;box-shadow:0 0 0 0 rgba(125,200,255,0),0 0 45px rgba(65,160,255,0);transition:opacity .2s,box-shadow .2s,border-color .2s}.member:hover::before,.member:focus-visible::before,.member.active::before{opacity:1;border-color:rgba(175,228,255,.94);box-shadow:0 0 0 3px rgba(117,198,255,.24),0 0 48px 10px rgba(62,150,255,.7),inset 0 0 34px rgba(116,195,255,.18)}.member:hover,.member:focus-visible,.member.active{transform:translateY(-5px)}.member:focus-visible{outline:2px solid white;outline-offset:3px}.member.frank{left:3%;width:29%}.member.momo{left:36%;width:28%;height:88%;bottom:-1%}.member.anne{right:3%;width:29%}.member-name{position:absolute;right:8px;bottom:8px;opacity:0;transform:translateY(5px);padding:5px 8px;border:1px solid rgba(184,227,255,.4);border-radius:999px;background:rgba(7,17,31,.8);color:#e8f6ff;font-size:12px;transition:.2s}.member:hover .member-name,.member:focus-visible .member-name,.member.active .member-name{opacity:1;transform:none}.detail{display:grid;grid-template-columns:1fr auto;gap:20px;align-items:center;min-height:145px;margin-top:16px;padding:20px 24px;border:1px solid rgba(161,208,255,.2);border-radius:20px;background:linear-gradient(110deg,rgba(15,33,57,.96),rgba(10,20,35,.94))}.detail .index{color:#9bcfff;font:700 12px/1 ui-monospace,SFMono-Regular,monospace;letter-spacing:.12em}.detail h2{margin:7px 0 4px;font-size:28px;letter-spacing:-.035em}.detail p{margin:0;color:var(--muted)}.tags{display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end}.tag{padding:7px 10px;border:1px solid rgba(167,214,255,.24);border-radius:999px;color:#d7ebff;background:rgba(105,172,235,.1);font-size:13px}.hint{margin:16px 0 0;color:#8da4c2;font-size:13px}@media(max-width:640px){main{width:min(100% - 24px,560px);padding-top:28px}.stage{min-height:300px;border-radius:20px}.detail{grid-template-columns:1fr;padding:18px}.tags{justify-content:flex-start}.member-name{display:none}.member.frank{left:1%;width:32%}.member.momo{left:34%;width:32%}.member.anne{right:1%;width:32%}}
</style><style>
/* 透明抠像层只产生沿真实人物轮廓的阴影光；人物像素仍来自原横幅。 */
.stage::before,.stage::after{display:none}.portrait-effect{position:absolute;z-index:1;inset:0;width:100%;height:100%;object-fit:cover;pointer-events:none;opacity:0;filter:drop-shadow(0 0 4px rgba(178,225,255,.95)) drop-shadow(0 0 13px rgba(67,157,255,.8)) drop-shadow(0 0 28px rgba(44,123,231,.55));transition:opacity .22s ease}.stage[data-active=frank] .effect-frank,.stage[data-active=momo] .effect-momo,.stage[data-active=anne] .effect-anne{opacity:1}.member,.member:hover,.member:focus-visible,.member.active{transform:none}.member::before,.member:hover::before,.member:focus-visible::before,.member.active::before{display:none}.member:focus-visible{outline:0}.member-name{display:none}
.detail{grid-template-columns:minmax(190px,.7fr) minmax(0,1.3fr);align-items:start}.profile{min-width:0;padding-left:18px;border-left:1px solid rgba(161,208,255,.2)}.profile b{display:block;margin-bottom:5px;color:#e8f3ff}.profile p{overflow-wrap:anywhere}@media(max-width:640px){.detail{grid-template-columns:1fr}.profile{padding:12px 0 0;border-left:0;border-top:1px solid rgba(161,208,255,.2)}}
</style></head><body><main><header><p class="eyebrow">TEAM / INTERACTION PREVIEW</p><h1>把光标放到成员身上</h1><p>每次只突出一位成员；资料卡固定在横幅下方，保持三人之间的蓝色留白和画面秩序。</p></header><section class="stage" aria-label="MOMO 团队互动横幅"><img class="portrait" src="/assets/team/team-portrait-hero-v2.png" alt="Frank、Momo 和 Anne 的团队形象照"><img class="portrait-effect effect-frank" src="/assets/team/team-portrait-frank-cutout-v3.png" alt=""><img class="portrait-effect effect-momo" src="/assets/team/team-portrait-momo-cutout-v3.png" alt=""><img class="portrait-effect effect-anne" src="/assets/team/team-portrait-anne-cutout-v3.png" alt=""><button class="member frank" type="button" data-member="frank" aria-label="查看 Frank 林睿资料"></button><button class="member momo active" type="button" data-member="momo" aria-label="查看 Momo 奕铭资料"></button><button class="member anne" type="button" data-member="anne" aria-label="查看 Anne 星仪资料"></button></section><section id="detail" class="detail" aria-live="polite"></section><p class="hint">电脑：悬停或按 Tab 聚焦 · 手机：直接点按成员</p></main><script>
const people={frank:{index:'01 / HARDWARE',name:'Frank 林睿',role:'硬件调研与开发',education:'北京大学 · 集成电路专业',contribution:'负责项目硬件方向的调研和开发。',tags:['ENTJ','丁火男']},momo:{index:'02 / PROJECT LEAD',name:'Momo 奕铭',role:'项目负责人',education:'广东外语外贸大学 · 金融专业背景',contribution:'AI 自媒体博主，专注 AI 开发、期权与 Web3 交易。',tags:['INTP','丁火男']},anne:{index:'03 / THEORY & RESEARCH',name:'Anne 星仪',role:'理论与研究',education:'广东外语外贸大学 · 语言学背景',contribution:'现深耕认知科学与社会学研究，为项目提供“精力四区”“意识力学”等原创底层理论支撑。',tags:['INFP','丙火女']}};
const detail=document.getElementById('detail');const stage=document.querySelector('.stage');const buttons=[...document.querySelectorAll('.member')];function selectMember(id){const person=people[id];stage.dataset.active=id;buttons.forEach(button=>button.classList.toggle('active',button.dataset.member===id));detail.innerHTML='<div><div class="index">'+person.index+'</div><h2>'+person.name+'</h2><p>'+person.role+'</p><div class="tags">'+person.tags.map(tag=>'<span class="tag">'+tag+'</span>').join('')+'</div></div><div class="profile"><b>'+person.education+'</b><p>'+person.contribution+'</p></div>'}buttons.forEach(button=>{const show=()=>selectMember(button.dataset.member);button.addEventListener('mouseenter',show);button.addEventListener('focus',show);button.addEventListener('click',show)});selectMember('momo');
</script></body></html>`;
}

function page() {
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>睡眠经济｜隐私证据网络</title><style>
:root{color-scheme:dark;--bg:#07111f;--panel:#101e32;--panel2:#0a1728;--line:#243854;--text:#eef4ff;--muted:#9db0ca;--mint:#74e6bd;--gold:#f1c978;--violet:#8d78ff}
*{box-sizing:border-box}html{scroll-behavior:smooth}body{font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;background:radial-gradient(circle at 10% 0,#112b4b 0,transparent 34%),var(--bg);color:var(--text);margin:0;line-height:1.62}.wrap{max-width:1040px;margin:auto;padding:24px}.hero,.card{background:rgba(16,30,50,.95);border:1px solid var(--line);border-radius:22px;padding:24px;margin-bottom:18px;box-shadow:0 14px 40px rgba(0,0,0,.16)}.hero{background:linear-gradient(135deg,rgba(23,54,93,.98),rgba(37,31,82,.98));padding:30px}h1,h2,h3{margin-top:0;line-height:1.25}h1{font-size:clamp(32px,6vw,54px);max-width:760px;margin-bottom:12px;letter-spacing:-.03em}h2{font-size:26px;margin-bottom:10px}h3{font-size:18px;margin-bottom:7px}.lead{font-size:18px;max-width:760px}.muted{color:var(--muted);font-size:14px}.balance{font-size:44px;font-weight:800;color:var(--mint)}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:12px}.item{background:var(--panel2);border:1px solid rgba(70,102,138,.35);border-radius:14px;padding:14px}.mono{font-family:ui-monospace,SFMono-Regular,monospace;word-break:break-all}.truth{color:var(--gold)}button{border:0;border-radius:12px;padding:11px 14px;background:#7357ff;color:white;font-weight:700;cursor:pointer}button.alt{background:#214364}button.danger{background:#713b4a}.row{display:flex;gap:10px;flex-wrap:wrap}.status{min-height:22px;color:var(--mint)}.badge{display:inline-block;background:#24486c;padding:4px 9px;border-radius:99px;font-size:12px}.badge.evidence{background:#173f38;color:#aaf5d7}.badge.analysis{background:#4a3d23;color:#ffe3a0}a{color:#9fc7ff}.nav{display:flex;gap:8px;flex-wrap:wrap;margin-top:20px}.nav a{text-decoration:none;color:#dceaff;background:rgba(8,18,33,.42);border:1px solid rgba(150,185,226,.24);padding:7px 11px;border-radius:999px;font-size:13px}.market-grid{display:grid;grid-template-columns:1.15fr .85fr;gap:16px}.market-number{font-size:36px;font-weight:800;color:var(--mint);line-height:1.05;margin:9px 0}.eyebrow{color:var(--gold);font-size:12px;font-weight:700;letter-spacing:.08em;text-transform:uppercase}.section-intro{max-width:800px}.inspiration-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-top:18px}.inspiration{position:relative;overflow:hidden;background:linear-gradient(155deg,#0d1c30,#111a2c);border:1px solid #2d4361;border-radius:17px;padding:17px;min-height:310px}.inspiration .number{font-size:12px;color:var(--gold);font-weight:800;letter-spacing:.12em}.inspiration .mini-flow{color:var(--mint);font-size:13px;font-weight:700}.reference-media{width:100%;height:118px;object-fit:cover;border-radius:12px;margin:12px 0 10px;background:#07111f}.reference-media.ring{object-fit:contain;background:radial-gradient(circle,#f8f9fd 0,#dce4ef 72%,#a9b8c9 100%);padding:7px}.caption{font-size:11px;color:var(--muted)}.timeline{display:grid;grid-template-columns:repeat(4,1fr);gap:9px;margin-top:16px}.era{background:var(--panel2);border-top:3px solid #3978d5;border-radius:12px;padding:13px;font-size:13px}.era:nth-child(2){border-color:#7357ff}.era:nth-child(3){border-color:#b69cff}.era:nth-child(4){border-color:var(--mint)}.era b{display:block;color:var(--gold);margin-bottom:5px}.metric-row{display:grid;grid-template-columns:repeat(3,1fr);gap:9px;margin:15px 0}.metric{background:var(--panel2);border-radius:13px;padding:14px}.metric strong{display:block;font-size:25px;color:var(--mint);line-height:1.15}.metric span{font-size:12px;color:var(--muted)}.flywheels{display:grid;grid-template-columns:1fr 1fr;gap:12px}.wheel{background:var(--panel2);border-radius:14px;padding:15px;border-top:3px solid var(--mint)}.wheel.down{border-color:#f07883}.wheel ol{margin:9px 0 0;padding-left:20px;font-size:14px}.equation{font:700 16px ui-monospace,SFMono-Regular,monospace;background:#07111f;border:1px solid #2f4765;border-radius:12px;padding:14px;text-align:center;color:#b7f4dc}.callout{background:var(--panel2);border-left:3px solid var(--mint);border-radius:10px;padding:12px 14px;margin-top:14px}.callout.risk{border-color:#f07883}.stack{display:grid;grid-template-columns:repeat(5,1fr);gap:7px;margin-top:14px}.stack-step{background:var(--panel2);border-radius:10px;padding:10px;font-size:13px;min-height:76px}.stack-step b{display:block;color:var(--gold);margin-bottom:5px}.comparison{display:grid;grid-template-columns:repeat(2,1fr);gap:11px}.comparison>div{background:var(--panel2);border-radius:14px;padding:15px}.pill-list{display:flex;gap:8px;flex-wrap:wrap;margin-top:12px}.pill{background:#18314d;border:1px solid #315172;border-radius:999px;padding:6px 10px;font-size:12px}.trend{display:flex;height:148px;align-items:end;gap:17px;padding:16px 8px 0;border-bottom:1px solid #35506f}.bar-wrap{display:flex;flex:1;min-width:0;flex-direction:column;align-items:center;justify-content:end;gap:7px;height:100%}.bar{width:100%;max-width:60px;min-height:20px;border-radius:8px 8px 0 0;background:linear-gradient(180deg,var(--mint),#3978d5)}.bar.future{background:linear-gradient(180deg,#b69cff,#7357ff)}.bar-label{font-size:11px;color:var(--muted);text-align:center}.source-note{font-size:12px;color:var(--muted);margin:13px 0 0}.source-note a{color:#9fc7ff}.manifesto{font-size:18px;background:linear-gradient(135deg,#102a38,#27214c);text-align:center;padding:28px}.manifesto p{max-width:760px;margin:0 auto 12px}.manifesto strong{color:var(--mint)}
.score-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:9px;margin:15px 0}.score-card{background:var(--panel2);border-radius:13px;padding:14px;border-top:3px solid var(--violet)}.score-card strong{display:block;font-size:22px;color:var(--mint)}.stage-figure{display:grid;grid-template-columns:minmax(240px,350px) minmax(0,1fr);gap:22px;align-items:start;margin:18px 0}.stage-image-wrap{position:relative;overflow:hidden;width:100%;max-width:350px;border-radius:16px;background:#f5f5f8;box-shadow:0 12px 28px rgba(0,0,0,.24)}.stage-image{display:block;width:100%;height:auto}.stage-hotspot{position:absolute;left:4.6%;width:69%;height:3.8%;padding:0;border:2px solid transparent;border-radius:12px;background:transparent;box-shadow:none;z-index:2;transition:background .15s,border-color .15s,box-shadow .15s}.stage-hotspot:hover,.stage-hotspot:focus-visible,.stage-hotspot.active{border-color:var(--stage);background:rgba(255,255,255,.13);box-shadow:0 0 0 4px rgba(7,17,31,.25),0 0 24px var(--stage)}.stage-hotspot.awake{top:60.2%;--stage:#efaa75}.stage-hotspot.rem{top:67.6%;--stage:#b9a5ff}.stage-hotspot.core{top:75%;--stage:#805df1}.stage-hotspot.deep{top:82.3%;--stage:#5418ce}.stage-detail{position:sticky;top:18px;background:linear-gradient(145deg,#0b1829,#17183a);border:1px solid #334d70;border-top:4px solid var(--detail,#7357ff);border-radius:16px;padding:17px;min-height:0}.stage-detail[data-stage=awake]{--detail:#efaa75}.stage-detail[data-stage=rem]{--detail:#b9a5ff}.stage-detail[data-stage=core]{--detail:#805df1}.stage-detail[data-stage=deep]{--detail:#5418ce}.stage-detail h3{font-size:22px;margin:4px 0 8px}.stage-detail p{margin:0 0 13px}.stage-detail .stage-hint{color:var(--gold);font-size:12px;font-weight:800;letter-spacing:.07em}.stage-breakdown{overflow:hidden;background:#07111f;border:1px solid #233a57;border-radius:12px}.stage-breakdown-row{display:flex;justify-content:space-between;align-items:center;gap:18px;padding:10px 12px;border-bottom:1px solid #1d3048;font-size:14px}.stage-breakdown-row:last-child{border-bottom:0;background:rgba(116,230,189,.08)}.stage-breakdown-row span{color:var(--muted)}.stage-breakdown-row strong{color:#eef4ff;text-align:right}.stage-breakdown-row:last-child strong{color:var(--mint);font-size:17px}.cash-layout{display:grid;grid-template-columns:minmax(280px,.9fr) minmax(320px,1.1fr);gap:16px;align-items:start;margin-top:16px}.cash-panel{background:linear-gradient(145deg,#0c2134,#17214a);border:1px solid #3b5d7d;border-radius:18px;padding:18px}.cash-amount{font-size:42px;font-weight:850;line-height:1.1;color:var(--mint);margin:5px 0}.cash-rate{color:#c8f5e4;font-weight:750}.cash-control{display:grid;gap:7px;margin:16px 0}.cash-control input{width:100%;background:#07111f;border:1px solid #38536f;color:var(--text);border-radius:10px;padding:11px 12px;font:700 17px inherit}.cash-control small{color:var(--muted)}.pilot-status{display:inline-block;color:#ffe3a0;background:#4a3d23;border-radius:999px;padding:4px 9px;font-size:12px;font-weight:800}.live-status{display:inline-block;color:#aaf5d7;background:#173f38;border-radius:999px;padding:4px 9px;font-size:12px;font-weight:800}.token-panel{background:linear-gradient(145deg,#101638,#182957);border-color:#665be0}.calculation{margin-top:15px;background:#07111f;border:1px solid #2f4765;border-radius:14px;padding:16px}.calculation .equation{margin-top:12px}.fine-print{font-size:12px;color:var(--muted)}
.opening{position:relative;isolation:isolate;overflow:hidden;min-height:calc(100svh - 48px);display:grid;place-items:center;text-align:center;padding:48px 20px;margin-bottom:18px}.opening::before{content:"";position:absolute;z-index:-1;width:min(78vw,780px);aspect-ratio:1;border-radius:50%;background:radial-gradient(circle,rgba(115,87,255,.28),rgba(30,88,145,.12) 48%,transparent 72%);filter:blur(8px)}.opening-inner{display:grid;justify-items:center;gap:18px}.opening-kicker{color:var(--mint);font:800 12px ui-monospace,SFMono-Regular,monospace;letter-spacing:.18em;text-transform:uppercase}.opening h1{max-width:none;margin:0;font-size:clamp(64px,12vw,140px);line-height:.96;letter-spacing:-.07em}.question-mark{color:var(--gold)}.opening-prompt{margin:0;color:#c8d7eb;font-size:clamp(18px,2.4vw,28px)}.opening-next{display:inline-block;margin-top:16px;padding:10px 16px;border:1px solid rgba(167,214,255,.28);border-radius:999px;text-decoration:none;color:#e9f4ff;background:rgba(15,33,57,.64)}
.team-intro{min-height:100svh;display:grid;align-content:center;gap:16px;padding:48px 0;margin-bottom:18px}.team-heading{max-width:720px}.team-heading h2{font-size:clamp(32px,5vw,52px);margin:5px 0 8px}.team-heading p{margin:0;color:var(--muted)}.team-stage{position:relative;isolation:isolate;overflow:hidden;width:100%;aspect-ratio:1672/941;border:1px solid rgba(172,215,255,.24);border-radius:26px;background:#071326;box-shadow:0 24px 60px rgba(0,0,0,.32)}.team-portrait,.team-portrait-effect{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}.team-portrait{z-index:-1}.team-portrait-effect{z-index:1;pointer-events:none;opacity:0;filter:drop-shadow(0 0 4px rgba(178,225,255,.95)) drop-shadow(0 0 13px rgba(67,157,255,.8)) drop-shadow(0 0 28px rgba(44,123,231,.55));transition:opacity .22s ease}.team-stage[data-active=frank] .team-effect-frank,.team-stage[data-active=momo] .team-effect-momo,.team-stage[data-active=anne] .team-effect-anne{opacity:1}.team-member{position:absolute;z-index:2;top:0;height:100%;padding:0;border:0;border-radius:0;background:transparent;box-shadow:none}.team-member.frank{left:0;width:33%}.team-member.momo{left:33%;width:34%}.team-member.anne{right:0;width:33%}.team-member:focus-visible{outline:0}.team-detail{display:grid;grid-template-columns:1fr auto;gap:20px;align-items:center;min-height:124px;padding:18px 22px;border:1px solid rgba(161,208,255,.2);border-radius:18px;background:linear-gradient(110deg,rgba(15,33,57,.96),rgba(10,20,35,.94))}.team-index{color:#9bcfff;font:700 12px ui-monospace,SFMono-Regular,monospace;letter-spacing:.12em}.team-detail h3{margin:6px 0 2px;font-size:27px}.team-detail p{margin:0;color:var(--muted)}.team-tags{display:flex;justify-content:flex-end;gap:8px;flex-wrap:wrap}.team-tag{padding:7px 10px;border:1px solid rgba(167,214,255,.24);border-radius:999px;color:#d7ebff;background:rgba(105,172,235,.1);font-size:13px}.team-hint{margin:0;color:#8da4c2;font-size:13px}.hero-title{font-size:clamp(32px,6vw,54px);max-width:760px;margin:0 0 12px;letter-spacing:-.03em}
.team-intro{grid-template-columns:minmax(0,1.55fr) minmax(300px,.75fr)}.team-heading,.team-hint{grid-column:1/-1}.team-stage{grid-column:1}.team-detail{grid-column:2;grid-row:2;grid-template-columns:1fr;align-self:stretch;align-content:center;align-items:start;min-height:0}.team-identity{display:grid;align-content:start}.team-role{color:#dceaff!important;font-weight:750}.team-tags{justify-content:flex-start;margin-top:12px}.team-profile{display:grid;min-width:0;gap:9px;padding:14px 0 0;border-left:0;border-top:1px solid rgba(161,208,255,.2)}.team-profile-label{display:block;margin-bottom:2px;color:#8da4c2;font-size:11px;font-weight:800;letter-spacing:.1em}.team-education{color:#e8f3ff;font-size:15px}.team-contribution{color:#b9c9dd!important;font-size:14px;line-height:1.7;overflow-wrap:anywhere}
@media(max-width:900px){.team-intro{grid-template-columns:1fr}.team-heading,.team-stage,.team-detail,.team-hint{grid-column:1;grid-row:auto}.team-detail{grid-template-columns:minmax(210px,.7fr) minmax(0,1.3fr);min-height:164px}.team-profile{padding:0 0 0 20px;border-top:0;border-left:1px solid rgba(161,208,255,.2)}}
@media(max-width:760px){.wrap{padding:13px}.hero,.card{padding:18px;border-radius:17px}.inspiration-grid,.timeline,.market-grid,.flywheels,.comparison,.score-grid,.stage-figure,.cash-layout{grid-template-columns:1fr}.metric-row{grid-template-columns:1fr 1fr}.stack{grid-template-columns:1fr 1fr}.market-number{font-size:30px}.inspiration{min-height:auto}.reference-media{height:170px}.stage-figure{gap:16px}.stage-image-wrap{max-width:290px;margin:auto}.stage-detail{position:static;min-height:0}.stage-detail h3{font-size:20px}.stage-breakdown-row{gap:10px;padding:9px 10px}.cash-amount{font-size:36px}.opening{min-height:calc(100svh - 26px);padding:32px 8px}.opening h1{font-size:clamp(54px,17vw,78px)}.opening-next{margin-top:8px}.team-intro{min-height:100svh;padding:38px 0}.team-stage{border-radius:16px}.team-detail{grid-template-columns:1fr;gap:14px;padding:16px;min-height:0}.team-tags{justify-content:flex-start}.team-detail h3{font-size:23px}.team-profile{padding:13px 0 0;border-left:0;border-top:1px solid rgba(161,208,255,.2)}}
@media(prefers-reduced-motion:reduce){html{scroll-behavior:auto}.team-portrait-effect{transition:none}}
</style></head><body><main class="wrap">
<section id="opening" class="opening" aria-labelledby="opening-question"><div class="opening-inner"><div class="opening-kicker">MOMO Sleep · Hackathon</div><h1 id="opening-question">睡眠满八小时<span class="question-mark">？</span></h1><p class="opening-prompt">你昨晚睡了几个小时？</p><a class="opening-next" href="#team" aria-label="继续查看团队介绍">认识 MOMO Sleep 团队 ↓</a></div></section>
<section id="team" class="team-intro" aria-labelledby="team-title"><header class="team-heading"><div class="eyebrow">Who we are · 团队介绍</div><h2 id="team-title">我们是 MOMO Sleep</h2><p>把鼠标移到人物身上，或在手机上点按，认识正在构建睡眠经济系统的我们。</p></header><div class="team-stage" data-active="momo" aria-label="MOMO Sleep 三人团队互动合照" aria-describedby="team-hint"><img class="team-portrait" src="/assets/team/team-portrait-hero-v2.png" alt="Frank 林睿、Momo 奕铭和 Anne 星仪的团队合照"><img class="team-portrait-effect team-effect-frank" src="/assets/team/team-portrait-frank-cutout-v3.png" alt=""><img class="team-portrait-effect team-effect-momo" src="/assets/team/team-portrait-momo-cutout-v3.png" alt=""><img class="team-portrait-effect team-effect-anne" src="/assets/team/team-portrait-anne-cutout-v3.png" alt=""><button class="team-member frank" type="button" data-team-member="frank" aria-label="查看 Frank 林睿资料" aria-controls="team-detail" aria-pressed="false"></button><button class="team-member momo" type="button" data-team-member="momo" aria-label="查看 Momo 奕铭资料" aria-controls="team-detail" aria-pressed="true"></button><button class="team-member anne" type="button" data-team-member="anne" aria-label="查看 Anne 星仪资料" aria-controls="team-detail" aria-pressed="false"></button></div><div id="team-detail" class="team-detail" aria-live="polite" aria-atomic="true"><div class="team-identity"><div class="team-index">02 / PROJECT LEAD</div><h3>Momo 奕铭</h3><p class="team-role">项目负责人</p><div class="team-tags"><span class="team-tag">INTP</span><span class="team-tag">丁火男</span></div></div><div class="team-profile"><div><span class="team-profile-label">教育与专业背景</span><div class="team-education">广东外语外贸大学 · 金融专业背景</div></div><p class="team-contribution">AI 自媒体博主，专注 AI 开发、期权与 Web3 交易。</p></div></div><p id="team-hint" class="team-hint">电脑：悬停或按 Tab 聚焦 · 手机：直接点按成员</p></section>
<section id="project" class="hero"><span class="badge">Website v1.1 · 中国合规路径 + 海外测试网路径</span><h2 class="hero-title">让睡眠成为可信资产</h2><p class="lead">MOMO 睡眠经济系统把智能唤醒、可穿戴数据、AI 反馈、产品真实世界研究与隐私审计连接起来。中国版使用品牌预算和中心化积分结算；海外版演示把合格积分铸造为链上代币。</p><p class="muted">当前页面不连接或上传 HealthKit；样例 A 是用户明确授权公开的睡眠截图与手工汇总。中国版不发币；海外板块只铸造无主网价值的 Monad Testnet SLEEP 演示代币，无交易市场、无流动性、不承诺收益。</p><nav class="nav" aria-label="页面导航"><a href="#quality-score">四维计分</a><a href="#sandbox">体验沙盒</a><a href="#cashout">人民币兑付</a><a href="#tokenize">海外铸币</a><a href="#stepn">STEPN 教训</a><a href="#market">市场规模</a></nav></section>
<section id="quality-score" class="card"><div class="eyebrow">Deterministic score · 四维激励 V2</div><h2>每一分都能从睡眠数据复算</h2><p class="section-intro">当前演示把一晚睡眠拆成时长、深度、连续性和规律性四层。计分规则带版本号；同一输入得到同一结果，服务器重新计算后才写入沙盒账本。</p><div class="score-grid"><div class="score-card"><strong>① 最多 480 分钟</strong><span>整晚各阶段按比例最多折算 480 分钟；超过部分不继续增加。</span></div><div class="score-card"><strong>② 深睡目标 25%</strong><span>Core 1×、REM 2×；Deep 在目标附近为 3×，偏高或偏低逐渐回落。</span></div><div class="score-card"><strong>③ 每次中断都扣权重</strong><span>内部清醒次数和清醒总分钟共同降低连续性系数，最低保留 0.70。</span></div><div class="score-card"><strong>④ 与个人节律比较</strong><span>正式版使用多晚个人基线；本页单晚样例只与演示目标作息比较。</span></div></div><div class="equation">阶段分钟小计 × 连续性系数 × 规律性系数 = 本晚沙盒积分</div><div class="callout"><b>产品参数，不是医学诊断：</b>25% 是当前可版本化的激励曲线中心，不是适用于所有人的统一“最佳深睡”标准。研究参与补偿仍奖励有效参与，不按健康结果高低发放。</div></section>
<section id="sandbox" class="card"><div class="eyebrow">Working demo · 用户授权公开样例 A</div><h2>在原始睡眠阶段图上，直接查看每种颜色怎样计分</h2><p class="muted">用户授权公开的原始截图：07:36–15:13；清醒 31 分钟、REM 50 分钟、浅睡 250 分钟、深睡 105 分钟。电脑把鼠标移到原图下方四条彩色统计条，手机直接点按，即可查看对应算法和权重。</p><div class="stage-figure"><figure style="margin:0"><div class="stage-image-wrap"><img class="stage-image" src="/assets/sleep-stage-sample-a.jpg" onerror="if(!this.dataset.retry){this.dataset.retry='1';this.src='https://smart-sleep-economy-demo.pages.dev/assets/sleep-stage-sample-a.jpg'}" alt="用户授权公开的睡眠阶段原始截图：清醒31分钟、快速眼动50分钟、浅睡4小时10分钟、深睡1小时45分钟"><button type="button" class="stage-hotspot awake" data-stage="awake" aria-label="查看清醒阶段计分" aria-pressed="false"></button><button type="button" class="stage-hotspot rem" data-stage="rem" aria-label="查看快速眼动阶段计分" aria-pressed="false"></button><button type="button" class="stage-hotspot core" data-stage="core" aria-label="查看浅睡阶段计分" aria-pressed="false"></button><button type="button" class="stage-hotspot deep" data-stage="deep" aria-label="查看深睡阶段计分" aria-pressed="false"></button></div><figcaption class="fine-print">原图完整展示；高亮层只负责交互，不重画或改写睡眠阶段。精确日期和时段不等同匿名。</figcaption></figure><aside id="stage-detail" class="stage-detail" aria-live="polite"><div class="stage-hint">悬停或点按彩色统计条</div><h3>选择一种睡眠颜色</h3><p>右侧会用中文账单列出计分时长、每分钟积分和阶段积分，不再显示压缩数学公式。</p><div class="stage-breakdown"><div class="stage-breakdown-row"><span>当前状态</span><strong>等待选择</strong></div></div></aside></div><p class="fine-print">阶段汇总为 436 分钟，图轴为 457 分钟，相差的 21 分钟不自行补齐，也不计分；6 次中断为图中可见片段估计，待原始逐分钟导出校准。</p><div class="muted">当前沙盒积分</div><div id="balance" class="balance">--</div><div class="row"><button onclick="claim('screenshot')">计算并领取样例 A 积分</button><button class="danger" onclick="resetDemo()">重置演示</button></div><p id="status" class="status"></p><div id="calculation" class="calculation"><span class="muted">点击上方按钮后，服务器会展示完整复算过程。</span></div></section>
<section id="cashout" class="card"><div class="eyebrow">Sponsor-funded payout · 品牌预算兑付</div><h2>积分如何兑换成人民币</h2><p class="section-intro">正式模式由品牌方先把活动预算付给平台，平台再按当期兑付率把合格积分结算给用户。兑付率会随品牌预算和活动周期调整，但一笔申请提交后会锁定当时的汇率。</p><div class="cash-layout"><div class="cash-panel"><span id="cash-mode" class="pilot-status">读取兑付状态…</span><div class="muted" style="margin-top:12px">预计可兑换</div><div id="cash-estimate" class="cash-amount">¥0.00</div><div id="cash-rate" class="cash-rate">读取当期汇率…</div><label class="cash-control" for="cash-points"><span>输入要兑换的积分</span><input id="cash-points" type="number" inputmode="numeric" value="100" min="100" step="100" oninput="updateCashEstimate()"><small id="cash-limit">最低 100 积分</small></label><button id="cash-submit" type="button" onclick="requestCashRedemption()">提交兑付申请</button><p id="cash-status" class="status" aria-live="polite"></p></div><div><h3>真实打款需要四个条件</h3><div class="stage-breakdown"><div class="stage-breakdown-row"><span>品牌资金</span><strong id="sponsor-budget">读取中…</strong></div><div class="stage-breakdown-row"><span>收款渠道</span><strong id="payout-channel">读取中…</strong></div><div class="stage-breakdown-row"><span>身份与同意</span><strong>实名 + 健康数据单独同意</strong></div><div class="stage-breakdown-row"><span>财税与风控</span><strong>审核后才可支付</strong></div></div><div class="callout risk"><b>当前没有真实打款：</b>本页会保存一笔“兑付接入申请”并显示人民币金额，但不会扣积分或调用支付商户。等品牌资金到账、法人商户和实名支付流程接入后，才可把状态切换为真实兑付。</div></div></div><h3 style="margin-top:18px">兑付申请记录</h3><div id="cash-redemptions" class="grid"></div><p class="source-note">正式接入建议使用企业商户的异步转账：服务端发起、查询最终状态并向用户显示电子回单。健康信息和金融账户都属于敏感个人信息，需分别说明用途并取得必要的单独同意。参考：<a href="https://pay.wechatpay.cn/doc/v3/merchant/4012065163" target="_blank" rel="noreferrer">微信支付商家转账开发概念</a>、<a href="https://www.cac.gov.cn/2021-08/20/c_1631050028355286.htm" target="_blank" rel="noreferrer">《个人信息保护法》第 28–30 条</a>。</p></section>
<section id="tokenize" class="card"><div class="eyebrow">Global route · Overseas token mint</div><h2>海外版：把睡眠积分真实铸造成 SLEEP</h2><p class="section-intro">海外路径把通过服务器计分与风控的睡眠凭证映射为 ERC-20 奖励。本演示的合约部署、铸币交易、区块、收款地址和代币余额都可在 Monad Testnet 查证。</p><div class="cash-layout"><div class="cash-panel token-panel"><span id="token-mode" class="live-status">读取测试网状态…</span><div class="muted" style="margin-top:12px">本次可铸造</div><div id="token-estimate" class="cash-amount">0 SLEEP</div><div class="cash-rate">1 睡眠积分 = 1 SLEEP 测试代币</div><label class="cash-control" for="token-recipient"><span>接收代币的 EVM 钱包地址</span><input id="token-recipient" type="text" inputmode="text" autocomplete="off" placeholder="0x…" oninput="updateTokenMint()"><small id="token-limit">请先计算样例 A 的睡眠积分</small></label><button id="token-submit" type="button" onclick="requestTokenMint()">在 Monad Testnet 真实铸币</button><p id="token-status" class="status" aria-live="polite"></p></div><div><h3>从睡眠到链上代币</h3><div class="stage-breakdown"><div class="stage-breakdown-row"><span>1. 数据与同意</span><strong>本地标准化，原始数据不上链</strong></div><div class="stage-breakdown-row"><span>2. 计分与防重放</span><strong>服务器重算，一晚一承诺</strong></div><div class="stage-breakdown-row"><span>3. 真实铸币</span><strong>Owner-only ERC-20 mint</strong></div><div class="stage-breakdown-row"><span>4. 公开验证</span><strong>交易、余额与事件可查</strong></div></div><div id="token-contract" class="callout"></div><div class="callout risk"><b>请注意：</b>“真实”指交易确实写入 Monad Testnet，不等于当前样例已通过硬件签名或身份审核。SLEEP 是有上限的可转账测试代币，不是主网代币、投资品或收益凭证。</div></div></div><h3 style="margin-top:18px">我的铸币记录</h3><div id="my-token-mints" class="grid"></div><h3 style="margin-top:18px">已确认的真实测试网铸币</h3><div id="public-token-mints" class="grid"></div><p class="source-note">公开演示最多 20 笔，每份睡眠承诺和每个收款地址只能铸造一次，单笔最多 1,000 SLEEP，合约总量硬上限 20,000 SLEEP。正式海外产品仍需按目标国家/地区完成证券、税务、消费者保护、隐私、制裁和智能合约安全评审。网络参考：<a href="https://developers.monad.xyz/" target="_blank" rel="noreferrer">Monad Developer Portal</a>。</p></section>
<section class="card"><h2>沙盒商城</h2><div id="products" class="grid"></div></section>
<section class="card"><h2>每晚唯一链上凭证（动态模拟）</h2><p class="muted">每次睡眠都会得到不同的凭证哈希、交易哈希和区块高度。这里明确是流程模拟，不会消耗测试币，也不能在区块浏览器查证。</p><div id="claims" class="grid"></div></section>
<section class="card"><h2>兑换记录与唯一凭证（动态模拟）</h2><p class="muted">每次积分消费都会生成不同且刷新稳定的兑换凭证、模拟交易和模拟区块。它们只演示审计流程，不是真实测试网交易。</p><div id="orders" class="grid"></div></section>
<section class="card"><h2>真实 Monad 测试网锚点</h2><p class="muted">网络和合约地址保持固定是正常设计；每次正式锚定时变化的是交易、区块和批次根。</p><div id="network" class="muted"></div><div id="batches" class="grid"></div></section>
<section id="stepn" class="card"><div class="eyebrow">Case study · STEPN</div><h2>STEPN：爆发增长，也快速回落</h2><p>用户购买 NFT 鞋，运动赚取 GST，再把 GST 用于修鞋、升级和铸鞋。玩法易懂、传播很快，但奖励高度依赖新增用户与生态内交易。</p><div class="metric-row"><div class="metric"><strong>2,500</strong><span>2022 年 1 月链上月活</span></div><div class="metric"><strong>705,500</strong><span>2022 年 5 月峰值</span></div><div class="metric"><strong>44,900</strong><span>2022 年 12 月</span></div></div><p class="muted">以上是链上活跃地址估算，不等于完整 App 用户数。</p><div class="flywheels"><div class="wheel"><h3>增长</h3><ol><li>新用户带来鞋和 GST 需求</li><li>回报预期提高</li><li>吸引更多新用户</li></ol></div><div class="wheel down"><h3>回落</h3><ol><li>新增用户减少</li><li>消耗下降、卖压上升</li><li>回报恶化，用户退出</li></ol></div></div><div class="callout"><b>MOMO 的教训：</b>奖励必须由真实、可验证的外部收入支撑，不能只靠新增用户。</div><div class="equation">奖励发行 ≠ 可持续收入</div><p class="muted"><b>Lympo 的补充教训：</b>2022 年热钱包事件说明，密钥和资产托管同样重要。</p><p class="source-note">来源：<a href="https://whitepaper.stepn.com/other-modules/tokenomic" target="_blank" rel="noreferrer">STEPN Tokenomics</a>、<a href="https://research.binance.com/static/pdf/full-year-2022-and-themes-for-2023.pdf" target="_blank" rel="noreferrer">Binance Research 2022</a>、<a href="https://medium.com/lympo-official/community-update-2-85805b0555ce" target="_blank" rel="noreferrer">Lympo 事件通报</a>、<a href="https://immunefi.com/blog/research/hacks-and-token-prices-report-2022/" target="_blank" rel="noreferrer">Immunefi 复盘</a>。</p></section>
<section class="card"><div class="eyebrow">Market opportunity · China first</div><h2>睡眠是大市场，可信反馈是缺口</h2><div class="market-grid"><div><div class="muted">中国睡眠经济（广义行业口径）</div><div class="market-number">5,737.2 亿元</div><div class="muted">2025 年估算；2030 年预计 7,904.3 亿元。</div><div class="trend" aria-label="中国睡眠经济市场规模趋势：2023年4955.8亿元、2025年5737.2亿元、2030年预测7904.3亿元"><div class="bar-wrap"><div class="bar" style="height:63%"></div><span class="bar-label">2023<br>4,955.8 亿</span></div><div class="bar-wrap"><div class="bar" style="height:73%"></div><span class="bar-label">2025<br>5,737.2 亿</span></div><div class="bar-wrap"><div class="bar future" style="height:100%"></div><span class="bar-label">2030F<br>7,904.3 亿</span></div></div></div><div><div class="eyebrow">Global reference</div><h3>全球市场也在增长</h3><p><b>730 亿美元</b><br><span class="muted">2024 年全球睡眠健康消费</span></p><p><b>1,035 → 1,360 亿美元</b><br><span class="muted">2025–2030 年睡眠辅助技术预测</span></p><p class="muted">两组数据口径不同，不能相加。</p></div></div><div class="callout"><b>MOMO 的机会：</b>消费者愿意为睡眠付费，却对效果存疑。我们提供经用户同意、可比较、可复核的真实使用反馈。</div><p class="source-note">来源：<a href="https://data.iimedia.cn/data-classification/detail/49306834.html" target="_blank" rel="noreferrer">艾媒睡眠经济</a>、<a href="https://globalwellnessinstitute.org/wp-content/uploads/2025/11/2025-GWI-WE-Monitor_DIGITAL-FINAL.pdf" target="_blank" rel="noreferrer">GWI 2025</a>、<a href="https://www.bccresearch.com/public/RedactedRO/HLC081F.pdf" target="_blank" rel="noreferrer">BCC Research</a>。</p></section>
<section class="card"><div class="eyebrow">Hardware entry · Wearables & rings</div><h2>可穿戴已普及，智能戒指正在增长</h2><div class="market-grid"><div><div class="muted">中国腕戴设备（手表 + 手环）</div><div class="market-number">7,390 万台</div><div class="muted">2025 年出货量，同比增长 20.8%。这不是智能戒指出货量。</div></div><div><div class="muted">全球智能戒指（Omdia 出货量）</div><div class="trend" aria-label="全球智能戒指出货趋势：2023年超过85万枚，2024年180万枚，2025年预测超过400万枚"><div class="bar-wrap"><div class="bar" style="height:24%"></div><span class="bar-label">2023<br>&gt;85 万</span></div><div class="bar-wrap"><div class="bar" style="height:50%"></div><span class="bar-label">2024<br>180 万</span></div><div class="bar-wrap"><div class="bar future" style="height:100%"></div><span class="bar-label">2025F<br>&gt;400 万</span></div></div><p class="muted">仍是小品类，但近三年增长明显。</p></div></div><div class="callout"><b>戒指的作用：</b>低打扰地采集夜间数据。它是入口，不会自动证明真实睡眠；MOMO 负责同意、审核与聚合证据。</div><p class="source-note">来源：<a href="https://www.idc.com/resource-center/blog/2025%E5%B9%B4%E4%B8%AD%E5%9B%BD%E8%85%95%E6%88%B4%E8%AE%BE%E5%A4%87%E5%B8%82%E5%9C%BA%E5%90%8C%E6%AF%94%E5%A2%9E%E9%95%BF20-8%EF%BC%8C%E4%BF%83%E9%94%80%E8%A1%A5%E8%B4%B4%E5%AF%B9%E5%B8%82%E5%9C%BA/" target="_blank" rel="noreferrer">IDC 中国腕戴</a>、<a href="https://omdia.tech.informa.com/blogs/2025/nov/empowering-the-health-and-fitness-ecosystem-with-smart-rings" target="_blank" rel="noreferrer">Omdia 智能戒指</a>。</p></section>
<section class="card"><div class="eyebrow">Positioning · 中国切入假设</div><h2>更聚焦、更容易做小闭环验证</h2><div class="comparison"><div><h3>潜在优势</h3><p>睡眠垂直定位、深圳及大湾区智能硬件供应链、本地睡眠需求，以及开放权重 AI 的本地部署选择。</p></div><div><h3>必须拿数据证明</h3><p>供应商真实报价和良率、获客成本、数据有效率、厂商付费意愿，以及参与者是否愿意再次参加。</p></div></div><p>泰康等保险与健康管理集团可以作为潜在合作伙伴类别研究，但本项目目前没有投资、合作或背书关系。AI、大健康、可穿戴与隐私计算存在交汇，不等于自动获得政策扶持；睡眠数据也不会因为上链自动成为 RWA。</p><div class="callout"><b>长期演化：</b>先兼容戒指、手表和 HealthKit，再探索床旁毫米波/无线电感知与声、光、香氛、空调联动。接入米家等生态是未来合作方向，不是已完成能力。作息社交可从留学生、夜班与跨时区人群验证，但必须默认隐藏精确睡眠时间和位置。</div></section>
<section class="card manifesto" style="padding:clamp(40px,7vw,76px) 24px"><strong style="display:block;font-size:clamp(36px,6vw,68px);line-height:1.05;letter-spacing:-.035em">Make Your Sleep Count.</strong></section>
</main><script>
const teamPeople={frank:{index:'01 / HARDWARE',name:'Frank 林睿',role:'硬件调研与开发',education:'北京大学 · 集成电路专业',contribution:'负责项目硬件方向的调研和开发。',tags:['ENTJ','丁火男']},momo:{index:'02 / PROJECT LEAD',name:'Momo 奕铭',role:'项目负责人',education:'广东外语外贸大学 · 金融专业背景',contribution:'AI 自媒体博主，专注 AI 开发、期权与 Web3 交易。',tags:['INTP','丁火男']},anne:{index:'03 / THEORY & RESEARCH',name:'Anne 星仪',role:'理论与研究',education:'广东外语外贸大学 · 语言学背景',contribution:'现深耕认知科学与社会学研究，为项目提供“精力四区”“意识力学”等原创底层理论支撑。',tags:['INFP','丙火女']}};
const teamStage=document.querySelector('.team-stage');const teamDetail=document.getElementById('team-detail');const teamButtons=[...document.querySelectorAll('.team-member')];function selectTeamMember(id){const person=teamPeople[id];if(!person)return;teamStage.dataset.active=id;teamButtons.forEach(button=>button.setAttribute('aria-pressed',String(button.dataset.teamMember===id)));teamDetail.innerHTML='<div class="team-identity"><div class="team-index">'+person.index+'</div><h3>'+person.name+'</h3><p class="team-role">'+person.role+'</p><div class="team-tags">'+person.tags.map(tag=>'<span class="team-tag">'+tag+'</span>').join('')+'</div></div><div class="team-profile"><div><span class="team-profile-label">教育与专业背景</span><div class="team-education">'+person.education+'</div></div><p class="team-contribution">'+person.contribution+'</p></div>'}teamButtons.forEach(button=>{const show=()=>selectTeamMember(button.dataset.teamMember);button.addEventListener('mouseenter',show);button.addEventListener('focus',show);button.addEventListener('click',show)});selectTeamMember('momo');
const marketHeading=[...document.querySelectorAll('h2')].find(node=>node.textContent==='睡眠是大市场，可信反馈是缺口');if(marketHeading)marketHeading.closest('section').id='market';
const accountId=localStorage.sleepDemoAccount||(localStorage.sleepDemoAccount=crypto.randomUUID());
const el=id=>document.getElementById(id); const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let currentState=null;
const stageCopy={awake:{title:'清醒：不产生阶段积分',body:'清醒时间不会获得睡眠阶段积分，但会降低这一晚的连续性系数。以下两项扣减只影响整晚最终积分。',rows:[['清醒阶段积分','0 分'],['初始连续性系数','100%'],['6 次中断扣减','12.0%'],['31 分钟清醒扣减','3.1%'],['最终连续性系数','84.9%']]},rem:{title:'快速眼动：每分钟 2 分',body:'快速眼动睡眠计入有效睡眠。本样例有 50 分钟，按每分钟 2 分计算。',rows:[['计分时长','50 分钟'],['每分钟积分','2 分'],['快速眼动阶段积分','100 分']]},core:{title:'浅睡：每分钟 1 分',body:'浅睡是阶段积分的基础计分项。本样例有 250 分钟，按每分钟 1 分计算。',rows:[['计分时长','250 分钟'],['每分钟积分','1 分'],['浅睡阶段积分','250 分']]},deep:{title:'深睡：本晚每分钟 2.926 分',body:'当前模型把 25% 设为深睡激励曲线中心，不是医学标准。本晚深睡占实际睡眠 25.9%，因此每分钟积分从最高 3 分轻微降为 2.926 分。',rows:[['实际睡眠总时长','405 分钟'],['深睡时长','105 分钟'],['本晚深睡占比','25.9%'],['模型曲线中心','25%'],['本晚每分钟积分','2.926 分'],['深睡阶段积分','约 307.2 分']]}};
function showStage(stage){const info=stageCopy[stage];if(!info)return;document.querySelectorAll('.stage-hotspot').forEach(button=>{const active=button.dataset.stage===stage;button.classList.toggle('active',active);button.setAttribute('aria-pressed',String(active))});const detail=el('stage-detail');detail.dataset.stage=stage;const rows=info.rows.map(row=>'<div class="stage-breakdown-row"><span>'+esc(row[0])+'</span><strong>'+esc(row[1])+'</strong></div>').join('');detail.innerHTML='<div class="stage-hint">当前颜色的积分明细</div><h3>'+esc(info.title)+'</h3><p>'+esc(info.body)+'</p><div class="stage-breakdown">'+rows+'</div>'}
document.querySelectorAll('.stage-hotspot').forEach(button=>{button.addEventListener('mouseenter',()=>showStage(button.dataset.stage));button.addEventListener('focus',()=>showStage(button.dataset.stage));button.addEventListener('click',()=>showStage(button.dataset.stage))});
async function api(path,body){const response=await fetch(path,{method:body?'POST':'GET',headers:{'content-type':'application/json'},body:body?JSON.stringify({...body,accountId}):undefined});const data=await response.json();if(!response.ok)throw new Error(data.error||'request failed');return data}
function cards(items,render,empty='暂无记录'){return items.length?items.map(render).join(''):'<p class="muted">'+empty+'</p>'}
function short(v){return v?esc(v.slice(0,12)+'…'+v.slice(-10)):'—'}
function yuan(amountFen){return '¥'+(Number(amountFen||0)/100).toFixed(2)}
function updateCashEstimate(){const policy=currentState?.cashPolicy,input=el('cash-points'),button=el('cash-submit');if(!policy||!input||!button)return;const points=Number(input.value);const valid=Number.isInteger(points)&&points>=policy.minimumPoints&&points<=policy.maximumPoints&&points<=currentState.account.points;const amountFen=valid?Math.floor(points*policy.rateFenPer100Points/100):0;el('cash-estimate').textContent=valid?yuan(amountFen):'¥0.00';button.disabled=!valid;el('cash-limit').textContent='最低 '+policy.minimumPoints+' 积分 · 单次最多 '+policy.maximumPoints+' · 当前余额 '+currentState.account.points}
function renderCash(s){const policy=s.cashPolicy;el('cash-mode').textContent=policy.payoutEnabled?'真实兑付已开通':'试点接入准备中';el('cash-rate').textContent='当期兑付率：100 积分 = '+yuan(policy.rateFenPer100Points)+'（可浮动区间 '+yuan(policy.rateFloorFenPer100Points)+'–'+yuan(policy.rateCeilingFenPer100Points)+'）';el('sponsor-budget').textContent=policy.sponsorBudgetStatus;el('payout-channel').textContent=policy.payoutChannel;el('cash-redemptions').innerHTML=cards(s.cashRedemptions,r=>'<div class="item"><b>'+yuan(r.amountFen)+' · '+r.points+' 积分</b><p class="truth">接入准备中 · 尚未打款</p><small>锁定汇率：100 积分 = '+yuan(r.rateFenPer100Points)+'<br>申请编号：<span class="mono">'+short(r.id)+'</span><br>收款渠道：'+esc(r.payoutChannel)+'</small></div>','尚无兑付申请');updateCashEstimate()}
function tokenMintCard(r,explorer){const confirmed=r.status==='confirmed';return '<div class="item"><b>'+r.points+' SLEEP · '+(confirmed?'真实已确认':esc(r.status))+'</b><p class="'+(confirmed?'truth':'muted')+'">Monad Testnet'+(r.blockNumber?' · 区块 #'+r.blockNumber:'')+'</p><small class="mono">收款 '+short(r.recipient)+'<br>睡眠承诺 '+short(r.claimCommitment)+'</small><br>'+(r.transactionHash?'<a target="_blank" rel="noreferrer" href="'+esc(explorer+'/tx/'+r.transactionHash)+'">查看真实铸币交易</a>':'')+'</div>'}
function updateTokenMint(){const policy=currentState?.tokenPolicy,input=el('token-recipient'),button=el('token-submit');if(!policy||!input||!button)return;const claim=currentState.claims.find(c=>c.status==='accepted');const valid=/^0x[0-9a-fA-F]{40}$/.test(input.value.trim());const already=currentState.tokenMints.length>0;el('token-estimate').textContent=(claim?.awardedPoints||0)+' SLEEP';el('token-limit').textContent=already?'该睡眠凭证已提交铸币':claim?'将 '+claim.awardedPoints+' 积分铸造为 '+claim.awardedPoints+' SLEEP':'请先计算样例 A 的睡眠积分';button.disabled=!policy.mintingEnabled||!claim||!valid||already}
function renderToken(s){const policy=s.tokenPolicy,explorer=s.network.explorerURL;el('token-mode').textContent=policy.mintingEnabled?'真实 Monad Testnet 铸币已开放':'测试网铸币暂未开放';el('token-contract').innerHTML='<b>'+esc(policy.tokenName)+' ('+esc(policy.tokenSymbol)+')</b><br>Chain ID '+s.network.chainId+' · 合约 <a target="_blank" rel="noreferrer" href="'+esc(explorer+'/address/'+policy.contractAddress)+'"><span class="mono">'+short(policy.contractAddress)+'</span></a>'+(policy.deploymentTransactionHash?'<br><a target="_blank" rel="noreferrer" href="'+esc(explorer+'/tx/'+policy.deploymentTransactionHash)+'">查看真实合约部署交易</a>':'');el('my-token-mints').innerHTML=cards(s.tokenMints,r=>tokenMintCard(r,explorer),'尚无个人铸币记录');el('public-token-mints').innerHTML=cards(s.publicTokenMints,r=>tokenMintCard(r,explorer),'首笔真实测试网铸币尚未执行');updateTokenMint()}
function scoreDetails(b){if(!b)return '<span class="muted">尚未计算样例 A。</span>';const m=b.stageMinutes||{};const notes=(b.inputNotes||[]).map(n=>'<li>'+esc(n)+'</li>').join('');const vendor=b.vendorReportedDeepPercent==null?'':'；设备展示 '+b.vendorReportedDeepPercent+'%（分母含清醒）';return '<h3>'+esc(b.sourceLabel)+' · '+b.awardedPoints+' 积分</h3><div class="score-grid"><div class="score-card"><strong>'+b.countedMinutes+' / 480 分钟</strong><span>有效睡眠；清醒 '+b.awakeMinutes+' 分钟不计基础分</span></div><div class="score-card"><strong>计分深睡 '+b.deepRatioPercent+'%</strong><span>目标 '+b.targetDeepPercent+'% · 有效 Deep 权重 '+b.effectiveDeepWeight+'×'+vendor+'</span></div><div class="score-card"><strong>连续性 × '+b.continuityFactor.toFixed(3)+'</strong><span>'+b.interruptionCount+' 次估计中断 · 清醒 '+b.awakeMinutes+' 分钟</span></div><div class="score-card"><strong>规律性 × '+b.regularityFactor.toFixed(3)+'</strong><span>'+esc(b.regularityBasis)+'</span></div></div><p class="mono">浅睡 '+(m.core||0)+'×1 + REM '+(m.rem||0)+'×2 + 深睡 '+(m.deep||0)+'×'+b.effectiveDeepWeight+' = '+b.stagePoints+' 阶段分</p><div class="equation">'+b.stagePoints+' × '+b.continuityFactor.toFixed(3)+' × '+b.regularityFactor.toFixed(3)+' = '+b.awardedPoints+' 积分</div><ul class="fine-print">'+notes+'</ul>'}
function render(s){currentState=s;el('balance').textContent=s.account.points;const scored=s.claims.find(c=>c.scoreBreakdown)?.scoreBreakdown;el('calculation').innerHTML=scoreDetails(scored);renderCash(s);renderToken(s);el('products').innerHTML=cards(s.products,p=>'<div class="item"><b>'+esc(p.title)+'</b><p>'+p.pricePoints+' 积分</p><button class="alt buy" data-product="'+esc(p.id)+'">兑换</button></div>');el('claims').innerHTML=cards(s.claims,c=>'<div class="item"><b>'+esc(c.nightKey)+' · +'+c.awardedPoints+' 积分</b>'+(c.scoreBreakdown?'<p>四维 V'+c.scoreBreakdown.scoringVersion+' · 阶段分 '+c.scoreBreakdown.stagePoints+' → 实发 '+c.awardedPoints+'</p>':'')+'<p class="truth">模拟确认 · '+c.chainReceipt.confirmations+' 次确认</p><small class="mono">凭证 '+short(c.chainReceipt.claimHash)+'<br>交易 '+short(c.chainReceipt.transactionHash)+'<br>区块 #'+c.chainReceipt.blockNumber+'<br>合约固定，凭证与交易唯一</small></div>');el('orders').innerHTML=cards(s.orders,o=>'<div class="item"><b>'+esc(o.title)+'</b><p>-'+o.pricePoints+' 积分</p><p class="truth">模拟确认 · '+o.chainReceipt.confirmations+' 次确认</p><small class="mono">兑换凭证 '+short(o.chainReceipt.claimHash)+'<br>交易 '+short(o.chainReceipt.transactionHash)+'<br>模拟区块 #'+o.chainReceipt.blockNumber+'<br>合约固定，每笔消费凭证唯一</small></div>');el('network').innerHTML=esc(s.network.name)+' · Chain ID '+s.network.chainId+'<br>固定审计合约：<span class="mono">'+esc(s.network.contractAddress||'待部署')+'</span>';el('batches').innerHTML=cards(s.batches,b=>'<div class="item"><b>'+esc(b.id)+'</b><p>'+b.claimCount+' 份凭证 · V'+b.scoringVersion+' · '+esc(b.chainStatus)+'</p><small class="mono">Merkle Root '+short(b.merkleRoot)+(b.blockNumber?'<br>真实区块 #'+b.blockNumber:'')+'</small><br>'+(b.transactionHash?'<a target="_blank" rel="noreferrer" href="'+esc(s.network.explorerURL+'/tx/'+b.transactionHash)+'">查看真实测试网交易</a>':'')+'</div>');document.querySelectorAll('.buy').forEach(button=>button.onclick=()=>buy(button.dataset.product))}
async function refresh(){try{render(await api('/api/demo/state?accountId='+encodeURIComponent(accountId)))}catch(e){el('status').textContent=e.message}}
async function action(path,body,message){try{el('status').textContent='处理中…';const state=await api(path,body);render(state);el('status').textContent=typeof message==='function'?message(state):message}catch(e){el('status').textContent=e.message}}
async function requestCashRedemption(){const points=Number(el('cash-points').value);try{el('cash-status').textContent='正在提交兑付申请…';const state=await api('/api/demo/cash-redemptions',{points});render(state);const record=state.cashRedemptions[0];el('cash-status').textContent='已记录 '+record.points+' 积分 ≈ '+yuan(record.amountFen)+'；当前未扣积分、未发起真实打款。'}catch(e){el('cash-status').textContent=e.message}}
async function requestTokenMint(){const recipient=el('token-recipient').value.trim();try{el('token-status').textContent='正在签名并发送 Monad Testnet 交易…';const state=await api('/api/demo/token-mints',{recipient});render(state);const record=state.tokenMints[0];el('token-status').innerHTML=record?.transactionHash?'铸币成功：'+record.points+' SLEEP 已写入区块 #'+record.blockNumber+'。':'铸币请求已记录。'}catch(e){el('token-status').textContent=e.message}}
const claim=profile=>action('/api/demo/claims',{profile},state=>{const item=state.claims.find(c=>c.nightKey==='disclosed-example-a');return item?'四维 V'+(item.scoringVersion||2)+' 已复算并发放 '+item.awardedPoints+' 沙盒积分':'四维计分完成'});const buy=productId=>action('/api/demo/orders',{productId},'沙盒兑换成功');async function resetDemo(){try{el('status').textContent='重置中…';await api('/api/demo/reset',{});localStorage.removeItem('sleepDemoAccount');location.reload()}catch(e){el('status').textContent=e.message}}refresh();
</script></body></html>`;
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
    const url = new URL(request.url);
    try {
      if (request.method === "GET" && url.pathname === "/") {
        return new Response(page(), { headers: htmlHeaders });
      }
      if (request.method === "GET" && url.pathname === "/team-preview") {
        return new Response(teamPreviewPage(), { headers: htmlHeaders });
      }
      if (request.method === "GET" && url.pathname === "/health") return json({ ok: true, mode: "sandbox", build: BUILD_ID });
      if (request.method === "GET" && url.pathname === "/api/demo/state") return json(await demoState(env, url.searchParams.get("accountId")));
      if (request.method === "POST" && url.pathname === "/api/demo/claims") return json(await createDemoClaim(env, await bodyFrom(request)), 201);
      if (request.method === "POST" && url.pathname === "/api/demo/orders") return json(await createDemoOrder(env, await bodyFrom(request)), 201);
      if (request.method === "POST" && url.pathname === "/api/demo/cash-redemptions") return json(await createCashRedemptionApplication(env, await bodyFrom(request)), 201);
      if (request.method === "POST" && url.pathname === "/api/demo/token-mints") return json(await createTokenMint(env, await bodyFrom(request)), 201);
      if (request.method === "POST" && url.pathname === "/api/demo/reset") {
        const payload = await bodyFrom(request);
        return json(await resetDemo(env, payload.accountId));
      }
      if (request.method === "POST" && url.pathname === "/api/admin/batches/prepare") {
        requireAdmin(request, env);
        return json(await prepareBatch(env), 201);
      }
      const anchorMatch = url.pathname.match(/^\/api\/admin\/batches\/([^/]+)\/anchor$/);
      if (request.method === "POST" && anchorMatch) {
        requireAdmin(request, env);
        return json(await anchorBatch(env, decodeURIComponent(anchorMatch[1])));
      }
      if (request.method === "GET" && url.pathname.startsWith("/assets/") && env.ASSETS) {
        return env.ASSETS.fetch(request);
      }
      return json({ error: "not found" }, 404);
    } catch (error) {
      if (error instanceof HTTPError) return json({ error: error.message }, error.status);
      console.error("Unhandled server error", error);
      return json({ error: "服务器暂时不可用" }, 500);
    }
  },
};
