import Foundation
import SwiftUI
#if VALIDATION_APP
import AppKit
#endif

enum MockScenario: String, CaseIterable, Identifiable {
    case wakeReady
    case tooShort
    case insufficientDeepREM
    case latestAwake
    case outsideWindow

    var id: String { rawValue }

    var title: String {
        switch self {
        case .wakeReady: "满足所有条件"
        case .tooShort: "睡眠时长不足"
        case .insufficientDeepREM: "Deep + REM 不足"
        case .latestAwake: "最近阶段为 Awake"
        case .outsideWindow: "不在唤醒窗口"
        }
    }

    var expectedReason: String {
        switch self {
        case .wakeReady: "满足 MVP 唤醒条件"
        case .tooShort: "总睡眠未达最短时长"
        case .insufficientDeepREM: "Deep + REM 累积不足"
        case .latestAwake: "最近阶段不适合唤醒"
        case .outsideWindow: "尚未进入唤醒窗口"
        }
    }
}

struct ScenarioCheckResult: Identifiable {
    let scenario: MockScenario
    let actualReason: String

    var id: String { scenario.id }
    var passed: Bool { actualReason == scenario.expectedReason }
}

@MainActor
final class SleepViewModel: ObservableObject {
    @Published private(set) var samples: [SleepSample] = [] {
        didSet { saveDiagnosticState() }
    }
    @Published private(set) var status = "尚未读取；HealthKit 空结果也可能代表未授予读取权限。" {
        didSet { saveDiagnosticState() }
    }
    @Published private(set) var notificationStatus = UserDefaults.standard.string(forKey: "notification-status") ?? "尚未测试" {
        didSet {
            UserDefaults.standard.set(notificationStatus, forKey: "notification-status")
            saveDiagnosticState()
        }
    }
    @Published private(set) var policy: SleepPolicy
    @Published private(set) var estimatedSleepLatencyMinutes: Int
    @Published private(set) var estimatedCycleMinutes: Int
    @Published private(set) var selectedMockScenario: MockScenario = .wakeReady
    @Published private(set) var scenarioCheckResults: [ScenarioCheckResult] = []
    @Published private(set) var metricSnapshots: [HealthMetricSnapshot] = [] {
        didSet { saveDiagnosticState() }
    }
    @Published private(set) var metricObserverCallbackCount = 0 {
        didSet { saveDiagnosticState() }
    }
    @Published private(set) var latestMetricObserverAt: Date? {
        didSet { saveDiagnosticState() }
    }
    @Published private(set) var economyLedger: SleepClaimLedger
    @Published private(set) var economyStatus = "尚未生成本地睡眠凭证。"

#if VALIDATION_APP
    private var desktopWakeTask: Task<Void, Never>?
    private var desktopTestTask: Task<Void, Never>?
#endif
    private let health = HealthKitService()
    private let economyAccountPseudonym: String
    let verificationLog = VerificationLogStore()

    init() {
        let defaults = UserDefaults.standard
        let savedPseudonym = defaults.string(forKey: "sleep-economy-account-pseudonym")
        economyAccountPseudonym = savedPseudonym ?? UUID().uuidString
        defaults.set(economyAccountPseudonym, forKey: "sleep-economy-account-pseudonym")
        economyLedger = Self.loadEconomyLedger()
        if let data = UserDefaults.standard.data(forKey: "sleep-policy"), let saved = try? JSONDecoder().decode(SleepPolicy.self, from: data) {
            policy = saved
        } else {
            policy = SleepPolicy()
        }
        estimatedSleepLatencyMinutes = defaults.object(forKey: "estimated-sleep-latency") == nil
            ? 15
            : defaults.integer(forKey: "estimated-sleep-latency")
        estimatedCycleMinutes = defaults.object(forKey: "estimated-cycle-minutes") == nil
            ? 90
            : defaults.integer(forKey: "estimated-cycle-minutes")
        saveDiagnosticState()
    }

