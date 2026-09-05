# 分阶段开发计划

状态：2026-09-05 Phase 1 已完成并升级为 App 0.15；基础产品路线是“唤醒窗口内最晚预计周期边界 + AlarmKit”，不再等待 RingConn 实时睡眠阶段。睡眠经济演示已加入可版本化四维 V2 计分、中国品牌预算人民币兑付接入试点，以及官网海外 SLEEP Monad Testnet 真实铸币演示；Phase 0 多晚验证继续作为未来增强评估。

## 事实边界

| 问题 | 当前结论 | 证据/边界 |
| --- | --- | --- |
| RingConn 是否在睡眠未结束时增量写入 `sleepAnalysis`？ | **尚无证据，不能作为设计前提。** | 真机已读取 33 条 RingConn 来源样本并收到 3 次 observer 回调，但三次计数均为 33，且无法确认当时睡眠仍在进行。RingConn 支持页称睡眠在 fully generated 后同步；仍需多晚实测。|
| 心率等指标能否用于验证同步链路？ | 可以验证 RingConn → Apple Health → observer/query 的通用链路，但不能外推睡眠阶段的生成时机。 | 真机已观察到后台指标回调和数分钟尺度的新心率样本；RingConn 官方仍把心率等约 30 分钟同步与睡眠 fully generated 后同步分开说明。|
| HealthKit 可否后台读取？ | 可请求 HealthKit 新样本触发后台投递；不是持续运行或准时执行。 | `HKObserverQuery` + `enableBackgroundDelivery`，iOS 15+ 需 Background Delivery entitlement；必须及时调用 completion，否则会退避/停止。|
| `BGAppRefreshTask` 可否当闹钟？ | 不可。 | `earliestBeginDate` 仅为最早时间，具体运行由系统决定。|
| 本地通知是否可靠闹钟？ | 可由系统在 App 不运行时按时间投递；不是绕过用户系统设置的保证。 | 依赖授权，可能受 Focus/静音策略等影响；Critical Alerts 需额外 entitlement，MVP 不申请。|
| AlarmKit 能否改进可靠性？ | iOS 26+ 可以，作为当前首选预定闹钟。 | Apple 说明 AlarmKit 闹钟可突破静音和专注模式；仍需用户授权，而且只能在预定时间响，不能提供实时睡眠阶段。|

