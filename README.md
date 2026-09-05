# MOMO Sleep Economy System

**让所有人躺着赚钱 · Make Your Sleep Count.**

MOMO 是一个面向黑客松演示的睡眠经济系统原型：用可穿戴设备与 Apple Health 提供睡眠数据入口，用透明算法生成可复算积分，并用中心化沙盒和 Monad Testnet 展示奖励、兑换与审计凭证。

[在线演示](https://smart-sleep-economy-demo.pages.dev) · [Monad 测试网部署记录](docs/MONAD_TESTNET_DEPLOYMENT.md)

## 已实现

- 原生 SwiftUI iPhone App，读取 HealthKit 的 `sleepAnalysis` 及来源信息。
- 基于上床时间、预计入睡耗时、可调周期和唤醒窗口预测周期边界；iOS 26+ 优先使用 AlarmKit。
- 最长 8 小时、睡眠结构、连续性、规律性四维确定性计分，同一输入可以复算。
- Cloudflare Workers / Pages Functions + D1 的积分账户、兑换、兑付申请和审计批次演示。
- 每晚和每笔兑换的唯一承诺；原始健康数据不上链。
- Monad Testnet 睡眠批次锚定合约与限量 SLEEP 测试代币铸币演示。
- iOS XCTest、纯 Swift 核心检查、Node 测试和 Solidity Foundry 测试。

## 架构

```text
RingConn / Apple Health
          ↓
 SwiftUI + HealthKit App
          ↓
确定性评分与本地凭证
          ↓
Cloudflare Worker / Pages Functions
          ↓
       D1 账本
          ↓
加盐承诺 / Merkle Root
          ↓
      Monad Testnet
```

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
pnpm exec wrangler dev
```

Cloudflare 密钥、管理员密钥和 Monad 测试钱包私钥必须通过 Secrets/环境变量提供，仓库不包含任何真实凭据。

### 合约

```sh
cd contracts
forge test
```

## 验证边界

- RingConn 睡眠数据更像在睡眠结束并完整生成后批量同步；本项目不宣称已经实现实时睡眠阶段唤醒。
- HealthKit 后台观察不是精确定时器；AlarmKit 的真机授权和锁屏响铃仍需按设备测试。
- App Attest、HealthKit 来源和链上交易都不能单独证明“一个人真的睡着了”。
- 人民币兑付界面仍是 `integration_pending` 流程演示，不代表真实到账。
- SLEEP 仅为 Monad Testnet 测试代币，没有主网价值、流动性或收益承诺。
- 这是黑客松原型，不构成医疗建议、金融产品或生产级合规系统。

更完整的方案见 [开发计划](docs/DEVELOPMENT_PLAN.md) 与 [睡眠经济系统设计](docs/SLEEP_ECONOMY_DESIGN.md)。