    func requestHealthAccess() {
#if VALIDATION_APP
        status = "macOS 验证版不读取 HealthKit；请使用模拟数据验证操作流程。"
#else
        Task {
            do {
                try await health.requestAuthorization()
                status = "已完成 HealthKit 授权流程；读取权限是否授予仍只能通过查询结果判断。"
                await enableObservation()
            }
            catch { status = error.localizedDescription }
        }
#endif
    }

    func loadHealthSamples() {
#if VALIDATION_APP
        status = "HealthKit 与 RingConn 数据读取仅在 iPhone 真机验证。"
#else
        Task {
            do { samples = try await health.fetchSleepSamples(); status = samples.isEmpty ? "没有可读的睡眠样本（可能无数据或未授予读取权限）。" : "已读取 \(samples.count) 个睡眠样本。" }
            catch { status = error.localizedDescription }
        }
#endif
    }

    func loadHealthMetrics() {
#if VALIDATION_APP
        status = "心率等 HealthKit 数据仅在 iPhone 真机验证。"
#else
        Task {
            do {
                metricSnapshots = try await health.fetchMetricSnapshots()
                status = "已读取最近 24 小时的心率等指标；请比较 RingConn 数量和最新时间。"
            } catch { status = error.localizedDescription }
        }
#endif
    }

    func startBackgroundObservation() {
#if VALIDATION_APP
        status = "macOS 验证版已就绪；HealthKit 后台观察仅在 iPhone 真机验证。"
#else
        Task { await enableObservation() }
#endif
    }

    func setMinimumSleep(hours: Int) { policy.minimumSleep = TimeInterval(hours * 3600); savePolicy() }
    func setMinimumDeepREM(minutes: Int) { policy.minimumDeepREM = TimeInterval(minutes * 60); savePolicy() }
    func setEstimatedSleepLatency(minutes: Int) {
        estimatedSleepLatencyMinutes = minutes
        UserDefaults.standard.set(minutes, forKey: "estimated-sleep-latency")
    }
    func setEstimatedCycle(minutes: Int) {
        estimatedCycleMinutes = minutes
        UserDefaults.standard.set(minutes, forKey: "estimated-cycle-minutes")
    }
    func setLatestStage(_ stage: SleepStage, allowed: Bool) {
        if allowed { policy.allowedLatestStages.insert(stage) } else { policy.allowedLatestStages.remove(stage) }
        savePolicy()
    }

    var wakeStart: Date {
        get { date(hour: policy.wakeWindow.startHour, minute: policy.wakeWindow.startMinute) }
        set { policy.wakeWindow = WakeWindow(startHour: Calendar.current.component(.hour, from: newValue), startMinute: Calendar.current.component(.minute, from: newValue), endHour: policy.wakeWindow.endHour, endMinute: policy.wakeWindow.endMinute); savePolicy() }
    }

    var wakeEnd: Date {
        get { date(hour: policy.wakeWindow.endHour, minute: policy.wakeWindow.endMinute) }
        set { policy.wakeWindow = WakeWindow(startHour: policy.wakeWindow.startHour, startMinute: policy.wakeWindow.startMinute, endHour: Calendar.current.component(.hour, from: newValue), endMinute: Calendar.current.component(.minute, from: newValue)); savePolicy() }
    }

    func useMockData() {
        useMockScenario(.wakeReady)
    }

    func useMockScenario(_ scenario: MockScenario) {
        selectedMockScenario = scenario
        let end = Date.now
        let input = mockInput(for: scenario, end: end)
        samples = input.samples
        policy.wakeWindow = input.wakeWindow
        savePolicy()
        status = "已载入模拟场景：\(scenario.title)。模拟数据不构成 RingConn 或后台能力证据。"
    }

    func runScenarioSelfCheck() {
        let now = Date.now
        scenarioCheckResults = MockScenario.allCases.map { scenario in
            let input = mockInput(for: scenario, end: now)
            var testPolicy = SleepPolicy()
            testPolicy.wakeWindow = input.wakeWindow
            let result = SleepEvaluator.evaluate(samples: input.samples, policy: testPolicy, now: now)
            return ScenarioCheckResult(scenario: scenario, actualReason: result.reason)
        }
        let passed = scenarioCheckResults.filter(\.passed).count
        status = passed == scenarioCheckResults.count
            ? "一键自检通过：5/5 个判定场景符合预期。"
            : "一键自检未通过：\(passed)/\(scenarioCheckResults.count) 个场景符合预期。"
    }