官方资料：[RingConn Gen 2 support](https://ringconnsg.com/pages/support-gen-2)、[HealthKit 授权](https://developer.apple.com/documentation/healthkit/authorizing-access-to-health-data)、[HealthKit 后台投递](https://developer.apple.com/documentation/healthkit/hkhealthstore/enablebackgrounddelivery(for:frequency:withcompletion:))、[后台任务](https://developer.apple.com/documentation/uikit/using-background-tasks-to-update-your-app)、[AlarmKit](https://developer.apple.com/documentation/AlarmKit/scheduling-an-alarm-with-alarmkit)、[本地通知](https://developer.apple.com/documentation/usernotifications/scheduling-a-notification-locally-from-your-app)。

## Phase 0 — 可行性验证（先做）

目标：回答 RingConn 是否能在目标唤醒窗口前提供足够新鲜的分期数据。

- 技术栈：真机 iPhone、RingConn、Apple Health、此 POC 的 `HKSampleQuery` / `HKObserverQuery`；不使用私有 API。
- 数据流：RingConn ring → RingConn App → Apple Health `HKCategoryType.sleepAnalysis` → observer/query → 本地日志/屏幕 → 人工导出记录。
- 权限/API：HealthKit read `sleepAnalysis`、`HKSampleQuery`、`HKObserverQuery`、`enableBackgroundDelivery(for:frequency:)`。
- 记录：每次入睡前后、夜间醒来、起床后记录 RingConn App 同步、Health 中每个样本的 start/end/value/source、observer 回调时间；固定记录 iOS、RingConn App、固件版本（不写入仓库的个人标识）。
- 通过条件：至少 5 晚中，睡眠结束前出现 RingConn 来源的新增/更新阶段样本，且在目标唤醒窗口内到达；否则判为 **实时动态路线不成立**。
- 风险：Health 样本可能是整段写入、被覆盖、无精细阶段、被其他来源优先级遮蔽；读取授权被拒绝时表现为空数据。
- 测试与产物：[Phase 0 记录表](PHASE_0_DEVICE_LOG.md)，结论必须标为真机实测，不能以模拟数据替代。
- 辅助探针：读取最近 24 小时的心率、静息心率、血氧、呼吸频率和步数，比较 RingConn 样本数/最新时间及 observer 回调；它只校验链路，不作为睡眠分期增量写入的替代证据。

## Phase 1 — 最小可运行 App（已完成并真机运行）

目标：证明本地判定和通知链路，而不是证明硬件实时数据。

- 技术栈：Swift 5、SwiftUI、HealthKit、AlarmKit、UserNotifications、XCTest；无第三方依赖。
- 数据流：睡前按键时间 + 预计入睡耗时 + 可调周期 + 唤醒窗口 → `WakePlanner` 选择窗口内最晚完整周期边界 → AlarmKit；窗口内无边界时使用窗口结束时间，iOS 26 以下或 AlarmKit 未授权时降级 `UNCalendarNotificationTrigger`。HealthKit 数据继续用于验证和起床后复盘。
- 权限：`NSHealthShareUsageDescription`、`NSAlarmKitUsageDescription`、普通通知授权；HealthKit capability；可选 Background Delivery entitlement。
- 关键 API：`AlarmManager.requestAuthorization()`、`AlarmManager.schedule`、`Alarm.Schedule.fixed`、`HKSampleQuery`、`HKObserverQuery`、`UNCalendarNotificationTrigger`。
- 判定：若检测到 RingConn 来源，先只取该来源（避免与 Apple Watch 等重叠来源混算）；以最长 2 小时无样本为边界取最近睡眠会话并合并重叠区间；总睡眠 ≥ `minimumSleep`；Deep + REM ≥ `minimumDeepREM`；最近阶段属于允许阶段；当前时刻落在配置唤醒窗口。默认允许 REM/Core/未指定睡眠，默认窗口 06:30–07:00。
- 产品说明边界：周期预测的目标是减少在估算周期中段被叫醒的概率、降低睡眠惯性的可能性；不宣称“必然最清醒”。默认 90 分钟不是固定生理常数，用户可在 70–120 分钟调整。当前 RingConn 数据不足以在闹钟响起前确认真实阶段。
- 测试：App 内一键自检以默认策略自动运行五类场景并逐项显示预期/实际结果，不修改用户配置；纯逻辑测试还覆盖重叠样本去重、前一晚隔离和窗口跨午夜。手动测试通知。XCTest 不接触 HealthKit；无 XCTest 环境可运行 `scripts/CoreCheck.swift`。
- Phase 0 记录：本地受文件保护的 JSON 仅保存样本数量、来源、最新结束时间及人工备注，不保存完整 HealthKit 样本；可分享 CSV 文本和 Markdown 验收摘要。摘要只把“睡眠仍在进行且已有 RingConn 样本”的记录计为候选证据，模拟来源不计入。
- 当前验证（2026-09-05）：Xcode 26.6 / iOS 26.5 SDK 的设备和模拟器构建通过，`SmartSleepAlarmTests` 24/24、核心检查 13/13 通过；App 0.15（build 22）已完成 Personal Team 真机签名构建。此前 App 0.13 已覆盖安装并在真机启动；本次未将 App 0.15 安装到 iPhone，不能把签名构建记录为已覆盖安装。AlarmKit 的实际授权、锁屏响铃、周期参数准确性和用户醒后清醒度仍须真机真人实验。此前真机 HealthKit、普通通知和指标 observer 结果继续有效；睡眠进行中增量写入仍未验证。
- 可运行验证版（2026-09-05）：macOS App 已同步到与 iPhone App 0.15（build 22）相同的共享首页、预计周期边界唤醒、判定器、模拟数据、Phase 0 记录、四维 V2 睡眠经济界面和人民币兑付接入试点；构建脚本自动同步工程版本、结束旧进程、生成最低 macOS 13.0 的签名产物，并稳定安装到 `$HOME/Applications/智能睡眠闹钟.app`。实际验证了严格签名、启动、Pages 在线经济页、390 分样例明细以及兑付页的试点状态、汇率、人民币估值和未接入提示。该结果不覆盖 iPhone HealthKit、AlarmKit、RingConn、锁屏响铃或真实资金到账。
- 分支覆盖：macOS 成品仅由构建脚本显式定义 `VALIDATION_APP`，只替换不可用的 HealthKit/AlarmKit 能力，仍复用 UserNotifications 和共享业务/UI；默认 Xcode iOS 构建走真实 HealthKit、AlarmKit 与 UserNotifications 控制流。默认控制流已通过 iOS SDK 构建、真机 HealthKit 读取与普通本地通知投递验证；AlarmKit 锁屏响铃仍待真机验证。

## Phase 2 — 真机后台与实时性评估

前提：基础闹钟已接受“预测唤醒 + 起床后分析”；只有要增加实时增强时才依赖 Phase 0 结果。

- 当前 POC 在 SwiftUI 根视图启动时重建 observer，并在重新查询完成后调用 completion；Phase 2 需按 Apple 建议迁移到更早的应用启动路径，并用 anchored query 去重（UUID/anchor）。
- 用实际到达时刻与用户目标唤醒时间计算延迟分布，测试锁屏、低电量、专注模式、应用被杀、网络关闭/打开、RingConn 未连接、Health 读取被撤回。
- 不以 `BGAppRefreshTask` 驱动唤醒；只用于非关键 UI 刷新。
- 通过条件：仅当最坏情况延迟仍满足产品承诺，才允许把 observer 结果用于重新安排未来通知。否则固定备用通知必须始终存在。

## Phase 3 — 产品化与替代路线

- 若 Phase 2 通过：以预先安排的最晚起床通知为保底，在新鲜阶段数据到达且窗口内时仅提前/调整一次通知；完整记录决策和样本版本。
- 若 Phase 2 不通过（当前更可能）：保留“睡前预测周期 + AlarmKit + 起床后报告”；若必须按真实阶段唤醒，则改接能在夜间通过受支持通道提供实时数据的设备/服务。不通过私有 BLE/逆向协议绕开限制。
- 增加可访问性、隐私说明、数据最小化、本地日志删除、错误态与 App Review 核查。医疗/治疗/保证唤醒声明均不进入产品文案。

## 睡眠经济系统并行路线（2026-09-05）

- **E0 本地概念验证（已完成）**：App 已加入 8 小时封顶、25% Deep 渐变权重、连续性和规律性系数、重叠合并、冲突剔除、模拟数据零结算、本地生理夜去重、加盐承诺、Merkle Root 和包含证明。用户授权公开的样例 A 可确定性复算为 390 沙盒积分；截图中断数和单晚作息目标均明确标为演示假设。
- **E1 中心服务器沙盒（已完成，非生产结算）**：Cloudflare Pages Functions/Worker + D1 已将 `0.20-overseas-token-mint` 冻结为 Website v1.0（构建 `1.0-website`）；App 0.15 默认连接 `pages.dev` 并保留 `workers.dev` 自动备用。服务器按 V2 独立重算四维积分，保存计分版本与拆分，并禁止 V1/V2 混入同一 Merkle 批次。中国路径的兑付申请按当期汇率锁定人民币分值：当前 100 积分 = ¥1.00，390 积分 = ¥3.90。当前品牌资金、企业商户支付通道、App Attest、KYC、税务与风控均未完成，因此人民币状态只能为 `integration_pending`，不扣积分、不发起真实转账。
- **E2 Monad 批次审计锚（沙盒已完成）**：`SleepBatchAnchor.sol` 只存储每日 Merkle Root、计分版本和凭证数量；不上链原始健康数据、个人标识或用户钱包。网络和合约固定，每个正式批次生成新的 Root、真实交易和区块。合约与首个模拟批次已真实写入 Monad Testnet；RPC 回执、交易目标和合约读取结果均已交叉核验。公开证据见 [测试网部署记录](MONAD_TESTNET_DEPLOYMENT.md)。生产环境仍需多签 owner、密钥轮换、告警和定时重试。
- **E2b 海外测试网铸币（官网演示已完成）**：`SleepRewardToken.sol` 是有 20,000 SLEEP 硬上限的 ERC-20 兼容测试代币；每份承诺和每个地址只能铸造一次，单笔最多 1,000 SLEEP，公开服务最多 20 笔。合约已部署并完成首笔 390 SLEEP 真实交易，余额、总供应量、承诺消费和回执已通过 RPC 交叉核验。它只证明铸币发生，不证明样例为硬件签名睡眠；主网、DEX/交易所、流动性、生产合约审计和海外合规均未完成。
- **E3 小额合规试点（已完成产品/接口准备，真实资金试点未开始）**：已完成浮动汇率展示、整数分报价、报价版本锁定、申请记录与界面风险提示。完成中国法律、税务、支付、广告、个人信息与健康数据审查，并接入品牌资金和企业商户通道后，才能启动限额、延迟结算和可追回机制的真实试点。首期禁止积分购买、P2P 交易和任何固定收益宣传。

详细数据流、真实性分层、服务器接口、链上数据最小化和验收门槛见 [睡眠积分经济系统设计](SLEEP_ECONOMY_DESIGN.md)。
