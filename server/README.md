# 睡眠经济双路径演示服务器

一个已部署的 Cloudflare Pages Functions/Worker + D1 演示服务。中国路径使用中心化积分与人民币兑付申请；海外路径使用 Monad Testnet 的真实 SLEEP 测试代币铸币。公网页面：

<https://smart-sleep-economy-demo.pages.dev>

2026-09-05 的公共首页已从 `0.20-overseas-token-mint` 冻结为 `1.0-website`：保留原始睡眠截图、四维计分和品牌预付预算人民币兑付接入窗口，并在其后新增海外 Monad Testnet 真实铸币窗口。完整冻结清单见 [官网 v1.0 记录](../docs/WEBSITE_V1_0.md)。

原 Worker 地址作为 App 的自动备用线路：<https://smart-sleep-economy-demo.smart-sleep-economy-server.workers.dev>。

它提供：

- 由服务器按“时长、深度、连续性、规律性”四层独立重算的确定性模拟睡眠奖励。
- 每个浏览器/手机独立的沙盒账户、积分余额和流水。
- 三个无真实价值商品的兑换与订单记录。
- 按当期品牌活动汇率锁定报价并保存人民币兑付申请；当前状态为支付接入准备中。
- 为每晚睡眠和每笔积分兑换生成稳定且唯一的承诺、模拟交易和模拟区块，并与真实链上锚点分区显示。
- 将已接受凭证生成 SHA-256 Merkle Root 的管理员接口。
- 用专用测试网钱包将批次根写入 Monad Testnet 的管理员接口。
- 将一份已接受的睡眠积分凭证映射为 SLEEP，并由服务器受保护的钱包执行一次真实测试网铸币；公开显示合约、交易、区块与收款地址。

该服务不连接或上传 HealthKit，当前不生成人民币债务，也不是生产账户或支付系统。兑付申请会保存锁定报价，但品牌资金与企业商户转账通道尚未接入，所以状态固定为 `integration_pending`、不扣积分、不调用支付机构。样例 A 的计分接口只保存汇总分钟和明确标注的演示假设；公开网页另包含用户明确授权展示的原始截图。逐晚和逐笔商城兑换回执仍是流程模拟；海外 SLEEP 铸币则是真实 Monad Testnet 交易。测试网成功只证明代币被合约铸造，不证明睡眠输入经过硬件签名或身份审核。

## 四维 V2 计分

- 时长：实际睡眠最多计算 480 分钟，超过部分不继续增加积分。
- 深度：Core/浅睡为 1×、REM 为 2×；Deep 在实际睡眠占比 25% 时为 3×，向两侧逐渐回落，最低为 1×。
- 连续性：每次有效中断扣 2%，每分钟内部清醒扣 0.1%，系数最低 0.70。
- 规律性：正式版应与个人多晚基线比较；本次单晚演示与 21:00–07:00 演示目标比较，系数最低 0.70。

截图汇总为浅睡 250、REM 50、深睡 105、清醒 31 分钟；实际睡眠 405 分钟，Deep 占实际睡眠 25.9%。阶段分 657 × 连续性 0.849 × 规律性 0.700，四舍五入得到 **390 沙盒积分**。图中 6 次中断只是可见片段估计；图轴 457 分钟与阶段汇总 436 分钟相差的 21 分钟不自行补齐、不计分。详见 [睡眠积分经济系统设计](../docs/SLEEP_ECONOMY_DESIGN.md)。

`claims.scoring_version` 与 `score_breakdown_json` 保存版本和完整拆分；准备 Merkle 批次时只会合并相同计分版本的 claim，避免 V1/V2 混批。

## 人民币兑付接入试点

`GET /api/demo/state` 返回 `cashPolicy` 和当前账户的 `cashRedemptions`。`POST /api/demo/cash-redemptions` 接收整数积分，用服务器当期配置重新报价并保存申请。

