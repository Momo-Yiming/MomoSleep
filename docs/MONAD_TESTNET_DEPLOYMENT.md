# Monad Testnet 部署记录

状态：2026-09-05 已部署并验证。以下内容全部是公开测试网信息；仓库不保存私钥或管理员密钥。

## 服务与网络

- 公网演示：<https://smart-sleep-economy-demo.pages.dev>
- API 备用线路：<https://smart-sleep-economy-demo.smart-sleep-economy-server.workers.dev>
- 网络：Monad Testnet
- Chain ID：`10143`
- RPC：`https://testnet-rpc.monad.xyz`
- 区块浏览器：<https://testnet.monadscan.com>

## 合约部署

- 合约：`SleepBatchAnchor`
- 地址：[`0x5dea033080d3f3420a3ee68b2e355a79135cbd84`](https://testnet.monadscan.com/address/0x5dea033080d3f3420a3ee68b2e355a79135cbd84)
- 部署交易：[`0x1e345def990e13778e69743399f18bc691eca739662903ddb19db5c8182e8aa9`](https://testnet.monadscan.com/tx/0x1e345def990e13778e69743399f18bc691eca739662903ddb19db5c8182e8aa9)
- 部署 RPC 验证：回执 `status = 0x1`，回执合约地址一致，链上代码长度 1,877 字节。

## 首个模拟批次

- 批次 ID：`batch-1788524456585-9c40aee5`
- 批次哈希：`0x96fe3a4932712ae54feda47f728597b4bf71e3a6eb14224968287520705112e2`
- Merkle Root：`0x81ea69a6d836ee1a9d4c0a75df4ace96e45b4e1f9091e44eee006ac4ba78b4d8`
- 计分版本：`1`
- 凭证数量：`1`
- 锚定交易：[`0xa7fcc597b6265585f38846a47b2d88dd17a2cbbc24d597085cd51c501999c695`](https://testnet.monadscan.com/tx/0xa7fcc597b6265585f38846a47b2d88dd17a2cbbc24d597085cd51c501999c695)
- 交易区块：`59626845`

## 海外 SLEEP 测试代币

- 合约：`MOMO Sleep Test Token (SLEEP)`
- 地址：[`0xe6ab81d7e4f7028b7aa9bbda23c6001acb70495e`](https://testnet.monadscan.com/address/0xe6ab81d7e4f7028b7aa9bbda23c6001acb70495e)
- 部署交易：[`0x511faa3c1897514118715adba3c8dadaba75927cdb04bcde1ba0617b1695c07e`](https://testnet.monadscan.com/tx/0x511faa3c1897514118715adba3c8dadaba75927cdb04bcde1ba0617b1695c07e)
- 部署区块：`59855944`
- Owner：`0xcaEd6161ddAC18550F53da2BCD20739CF6D408e8`
- 规则：1 积分 = 1 SLEEP；单笔最多 1,000；合约总供应量最多 20,000 SLEEP。

## 首笔真实铸币

- 积分/数量：`390` / `390 SLEEP`
- 收款地址：`0xcaEd6161ddAC18550F53da2BCD20739CF6D408e8`
- 睡眠承诺：`0x7d6961f1503222f18e48daa77b72bcf206628a4cacfe71bd95ef55bfe7d0b80b`
- 铸币交易：[`0xdbb39b6f4f5bce80f5c9dc306801259d8f6b6a0e9809c1182b23539a89df96e7`](https://testnet.monadscan.com/tx/0xdbb39b6f4f5bce80f5c9dc306801259d8f6b6a0e9809c1182b23539a89df96e7)
- 交易区块：`59857768`

RPC/viem 交叉核验结果：代币名称和符号正确；owner 与部署钱包一致；收款余额和 `totalSupply` 均为 `390 × 10^18`；`usedCommitments` 对上述承诺返回 true；交易回执为 success，交易目标为 SLEEP 合约。

## 验证方法与边界

使用 Monad JSON-RPC/viem 完成三项独立检查：

1. 锚定交易回执为 `success`。
2. 交易 `to` 等于上面的合约地址。
3. 调用 `batches(batchHash)` 得到的 Merkle Root、计分版本和凭证数量与 D1 中的批次一致。

公网演示页显示同一审计合约、批次、SLEEP 合约和真实铸币交易。审计批次和首笔铸币都使用服务器演示数据，不含 HealthKit 原始数据或用户身份；链上成功分别只证明“批次摘要被写入”和“SLEEP 被铸造”，都不证明睡眠真实性。

网页 0.10 另外为每次模拟睡眠显示不同且刷新稳定的“模拟凭证、模拟交易、模拟区块”，以演示逐晚唯一记录。它们不能在区块浏览器查询，不属于上面的真实测试网证据。正式系统仍使用固定 Monad 网络和固定 `SleepBatchAnchor` 合约，每次批量锚定时产生新的 Merkle Root、真实交易和真实区块；不会为每晚重复部署合约。

网页/App 0.11 又为每笔积分兑换增加了不同且刷新稳定的兑换承诺、模拟交易和模拟区块。它们同样不是测试网交易。0.20 新增的 SLEEP 铸币是另一条海外测试网演示路径，不改变中国积分消费记录仍需批次审计的设计。当前公开铸币接口受一晚一承诺、一地址一次、20 笔服务上限和 20,000 SLEEP 合约硬上限约束；服务器钱包从不发送到前端。