    func scheduleFallbackNotification() {
        Task {
            var target = Calendar.current.date(bySettingHour: policy.wakeWindow.endHour, minute: policy.wakeWindow.endMinute, second: 0, of: .now)!
            if target < .now { target = Calendar.current.date(byAdding: .day, value: 1, to: target)! }
            do {
                let channel = try await NotificationService.scheduleWakeup(
                    at: target,
                    title: "最晚起床时间",
                    message: "已到达你设置的最晚起床时间。"
                )
                status = "已通过\(channel.rawValue)安排最晚起床：\(target.formatted(date: .abbreviated, time: .shortened))。"
            } catch {
#if VALIDATION_APP
                scheduleDesktopWakeFallback(at: target, name: "最晚起床")
#else
                status = error.localizedDescription
#endif
            }
        }
    }

    func schedulePredictedWakeAlarm() {
        let target = predictedWakeDate
        Task {
            do {
                let channel = try await NotificationService.scheduleWakeup(
                    at: target,
                    title: "周期边界唤醒",
                    message: "已到达预计睡眠周期边界附近，准备起床。"
                )
                status = "已通过\(channel.rawValue)安排周期边界唤醒：\(target.formatted(date: .abbreviated, time: .shortened))。"
            } catch {
#if VALIDATION_APP
                scheduleDesktopWakeFallback(at: target, name: "周期边界唤醒")
#else
                status = error.localizedDescription
#endif
            }
        }
    }

    var predictedWakeDate: Date {
        WakePlanner.predictedWake(
            bedtime: .now,
            wakeWindow: policy.wakeWindow,
            sleepLatencyMinutes: estimatedSleepLatencyMinutes,
            cycleMinutes: estimatedCycleMinutes
        )
    }

    func scheduleFiveSecondTest() {
        Task {
            do {
                guard try await NotificationService.requestAuthorization() else {
#if VALIDATION_APP
                    scheduleDesktopTestFallback()
#else
                    notificationStatus = "未获得通知授权"
                    status = "未获得通知授权。"
#endif
                    return
                }
                try await NotificationService.scheduleTest()
                notificationStatus = "已排程，等待 5 秒"
                status = "已安排 5 秒后的通知测试。"
                try? await Task.sleep(nanoseconds: 7_000_000_000)
                notificationStatus = await NotificationService.testWasDelivered()
                    ? "系统已投递测试通知"
                    : "已排程；请确认是否看到通知"
                saveDiagnosticState()
            } catch {
#if VALIDATION_APP
                scheduleDesktopTestFallback()
#else
                status = error.localizedDescription
#endif
            }
        }
    }

#if VALIDATION_APP
    private func scheduleDesktopWakeFallback(at target: Date, name: String) {
        desktopWakeTask?.cancel()
        desktopWakeTask = desktopReminderTask(at: target, name: name)
        notificationStatus = "已改用电脑版应用内提醒"
        status = "系统通知不可用；已安排\(name)：\(target.formatted(date: .abbreviated, time: .shortened))。请保持电脑版 App 运行。"
    }

    private func scheduleDesktopTestFallback() {
        desktopTestTask?.cancel()
        desktopTestTask = desktopReminderTask(at: .now.addingTimeInterval(5), name: "5 秒测试")
        notificationStatus = "等待 5 秒应用内提醒"
        status = "系统通知不可用；已改用 5 秒应用内声音测试。"
    }

    private func desktopReminderTask(at target: Date, name: String) -> Task<Void, Never> {
        let delay = max(0, target.timeIntervalSinceNow)
        return Task { [weak self] in
            do {
                try await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000))
            } catch {
                return
            }
            guard !Task.isCancelled else { return }
            NSSound.beep()
            self?.notificationStatus = "\(name)应用内提醒已触发"
            self?.status = "\(name)电脑版应用内提醒已触发；这不等同于 iPhone AlarmKit。"
        }
    }