- 汇率为 `CASH_RATE_FEN_PER_100_POINTS`，表示每 100 积分兑换的人民币“分”；当前值 100，即 100 积分 = ¥1.00。
- 每次申请保存报价版本、汇率、积分和人民币分值，后续汇率浮动不会改写旧记录。
- 金额用整数分计算，避免浮点误差。最小 100 积分，当期演示范围为每 100 积分 ¥0.80–¥1.20。
- 同一账户同时只保留一份待接入申请；无足额积分或超出范围会被服务器拒绝。
- 当前不收集姓名、身份证、微信 OpenID 或收款账户。生产上线前要完成品牌资金托管/预付、法律和税务评审、实名与风控、健康数据单独同意、企业支付通道、事务账本、回调验签、对账和申诉/追回。

## 海外 SLEEP 测试网铸币

`GET /api/demo/state` 同时返回 `tokenPolicy`、当前账户的 `tokenMints` 和最多 10 条公开已确认记录。`POST /api/demo/token-mints` 接收 EVM 收款地址，并只允许使用当前账户一份已接受的积分凭证。

- 规则：1 睡眠积分 = 1 SLEEP；18 位小数；单笔最多 1,000 SLEEP。
- 防重放：同一 claim commitment 只能铸造一次，同一收款地址只能参加一次。
- 硬上限：合约最大供应量 20,000 SLEEP；公开服务最多接受 20 笔有效铸币。
- 权限：只有合约 owner 可铸币。浏览器不接触私钥，Cloudflare 加密 secret 中的钱包负责支付测试网 gas。
- 失败处理：数据库先占用承诺与地址，随后模拟调用、发送交易并等待回执；保存 `preparing/submitted/confirmed/failed` 状态和错误摘要。
- 隐私：链上只有收款地址、积分数量和 32 字节加盐承诺，不包含姓名、心率、逐分钟阶段或精确睡眠时间。

代币实现为最小 ERC-20 兼容合约，可在测试网地址间转账，但当前没有主网部署、交易所/DEX 上架、流动性池或价格承诺。所谓“连接加密市场”在本阶段只完成链上可转账资产和公开可验证交易；真正市场交易必须在选择目标司法辖区后另做证券、税务、制裁、消费者保护、隐私、经济模型与合约审计。

## 本地运行

```sh
cd server
pnpm install --frozen-lockfile
pnpm test
pnpm db:local
pnpm dev -- --local
```

打开 <http://localhost:8787>。

## Cloudflare 部署

```sh
cd server
pnpm exec wrangler login
pnpm exec wrangler d1 create smart-sleep-economy-demo --location apac
pnpm db:remote
pnpm deploy
```

将同一服务发布到 App 默认使用的 Pages 域名：

```sh
cd server
pnpm exec wrangler pages deploy . --cwd pages --project-name smart-sleep-economy-demo --branch main --commit-dirty=true
```

`pages/_worker.js` 直接复用 `src/index.mjs`，两个公网入口连接同一个 D1 数据库；无需维护两套业务代码。

`ADMIN_TOKEN` 和 `MONAD_PRIVATE_KEY` 只能通过 Wrangler secret 保存，不能写入 Git：

```sh
pnpm exec wrangler secret put ADMIN_TOKEN
pnpm exec wrangler secret put MONAD_PRIVATE_KEY
```

## Monad Testnet

- Chain ID：`10143`
- RPC：`https://testnet-rpc.monad.xyz`
- 水龙头：<https://faucet.monad.xyz>
- 测试网钱包私钥不在仓库中；当前 Mac 使用钥匙串 service `com.momomac.smart-sleep-economy.monad-testnet` 保管。

本地部署批次锚合约：

```sh
MONAD_PRIVATE_KEY=... node scripts/deploy-contract.mjs
```

部署后将合约地址写入 `wrangler.jsonc` 的 `CONTRACT_ADDRESS`，重新 `pnpm deploy`。

部署 SLEEP 测试代币：

```sh
MONAD_PRIVATE_KEY=... node scripts/deploy-sleep-token.mjs
```

部署后配置 `SLEEP_TOKEN_ADDRESS`、`SLEEP_TOKEN_DEPLOYMENT_TX` 和 `SLEEP_TOKEN_MAX_MINTS`；把 `MONAD_PRIVATE_KEY` 分别保存为 Worker 与 Pages 的加密 secret，禁止写入仓库或前端。

