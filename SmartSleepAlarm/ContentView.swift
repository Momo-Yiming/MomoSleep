import SwiftUI

struct ContentView: View {
    @EnvironmentObject private var model: SleepViewModel

    var body: some View {
        NavigationStack {
            List {
                Section("核心功能：周期边界唤醒") {
                    Label("已实现：预计周期边界唤醒", systemImage: "checkmark.seal.fill")
                        .font(.headline)
                        .foregroundStyle(.indigo)

                    Text("当你不能睡到自然醒、又必须在规定时间起床时，App 会从“现在上床”开始，加上预计入睡耗时，再按设定的睡眠周期向后推算；它会选择唤醒窗口内最晚的完整周期边界，让你在不超过最晚起床时间的前提下尽量多睡。")

                    Text("目标是尽量减少在估算周期中段被突然叫醒的概率，从而降低醒后的睡眠惯性，让睡眠不足时的起床相对容易一些。它不能替代充足睡眠，也不能保证醒来后一定清醒。")
                        .foregroundStyle(.secondary)

                    Text("计算路径：现在上床 → 预计入睡 → 完整周期 × N → 窗口内最晚边界")
                        .font(.footnote.weight(.semibold))

                    Stepper(
                        "预计入睡耗时：\(model.estimatedSleepLatencyMinutes) 分钟",
                        value: Binding(get: { model.estimatedSleepLatencyMinutes }, set: model.setEstimatedSleepLatency),
                        in: 0...60,
                        step: 5
                    )
                    Stepper(
                        "预计睡眠周期：\(model.estimatedCycleMinutes) 分钟",
                        value: Binding(get: { model.estimatedCycleMinutes }, set: model.setEstimatedCycle),
                        in: 70...120,
                        step: 5
                    )
                    DatePicker(
                        "最早可叫醒",
                        selection: Binding(get: { model.wakeStart }, set: { model.wakeStart = $0 }),
                        displayedComponents: .hourAndMinute
                    )
                    DatePicker(
                        "最晚必须起床",
                        selection: Binding(get: { model.wakeEnd }, set: { model.wakeEnd = $0 }),
                        displayedComponents: .hourAndMinute
                    )
                    LabeledContent(
                        "预计周期边界",
                        value: model.predictedWakeDate.formatted(date: .abbreviated, time: .shortened)
                    )
                    Button("按现在上床，安排周期边界闹钟", action: model.schedulePredictedWakeAlarm)
                        .buttonStyle(.borderedProminent)
                        .keyboardShortcut("a", modifiers: [.command, .shift])
                    Button("改为最晚起床时间", action: model.scheduleFallbackNotification)
                        .keyboardShortcut("f", modifiers: [.command, .shift])

                    Group {
#if VALIDATION_APP
                        Text("当前使用的是时间预测，不是 RingConn 实时睡眠分期。电脑版先尝试普通本地通知；若系统拒绝，则改用需保持 App 运行的应用内声音。iPhone 的 iOS 26 版本才会优先使用 AlarmKit。")
#else
                        Text("当前使用的是时间预测，不是 RingConn 实时睡眠分期。人的周期长度每晚会变化，90 分钟只是可调整的默认估计。iOS 26 优先使用 AlarmKit；否则降级为普通通知。")
#endif
                    }
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
                Section("睡眠经济（新功能）") {
                    NavigationLink {
                        EconomyDemoView()
                    } label: {
                        VStack(alignment: .leading, spacing: 6) {
                            Label("打开云端经济沙盒", systemImage: "server.rack")
                                .font(.headline)
                                .foregroundStyle(.indigo)
                            Text("模拟睡眠赚积分、兑换虚拟商品，并查看 Monad 测试网上链记录。")
                                .font(.footnote)
                                .foregroundStyle(.secondary)
                        }
                        .padding(.vertical, 6)
                    }
                    .listRowBackground(Color.indigo.opacity(0.12))

                    NavigationLink("本地睡眠积分试算") {
                        SleepEconomyView()
                    }
                }
                Section("快速验证（按 1 → 3）") {
#if VALIDATION_APP
                    LabeledContent("1. 授权读取睡眠数据", value: "仅 iPhone 真机")
                    LabeledContent("2. 读取 HealthKit 睡眠", value: "仅 iPhone 真机")
                    Button {
                        model.scheduleFiveSecondTest()
                    } label: {
                        Label("3. 运行 5 秒通知测试", systemImage: "bell.badge")
                    }
                    .keyboardShortcut("t", modifiers: [.command, .shift])
#else
                    Button {
                        model.requestHealthAccess()
                    } label: {
                        Label("1. 授权读取睡眠数据", systemImage: "heart.text.square")
                    }
                    Button {
                        model.loadHealthSamples()
                    } label: {
                        Label("2. 读取 HealthKit 睡眠", systemImage: "waveform.path.ecg")
                    }
                    Button {
                        model.loadHealthMetrics()
                    } label: {
                        Label("读取心率等即时数据", systemImage: "heart.fill")
                    }
                    Button {
                        model.scheduleFiveSecondTest()
                    } label: {
                        Label("3. 运行 5 秒通知测试", systemImage: "bell.badge")
                    }
                    .keyboardShortcut("t", modifiers: [.command, .shift])
#endif
                    Group {
#if VALIDATION_APP
                        Text("电脑版会先验证普通本地通知，权限不可用时自动改用应用内声音；HealthKit 数据授权和读取仍只能在 iPhone 真机完成。")
#else
                        Text("健康数据与通知权限需要你在系统弹窗中亲自确认。")
#endif
                    }
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                    LabeledContent("通知状态", value: model.notificationStatus)
                }
                Section("状态") {
                    Text(model.status)
                    Text(model.evaluation.reason).fontWeight(.semibold)
                    Text(model.evaluationSource).font(.caption).foregroundStyle(.secondary)
                    LabeledContent("总睡眠", value: model.evaluation.totalSleep.formattedDuration)
                    LabeledContent("Deep + REM", value: model.evaluation.deepREM.formattedDuration)
                    LabeledContent("最近阶段", value: model.evaluation.latestStage?.rawValue ?? "无")
                }
                Section("即时数据探针（最近 24 小时）") {
#if VALIDATION_APP
                    LabeledContent("心率等 HealthKit 指标", value: "仅 iPhone 真机")
                    Text("macOS 当前不提供本项目所需的 HealthKit 数据源；电脑版保留同一页面结构，但不会伪造 RingConn 指标。")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
#else
                    Button("立即刷新心率等数据", action: model.loadHealthMetrics)
                    LabeledContent("指标 observer 回调", value: "\(model.metricObserverCallbackCount) 次")
                    if let latestMetricObserverAt = model.latestMetricObserverAt {
                        LabeledContent("最近回调", value: latestMetricObserverAt.formatted(date: .omitted, time: .standard))
                    }
                    ForEach(model.metricSnapshots) { metric in
                        VStack(alignment: .leading, spacing: 4) {
                            HStack {
                                Text(metric.name).fontWeight(.semibold)
                                Spacer()
                                Text(metric.formattedValue)
                            }
                            Text("24 小时样本 \(metric.sampleCount) · RingConn \(metric.ringConnSampleCount)")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                            if let date = metric.latestDate, let source = metric.latestSource {
                                Text("最新：\(date.formatted(date: .abbreviated, time: .standard)) · \(source)")
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                        }
                    }
                    Text("判断是否即时回传，应比较同步前后的 RingConn 样本数和最新时间；observer 的首次注册回调不等于新增数据。")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
#endif
                }
                Section("更多操作") {
#if !VALIDATION_APP
                    Button("开始后台观察（仅真机验证）", action: model.startBackgroundObservation)
#endif
                    Button("载入可唤醒模拟数据", action: model.useMockData)
                        .keyboardShortcut("m", modifiers: [.command])
                    Picker("模拟场景", selection: Binding(
                        get: { model.selectedMockScenario },
                        set: model.useMockScenario
                    )) {
                        ForEach(MockScenario.allCases) { scenario in
                            Text(scenario.title).tag(scenario)
                        }
                    }
                    .pickerStyle(.menu)
                    NavigationLink("Phase 0 真机记录") {
                        VerificationLogView(store: model.verificationLog)
                    }
                    .keyboardShortcut("l", modifiers: [.command])
                }
                Section("一键判定自检") {
                    Button(action: model.runScenarioSelfCheck) {
                        Label("运行五场景自检", systemImage: "checkmark.seal")
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.borderedProminent)
                    .controlSize(.large)
                    .keyboardShortcut("r", modifiers: [.command, .shift])
                    if model.scenarioCheckResults.isEmpty {
                        Text("使用默认 MVP 策略自动验证五个关键分支，不会修改当前配置。")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    } else {
                        ForEach(model.scenarioCheckResults) { result in
                            HStack {
                                Image(systemName: result.passed ? "checkmark.circle.fill" : "xmark.circle.fill")
                                    .foregroundStyle(result.passed ? .green : .red)
                                VStack(alignment: .leading) {
                                    Text(result.scenario.title)
                                    Text(result.actualReason)
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                }
                                Spacer()
                                Text(result.passed ? "通过" : "失败")
                                    .fontWeight(.semibold)
                            }
                        }
                    }
                }
                Section("MVP 判定配置") {
                    Stepper("最短睡眠：\(Int(model.policy.minimumSleep / 3600)) 小时", value: Binding(get: { Int(model.policy.minimumSleep / 3600) }, set: model.setMinimumSleep), in: 4...12)
                    Stepper("Deep + REM：\(Int(model.policy.minimumDeepREM / 60)) 分钟", value: Binding(get: { Int(model.policy.minimumDeepREM / 60) }, set: model.setMinimumDeepREM), in: 30...240, step: 15)
                    ForEach([SleepStage.asleep, .core, .rem, .deep]) { stage in
                        Toggle("最近为 \(stage.rawValue) 时允许", isOn: Binding(
                            get: { model.policy.allowedLatestStages.contains(stage) },
                            set: { model.setLatestStage(stage, allowed: $0) }
                        ))
                    }
                }
                Section("睡眠样本与来源") {
                    ForEach(model.samples) { sample in
                        VStack(alignment: .leading) {
                            Text("\(sample.stage.rawValue) · \(sample.duration.formattedDuration)")
                            Text(sample.source).font(.caption).foregroundStyle(.secondary)
                            Text("\(sample.start.formatted(date: .omitted, time: .shortened)) – \(sample.end.formatted(date: .omitted, time: .shortened))").font(.caption).foregroundStyle(.secondary)
                        }
                    }
                }
                Section("验证边界") {
                    Text("第一晚数据更像睡眠结束后批量上传，因此今晚闹钟不依赖 RingConn 实时阶段。预测周期只是近似值；AlarmKit 提升响铃可靠性，但不能把预测变成实时睡眠分期。")
                        .font(.footnote)
                }
            }
            .navigationTitle("智能睡眠闹钟")
        }
#if os(macOS)
        .frame(minWidth: 720, minHeight: 720)
#endif
    }
}

private extension TimeInterval {
    var formattedDuration: String {
        let minutes = Int(self / 60)
        return "\(minutes / 60)小时\(minutes % 60)分"
    }
}
