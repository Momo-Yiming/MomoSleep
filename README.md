# MOMO Sleep Economy System

**让所有人躺着赚钱 · Make Your Sleep Count.**

MOMO 是一个面向黑客松演示的睡眠经济系统原型。原生 iPhone 客户端经授权读取 Apple Health 睡眠记录；独立公网页使用已披露的授权样例，演示可复算积分、沙盒兑换和 Monad Testnet 凭证。这两条路径尚未形成戒指数据自动上传、自动上链的生产流程。

[在线演示](https://smart-sleep-economy-demo.pages.dev) · [英文 Web App](https://smart-sleep-economy-demo.pages.dev/app?lang=en) · [中文 Web App](https://smart-sleep-economy-demo.pages.dev/app?lang=zh) · [Monad 测试网部署记录](docs/MONAD_TESTNET_DEPLOYMENT.md)

## 已实现

- 原生 SwiftUI iPhone App，读取 HealthKit 的 `sleepAnalysis` 及来源信息。
- 基于上床时间、预计入睡耗时、可调周期和唤醒窗口预测周期边界；iOS 26+ 优先使用 AlarmKit。
- 最长 8 小时、睡眠结构、连续性、规律性四维确定性计分，同一输入可以复算。
- Cloudflare Workers / Pages Functions + D1 的积分账户、兑换、兑付申请和审计批次演示。
- 独立双语 `/app` 复用同一沙盒账本；稳定兑换请求编号防止重试重复扣分。
- 每晚和每笔兑换的唯一承诺；原始健康数据不上链。
- Monad Testnet 睡眠批次锚定合约与限量 SLEEP 测试代币铸币演示。
- iOS XCTest、纯 Swift 核心检查、Node 测试和 Solidity Foundry 测试。

## 架构

```text
原生 iPhone 路径
RingConn Gen 2 → RingConn App → Apple Health
                                   ↓ 用户授权
                         SwiftUI + HealthKit 读取与来源检查
                                   ↓
                         本地计分、唤醒规划与凭证

独立公网页 /app 路径（已披露样例，不访问访客 HealthKit）
授权公开样例 → 服务器重算 → D1 沙盒账本
                              ├→ 模拟逐晚 / 商城回执
                              ├→ 人民币申请：integration_pending
                              └→ 受保护的 Testnet mint / 管理员批次 anchor
                                         ↓
                            链上承诺 / Merkle Root / 代币事件
```

原始健康记录保持链下；来源元数据与区块链回执不能证明真实睡眠。已实现的原生读取链路与公网页演示应分别验收，公网页没有读取或上传访问者的 HealthKit 数据。

## Web App 1.1

Web App 1.1 加入显式刷新、随机虚构人物与夜晚、服务端计分及多晚记录；兑换中心包含商品、人民币试点申请与虚拟 SLEEP 兑换。随机数据不具备真实上链资格，人民币未接通打款，虚拟代币没有经济价值。该版本为浏览器 App 更新，原生 iOS App 单独验收。

## Web App 1.2

Web App 1.2 进一步加入随睡眠一起随机的年龄、具体职业与人物标记，以及戒指、手表、手环的绑定入口和前端接入事件。硬件暂未打通，入口明确保持“待接入 / 未连接”，不读取设备或健康数据。

## 目录

- `SmartSleepAlarm/`、`SmartSleepAlarm.xcodeproj/`：iOS/macOS 客户端、HealthKit、AlarmKit、积分与凭证逻辑。
- `SmartSleepAlarmTests/`、`scripts/`：单元测试、核心自检、macOS 构建和真机观察工具。
- `server/`：Cloudflare 后端、D1 migrations、公开网页、计分和测试网接口。
- `contracts/`：睡眠批次锚定与 SLEEP 测试代币合约。
- `docs/`：开发阶段、隐私边界、经济系统和测试网部署说明。

## 本地运行

### iOS

1. 用 Xcode 打开 `SmartSleepAlarm.xcodeproj`。
2. 在 Signing & Capabilities 选择自己的 Team。
3. 在真机授权 HealthKit、通知和 AlarmKit；模拟器不能验证 HealthKit 后台投递。

```sh
xcodebuild -project SmartSleepAlarm.xcodeproj \
  -scheme SmartSleepAlarm \
  -destination 'generic/platform=iOS' \
  CODE_SIGNING_ALLOWED=NO build
```

### 后端与网页

```sh
cd server
pnpm install
pnpm test
pnpm db:local
pnpm exec wrangler dev
```

部署到自己的 Cloudflare 账户前，创建 D1 并替换两份 Wrangler 配置中的全零 `database_id`。按顺序应用 `0001`–`0008` 迁移；Worker 与 Pages 应绑定同一个数据库。Cloudflare 密钥、管理员密钥、监控密码和 Monad 测试钱包私钥通过 Secrets/环境变量提供。运行与恢复说明见 [服务器 README](server/README.md)。

### 合约

```sh
cd contracts
forge test
```

## 验证边界

- RingConn 睡眠数据更像在睡眠结束并完整生成后批量同步；本项目不宣称已经实现实时睡眠阶段唤醒。
- HealthKit 后台观察不是精确定时器；AlarmKit 的真机授权和锁屏响铃仍需按设备测试。
- App Attest、HealthKit 来源和链上交易都不能单独证明“一个人真的睡着了”。
- 未知链上结果会保留额度并恢复同一已签交易，不用网络超时推断铸币失败；只有精确匹配的账户、凭证与收款地址重试才返回原结果。
- 人民币兑付界面仍是 `integration_pending` 流程演示，不代表真实到账。
- SLEEP 仅为 Monad Testnet 测试代币，没有主网价值、流动性或收益承诺。
- 这是黑客松原型，不构成医疗建议、金融产品或生产级合规系统。

更完整的方案见 [开发计划](docs/DEVELOPMENT_PLAN.md) 与 [睡眠经济系统设计](docs/SLEEP_ECONOMY_DESIGN.md)。