管理员批次流程：

```text
POST /api/admin/batches/prepare
POST /api/admin/batches/{batchId}/anchor
Authorization: Bearer <ADMIN_TOKEN>
```

`prepare` 只选取尚未分批的沙盒凭证；`anchor` 成功后保存真实交易哈希和合约地址。

首个无真实健康数据批次 `batch-1788524456585-9c40aee5` 已完成锚定。合约、交易、Merkle Root 和 RPC 交叉核验结果见 [测试网部署记录](../docs/MONAD_TESTNET_DEPLOYMENT.md)。

## 验证边界

- `SANDBOX` 积分可以用来演示，但不能兑换真实商品或法定货币。
- App Attest、实名、厂商签名和真实 HealthKit 凭证上传仍未接入。
- 当前公开沙盒没有生产级限流和库存预留；引入真实价值前必须更换为完整身份、风控和交易架构。
- SLEEP 只存在于 Monad Testnet。它可转账但没有主网价值、流动性或收益承诺；合约未经过生产安全审计。

2026-09-05 `0.16` 验证：远端 D1 的 V2 迁移已应用；领域测试 8/8 通过。公网一次性隔离账户实测样例 A 得到阶段小计 657、最终 390 分，第二次领取返回 409；兑换眼罩后余额由 390 变为 210，重置后回到 0，测试账户已清理。本地临时 D1 还验证了 V1 与 V2 会拆成两个批次。

2026-09-05 `0.17` 验证：原始截图已作为 1206×2371 JPEG 静态资源发布，公网文件散列与用户提供文件一致；旧横向阶段条已移除。自动测试 9/9，Pages 与 Worker 的 `/health` 均返回 `0.17-interactive-sleep-stage`；Pages 原图直出和 Worker 备用页跨域回退均成功。浏览器实测四个阶段均可点按，REM 可通过鼠标悬停显示 `50 × 2 = 100`，深睡显示本晚动态 `105 × 2.926 ≈ 307.2`，领取仍为 390 分，测试账户随后重置。以上只验证公开素材、交互与沙盒计分，不证明真实睡眠真实性或可兑付能力。

2026-09-05 `0.18` 验证：用户反馈原图过大且右侧公式难读后，桌面原图缩至 350px、手机上限缩至 290px；四个阶段的说明改为中文账单行。清醒明确列出 0 分、两类扣减和最终 84.9% 连续性系数；Deep 明确列出 405 分钟实际睡眠、105 分钟深睡、25.9% 占比、2.926 分/分钟及约 307.2 阶段分，并说明 25% 是模型曲线中心而非医学标准。自动测试 9/9；Pages 和 Worker `/health` 均返回 `0.18-compact-clear-stage`，公开页尺寸及清醒、Deep 点按交互已验证。

2026-09-05 `0.19` 验证：本地与公网隔离账户均实测 390 积分按当期汇率报价为 390 分（¥3.90），保存 `integration_pending` 记录后积分仍为 390；重复待处理申请返回 409，测试账户已重置。自动测试 10/10，Pages 与 Worker `/health` 均返回 `0.19-cash-redemption-pilot`，公网界面和报价交互已验证。这些只证明接口、数据库、金额计算与界面可用，不证明已实现真实打款。

2026-09-05 `0.20` 验证：远端 D1 的 `0005_overseas_token_mint.sql` 已应用；SLEEP 合约已真实部署，部署区块为 `59855944`。稳定 Pages 接口完成 390 SLEEP 首笔铸币，交易区块为 `59857768`。独立 RPC 读取确认 `name/symbol/owner` 正确、收款余额与总供应量均为 390 SLEEP、该 claim commitment 已消费，交易回执为 success 且目标为 SLEEP 合约。自动测试 10/10、服务端语法检查通过，Solidity 源码与测试合约通过 solcjs 编译；本机无 Foundry，未执行 Forge 测试。桌面和 390px 手机视口均完成浏览器检查，页面无控制台错误。