#endif

    func recordVerificationSnapshot(sleepStillOngoing: Bool, note: String) {
        verificationLog.append(samples: samples, trigger: "manual", sleepStillOngoing: sleepStillOngoing, note: note)
        status = "已保存 Phase 0 快照。"
    }

    var evaluation: SleepEvaluation { SleepEvaluator.evaluate(samples: samplesForEvaluation, policy: policy) }
    var evaluationSource: String { samples.contains(where: { $0.source.localizedCaseInsensitiveContains("ringconn") }) ? "判定仅使用 RingConn 来源样本" : "判定使用当前可读样本" }
    var economyAssessment: SleepEconomyAssessment { SleepEconomyEngine.assess(samples: samplesForEvaluation) }

    func createLocalSleepClaim() {
        do {
            let receipt = try SleepClaimBuilder.makeReceipt(
                samples: samplesForEvaluation,
                accountPseudonym: economyAccountPseudonym
            )
            var updated = economyLedger
            try updated.append(receipt)
            economyLedger = updated
            saveEconomyLedger()
            economyStatus = "已生成生理夜 \(receipt.nightKey) 的本地凭证；未上传、未结算。"
        } catch {
            economyStatus = error.localizedDescription
        }
    }

    private func date(hour: Int, minute: Int) -> Date {
        Calendar.current.date(bySettingHour: hour, minute: minute, second: 0, of: .now)!
    }

    private var samplesForEvaluation: [SleepSample] {
        let ringConn = samples.filter { $0.source.localizedCaseInsensitiveContains("ringconn") }
        return ringConn.isEmpty ? samples : ringConn
    }

    private func enableObservation() async {
        do {
            try await health.startObserving { [weak self] in
                guard let self else { return }
                do {
                    let latest = try await self.health.fetchSleepSamples()
                    await MainActor.run {
                        self.samples = latest
                        self.verificationLog.append(samples: latest, trigger: "healthkit-observer", sleepStillOngoing: nil)
                        self.status = "收到 HealthKit 更新并完成重新读取。"
                    }
                } catch {
                    await MainActor.run { self.status = "HealthKit observer 读取失败：\(error.localizedDescription)" }
                }
            }
            try await health.startMetricObserving { [weak self] in
                guard let self else { return }
                do {
                    let latest = try await self.health.fetchMetricSnapshots()
                    await MainActor.run {
                        self.metricSnapshots = latest
                        self.metricObserverCallbackCount += 1
                        self.latestMetricObserverAt = .now
                        self.status = "收到心率等 HealthKit 更新并完成重新读取。"
                    }
                } catch {
                    await MainActor.run { self.status = "HealthKit 指标 observer 读取失败：\(error.localizedDescription)" }
                }
            }
            status = "已注册 HealthKit observer；后台到达时机仍需真机验证。"
        } catch { status = "无法启用 HealthKit observer：\(error.localizedDescription)" }
    }

    private func savePolicy() {
        if let data = try? JSONEncoder().encode(policy) { UserDefaults.standard.set(data, forKey: "sleep-policy") }
    }

    private static var economyLedgerURL: URL? {
        FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first?
            .appendingPathComponent("sleep-economy-ledger.json")
    }

    private static func loadEconomyLedger() -> SleepClaimLedger {
        guard let url = economyLedgerURL,
              let data = try? Data(contentsOf: url),
              let ledger = try? JSONDecoder().decode(SleepClaimLedger.self, from: data) else {
            return SleepClaimLedger()
        }
        return ledger
    }

    private func saveEconomyLedger() {
        guard let url = Self.economyLedgerURL,
              let data = try? JSONEncoder().encode(economyLedger) else { return }
        try? data.write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    }

    private func saveDiagnosticState() {
        let state = AppDiagnosticState(
            updatedAt: .now,
            status: status,
            notificationStatus: notificationStatus,
            sampleCount: samples.count,
            ringConnSampleCount: samples.filter { $0.source.localizedCaseInsensitiveContains("ringconn") }.count,
            metricObserverCallbackCount: metricObserverCallbackCount,
            latestMetricObserverAt: latestMetricObserverAt,
            metrics: metricSnapshots.map {
                MetricDiagnostic(
                    identifier: $0.identifier,
                    sampleCount: $0.sampleCount,
                    ringConnSampleCount: $0.ringConnSampleCount,
                    latestDate: $0.latestDate,
                    latestSourceIsRingConn: $0.latestSource?.localizedCaseInsensitiveContains("ringconn") ?? false
                )
            }
        )
        guard let data = try? JSONEncoder().encode(state),
              let directory = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first else { return }
        try? data.write(to: directory.appendingPathComponent("diagnostic-state.json"), options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    }

    private func mockSample(end: Date, startHoursAgo: Double, endHoursAgo: Double, stage: SleepStage) -> SleepSample {
        SleepSample(
            start: end.addingTimeInterval(-startHoursAgo * 3600),
            end: end.addingTimeInterval(-endHoursAgo * 3600),
            stage: stage,
            source: "模拟数据"
        )
    }

    private func mockInput(for scenario: MockScenario, end: Date) -> (samples: [SleepSample], wakeWindow: WakeWindow) {
        let ready = [
            mockSample(end: end, startHoursAgo: 7, endHoursAgo: 5, stage: .core),
            mockSample(end: end, startHoursAgo: 5, endHoursAgo: 4, stage: .deep),
            mockSample(end: end, startHoursAgo: 4, endHoursAgo: 2, stage: .core),
            mockSample(end: end, startHoursAgo: 2, endHoursAgo: 0, stage: .rem)
        ]
        let scenarioSamples: [SleepSample]
        switch scenario {
        case .wakeReady, .outsideWindow:
            scenarioSamples = ready
        case .tooShort:
            scenarioSamples = [
                mockSample(end: end, startHoursAgo: 4, endHoursAgo: 2, stage: .core),
                mockSample(end: end, startHoursAgo: 2, endHoursAgo: 1, stage: .deep),
                mockSample(end: end, startHoursAgo: 1, endHoursAgo: 0, stage: .rem)
            ]
        case .insufficientDeepREM:
            scenarioSamples = [
                mockSample(end: end, startHoursAgo: 6.5, endHoursAgo: 3.5, stage: .core),
                mockSample(end: end, startHoursAgo: 3.5, endHoursAgo: 0.5, stage: .core),
                mockSample(end: end, startHoursAgo: 0.5, endHoursAgo: 0, stage: .rem)
            ]
        case .latestAwake:
            scenarioSamples = ready + [mockSample(end: end, startHoursAgo: 5.0 / 60, endHoursAgo: 0, stage: .awake)]
        }
        let startOffset = scenario == .outsideWindow ? 60 : -5
        let endOffset = scenario == .outsideWindow ? 90 : 25
        let start = Calendar.current.date(byAdding: .minute, value: startOffset, to: end)!
        let finish = Calendar.current.date(byAdding: .minute, value: endOffset, to: end)!
        return (
            scenarioSamples,
            WakeWindow(
                startHour: Calendar.current.component(.hour, from: start),
                startMinute: Calendar.current.component(.minute, from: start),
                endHour: Calendar.current.component(.hour, from: finish),
                endMinute: Calendar.current.component(.minute, from: finish)
            )
        )
    }
}

private struct AppDiagnosticState: Codable {
    let updatedAt: Date
    let status: String
    let notificationStatus: String
    let sampleCount: Int
    let ringConnSampleCount: Int
    let metricObserverCallbackCount: Int
    let latestMetricObserverAt: Date?
    let metrics: [MetricDiagnostic]
}

private struct MetricDiagnostic: Codable {
    let identifier: String
    let sampleCount: Int
    let ringConnSampleCount: Int
    let latestDate: Date?
    let latestSourceIsRingConn: Bool
}
