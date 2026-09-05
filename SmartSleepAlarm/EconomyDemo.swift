import Foundation
import SwiftUI

enum EconomyServerConfig {
    static let webpageURL = URL(string: "https://smart-sleep-economy-demo.pages.dev")!
    static let apiBaseURLs = [
        webpageURL,
        URL(string: "https://smart-sleep-economy-demo.smart-sleep-economy-server.workers.dev")!,
    ]
}

struct EconomyDemoState: Codable {
    struct ChainReceipt: Codable {
        let kind: String
        let status: String
        let claimHash: String
        let transactionHash: String
        let blockNumber: Int
        let confirmations: Int
        let recordedAt: String
    }

    struct Account: Codable {
        let id: String
        let displayName: String
        let points: Int
    }

    struct ScoreBreakdown: Codable, Equatable {
        struct StageMinutes: Codable, Equatable {
            let asleep: Int
            let core: Int
            let rem: Int
            let deep: Int
            let awake: Int
            let conflicting: Int
        }

        let scoringVersion: Int
        let sourceMinutes: Int
        let countedMinutes: Int
        let sourceStageMinutes: StageMinutes?
        let stageMinutes: StageMinutes
        let awakeMinutes: Int
        let interruptionCount: Int
        let deepRatioPercent: Double
        let targetDeepPercent: Double
        let effectiveDeepWeight: Double
        let stagePoints: Int
        let continuityFactor: Double
        let scheduleDeviationMinutes: Int?
        let regularityFactor: Double
        let rawPoints: Int
        let awardedPoints: Int
        let sourceLabel: String
        let windowLabel: String?
        let regularityBasis: String
        let vendorReportedDeepPercent: Double?
        let visibleStageMinutes: Int?
        let unclassifiedWindowMinutes: Int?
        let inputNotes: [String]

        static var september4Example: Self {
            let source = SleepStageMinutes(core: 250, rem: 50, deep: 105, awake: 31)
            let assessment = SleepEconomyEngine.score(
                stageMinutes: source,
                trustGrade: .unverified,
                qualityContext: .september4Example
            )
            return Self(
                scoringVersion: 2,
                sourceMinutes: 405,
                countedMinutes: 405,
                sourceStageMinutes: StageMinutes(asleep: 0, core: 250, rem: 50, deep: 105, awake: 31, conflicting: 0),
                stageMinutes: StageMinutes(asleep: 0, core: 250, rem: 50, deep: 105, awake: 31, conflicting: 0),
                awakeMinutes: 31,
                interruptionCount: 6,
                deepRatioPercent: 25.9,
                targetDeepPercent: 25,
                effectiveDeepWeight: Double(assessment.quality.effectiveDeepWeightBasisPoints) / 10_000,
                stagePoints: assessment.quality.stagePoints,
                continuityFactor: Double(assessment.quality.continuityFactorBasisPoints) / 10_000,
                scheduleDeviationMinutes: 565,
                regularityFactor: Double(assessment.quality.regularityFactorBasisPoints) / 10_000,
                rawPoints: assessment.rawPoints,
                awardedPoints: assessment.awardedPoints,
                sourceLabel: "用户授权公开的去标识化样例 A",
                windowLabel: "07:36–15:13",
                regularityBasis: SleepQualityContext.september4Example.regularityBasis,
                vendorReportedDeepPercent: 24.1,
                visibleStageMinutes: 436,
                unclassifiedWindowMinutes: 21,
                inputNotes: [
                    "清醒、REM、浅睡和深睡分钟来自截图汇总",
                    "6 次中断为图中可见片段估计，待原始逐分钟导出校准",
                    "25% 是可版本化激励参数，不是医学诊断阈值",
                ]
            )
        }
    }

    struct Claim: Codable, Identifiable {
        let id: String
        let nightKey: String
        let rawPoints: Int
        let awardedPoints: Int
        let scoringVersion: Int?
        let scoreBreakdown: ScoreBreakdown?
        let trustGrade: String
        let status: String
        let batchId: String?
        let chainReceipt: ChainReceipt?
    }

    struct Product: Codable, Identifiable {
        let id: String
        let title: String
        let pricePoints: Int
        let stock: Int
    }

    struct Order: Codable, Identifiable {
        let id: String
        let title: String
        let pricePoints: Int
        let status: String
        let chainReceipt: ChainReceipt?
    }

    struct CashPolicy: Codable {
        let mode: String
        let sponsorProgram: String
        let sponsorBudgetStatus: String
        let rateFenPer100Points: Int
        let rateFloorFenPer100Points: Int
        let rateCeilingFenPer100Points: Int
        let minimumPoints: Int
        let maximumPoints: Int
        let quoteVersion: String
        let quoteUpdatedAt: String
        let payoutChannel: String
        let payoutEnabled: Bool
        let requirements: [String]
    }

    struct CashRedemption: Codable, Identifiable {
        let id: String
        let points: Int
        let rateFenPer100Points: Int
        let amountFen: Int
        let quoteVersion: String
        let payoutChannel: String
        let status: String
        let createdAt: String
    }

    struct Batch: Codable, Identifiable {
        let id: String
        let merkleRoot: String
        let claimCount: Int
        let scoringVersion: Int
        let chainStatus: String
        let transactionHash: String?
        let blockNumber: Int?
    }

    struct Network: Codable {
        let name: String
        let chainId: Int
        let explorerURL: String
        let contractAddress: String?
    }

    let mode: String
    let account: Account
    let claims: [Claim]
    let products: [Product]
    let orders: [Order]
    let cashPolicy: CashPolicy
    let cashRedemptions: [CashRedemption]
    let batches: [Batch]
    let network: Network
}

extension EconomyDemoState {
    static func offline(accountId: String) -> Self {
        Self(
            mode: "offline",
            account: Account(id: accountId, displayName: "本地演示用户", points: 0),
            claims: [],
            products: [
                Product(id: "eye-mask", title: "遮光睡眠眼罩", pricePoints: 180, stock: 99),
                Product(id: "white-noise", title: "白噪音七天权益", pricePoints: 260, stock: 99),
                Product(id: "pillow-coupon", title: "睡眠枕商城优惠券", pricePoints: 420, stock: 99),
            ],
            orders: [],
            cashPolicy: CashPolicy(
                mode: "integration_pending",
                sponsorProgram: "品牌预付预算试点（待签约）",
                sponsorBudgetStatus: "尚未接收真实品牌资金",
                rateFenPer100Points: 100,
                rateFloorFenPer100Points: 80,
                rateCeilingFenPer100Points: 120,
                minimumPoints: 100,
                maximumPoints: 10_000,
                quoteVersion: "pilot-2026-09-05-a",
                quoteUpdatedAt: "2026-09-05T07:00:00Z",
                payoutChannel: "微信商家转账到零钱（待商户开通）",
                payoutEnabled: false,
                requirements: ["品牌预付预算", "企业支付商户", "用户实名与单独同意", "财税和反作弊审核"]
            ),
            cashRedemptions: [],
            batches: [
                Batch(
                    id: "batch-1788524456585-9c40aee5",
                    merkleRoot: "81ea69a6d836ee1a9d4c0a75df4ace96e45b4e1f9091e44eee006ac4ba78b4d8",
                    claimCount: 1,
                    scoringVersion: 1,
                    chainStatus: "anchored",
                    transactionHash: "0xa7fcc597b6265585f38846a47b2d88dd17a2cbbc24d597085cd51c501999c695",
                    blockNumber: 59_626_845
                ),
            ],
            network: Network(
                name: "Monad Testnet",
                chainId: 10143,
                explorerURL: "https://testnet.monadscan.com",
                contractAddress: "0x5dea033080d3f3420a3ee68b2e355a79135cbd84"
            )
        )
    }

    func addingOfflineNight(profile: String) throws -> Self {
        let breakdown = ScoreBreakdown.september4Example
        let nightKey = "local-disclosed-example-a"
        guard !claims.contains(where: { $0.nightKey == nightKey }) else {
            throw NSError(domain: "SleepEconomyOffline", code: 3, userInfo: [NSLocalizedDescriptionKey: "样例 A 已经领取过积分；重置后可以重新演示"])
        }
        let claim = Claim(
            id: UUID().uuidString,
            nightKey: nightKey,
            rawPoints: breakdown.rawPoints,
            awardedPoints: breakdown.awardedPoints,
            scoringVersion: breakdown.scoringVersion,
            scoreBreakdown: breakdown,
            trustGrade: "OFFLINE",
            status: "local_demo",
            batchId: nil,
            chainReceipt: nil
        )
        return replacing(
            account: Account(id: account.id, displayName: account.displayName, points: account.points + breakdown.awardedPoints),
            claims: [claim] + claims,
            orders: orders
        )
    }

    func purchasingOfflineProduct(id: String) throws -> Self {
        guard let product = products.first(where: { $0.id == id }) else {
            throw NSError(domain: "SleepEconomyOffline", code: 1, userInfo: [NSLocalizedDescriptionKey: "找不到这个演示商品"])
        }
        guard account.points >= product.pricePoints else {
            throw NSError(domain: "SleepEconomyOffline", code: 2, userInfo: [NSLocalizedDescriptionKey: "本地演示积分不足"])
        }
        let order = Order(id: UUID().uuidString, title: product.title, pricePoints: product.pricePoints, status: "local_demo", chainReceipt: nil)
        return replacing(
            account: Account(id: account.id, displayName: account.displayName, points: account.points - product.pricePoints),
            claims: claims,
            orders: [order] + orders
        )
    }

    func resettingOffline() -> Self {
        Self.offline(accountId: account.id)
    }

    private func replacing(account: Account, claims: [Claim], orders: [Order]) -> Self {
        Self(
            mode: mode,
            account: account,
            claims: claims,
            products: products,
            orders: orders,
            cashPolicy: cashPolicy,
            cashRedemptions: cashRedemptions,
            batches: batches,
            network: network
        )
    }
}

@MainActor
final class EconomyDemoViewModel: ObservableObject {
    @Published private(set) var state: EconomyDemoState?
    @Published private(set) var status = "正在连接沙盒服务器……"
    @Published private(set) var isWorking = false

    private let accountId: String
    private let defaults: UserDefaults
    private let offlineStateKey = "sleep-economy-offline-state"
    private var connectedServerURL: URL?

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        let key = "sleep-economy-demo-account"
        if let saved = defaults.string(forKey: key) {
            accountId = saved
        } else {
            accountId = UUID().uuidString
            defaults.set(accountId, forKey: key)
        }
    }

    func load() async {
        guard !isWorking else { return }
        isWorking = true
        defer { isWorking = false }
        do {
            state = try await request(path: "/api/demo/state", query: ["accountId": accountId])
            status = connectedServerURL == EconomyServerConfig.webpageURL
                ? "已连接在线服务器（Pages 线路）。"
                : "已连接在线服务器（备用线路）。"
        } catch {
            handle(error: error)
        }
    }

    func simulateNight(profile: String) {
        if let offline = offlineState {
            do {
                let updated = try offline.addingOfflineNight(profile: profile)
                saveOffline(updated)
                let points = updated.claims.first?.awardedPoints ?? 0
                status = "四维 V2 已复算并发放 \(points) 本地演示积分；不会上传服务器。"
            } catch {
                status = error.localizedDescription
            }
            return
        }
        Task {
            await perform(success: { value in
                let claim = value.claims.first(where: { $0.nightKey == "disclosed-example-a" })
                return "服务器已按四维 V\(claim?.scoringVersion ?? 2) 复算并发放 \(claim?.awardedPoints ?? 0) 沙盒积分。"
            }) {
                try await request(path: "/api/demo/claims", method: "POST", body: ["accountId": accountId, "profile": profile])
            }
        }
    }

    func buy(productId: String) {
        if let offline = offlineState {
            do {
                saveOffline(try offline.purchasingOfflineProduct(id: productId))
                status = "本地模拟兑换成功；没有产生真实订单。"
            } catch {
                status = error.localizedDescription
            }
            return
        }
        Task {
            await perform(success: { _ in "沙盒商品兑换成功，已生成唯一模拟凭证。" }) {
                try await request(path: "/api/demo/orders", method: "POST", body: ["accountId": accountId, "productId": productId])
            }
        }
    }

    func requestCashRedemption(points: Int) {
        guard offlineState == nil else {
            status = "本地演示不能提交兑付申请，请先重新连接服务器。"
            return
        }
        Task {
            await perform(success: { value in
                guard let record = value.cashRedemptions.first else { return "兑付申请已记录。" }
                return "已记录 \(record.points) 积分 ≈ \(Self.yuan(record.amountFen))；当前未扣积分、未发起真实打款。"
            }) {
                try await request(
                    path: "/api/demo/cash-redemptions",
                    method: "POST",
                    body: ["accountId": accountId, "points": String(points)]
                )
            }
        }
    }

    func reset() {
        if let offline = offlineState {
            saveOffline(offline.resettingOffline())
            status = "本地演示账户已重置。"
            return
        }
        Task {
            await perform(success: { _ in "当前设备的沙盒账户已重置；已进入审计批次的凭证会保留。" }) {
                try await request(path: "/api/demo/reset", method: "POST", body: ["accountId": accountId])
            }
        }
    }

    private func perform(success: (EconomyDemoState) -> String, operation: () async throws -> EconomyDemoState) async {
        guard !isWorking else { return }
        isWorking = true
        defer { isWorking = false }
        do {
            let value = try await operation()
            state = value
            status = success(value)
        } catch {
            handle(error: error)
        }
    }

    private var offlineState: EconomyDemoState? {
        state?.mode == "offline" ? state : nil
    }

    private func handle(error: Error) {
        if let responseError = error as? EconomyServerResponseError, responseError.isClientError {
            status = responseError.localizedDescription
            return
        }
        activateOffline(error: error)
    }

    private func activateOffline(error: Error) {
        if let data = defaults.data(forKey: offlineStateKey),
           let saved = try? JSONDecoder().decode(EconomyDemoState.self, from: data),
           saved.mode == "offline" {
            state = saved
        } else {
            state = .offline(accountId: accountId)
        }
        status = "在线服务器暂时不可达（\(error.localizedDescription)），已自动切换本地演示。"
    }

    private func saveOffline(_ value: EconomyDemoState) {
        state = value
        if let data = try? JSONEncoder().encode(value) {
            defaults.set(data, forKey: offlineStateKey)
        }
    }

    private func request(
        path: String,
        method: String = "GET",
        query: [String: String] = [:],
        body: [String: String]? = nil
    ) async throws -> EconomyDemoState {
        let encodedBody = try body.map { try JSONEncoder().encode($0) }
        var lastError: Error?

        // Read-only requests can safely try both hostnames. Mutating requests stay on the
        // server selected by load(), so a lost response cannot award or spend twice.
        let baseURLs = method == "GET"
            ? EconomyServerConfig.apiBaseURLs
            : [connectedServerURL ?? EconomyServerConfig.apiBaseURLs[0]]
        for baseURL in baseURLs {
            do {
                var components = URLComponents(url: baseURL.appending(path: path), resolvingAgainstBaseURL: false)!
                if !query.isEmpty {
                    components.queryItems = query.map { URLQueryItem(name: $0.key, value: $0.value) }
                }
                var request = URLRequest(url: components.url!)
                request.httpMethod = method
                request.timeoutInterval = 6
                if let encodedBody {
                    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
                    request.httpBody = encodedBody
                }
                let (data, response) = try await URLSession.shared.data(for: request)
                guard let http = response as? HTTPURLResponse else {
                    throw URLError(.badServerResponse)
                }
                guard 200..<300 ~= http.statusCode else {
                    let serverError = (try? JSONDecoder().decode(ServerError.self, from: data).error) ?? "请求失败"
                    throw EconomyServerResponseError(statusCode: http.statusCode, message: serverError)
                }
                let value = try JSONDecoder().decode(EconomyDemoState.self, from: data)
                connectedServerURL = baseURL
                return value
            } catch {
                if let responseError = error as? EconomyServerResponseError, responseError.isClientError {
                    throw responseError
                }
                lastError = error
            }
        }
        throw lastError ?? NSError(
            domain: "SleepEconomyServer",
            code: 2,
            userInfo: [NSLocalizedDescriptionKey: "没有可用的在线服务器"]
        )
    }

    private static func yuan(_ amountFen: Int) -> String {
        String(format: "¥%.2f", Double(amountFen) / 100)
    }
}

private struct EconomyServerResponseError: LocalizedError {
    let statusCode: Int
    let message: String

    var isClientError: Bool { 400..<500 ~= statusCode }
    var errorDescription: String? { message }
}

private struct ServerError: Decodable {
    let error: String
}

struct EconomyDemoView: View {
    @StateObject private var demo = EconomyDemoViewModel()
    @State private var cashPoints = 100

    var body: some View {
        List {
            Section("零价值沙盒") {
                Text("这里演示服务器计分、积分余额、商城兑换和 Monad 审计批次。所有积分和商品均无人民币价值，不上传真实 HealthKit 数据。")
                    .font(.footnote)
#if os(macOS)
                Text("电脑与 iPhone 使用各自独立的演示账户，因此两端积分和凭证不会自动同步。")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
#endif
                LabeledContent("服务器状态", value: demo.status)
                LabeledContent("当前模式", value: demo.state?.mode == "offline" ? "本地演示" : "云端沙盒")
                LabeledContent("沙盒积分", value: "\(demo.state?.account.points ?? 0)")
                if demo.state?.mode == "offline" {
                    Text("当前网络无法连接云端，积分与兑换只保存在本机，不会加入新的链上批次。下方已有的合约和交易记录仍是真实 Monad 测试网公开信息。")
                        .font(.footnote)
                        .foregroundStyle(.orange)
                    Button("重新连接服务器") {
                        Task { await demo.load() }
                    }
                    .disabled(demo.isWorking)
                }
                Button("计算并领取样例 A 积分") {
                    demo.simulateNight(profile: "screenshot")
                }
                .buttonStyle(.borderedProminent)
                .disabled(demo.isWorking)
                Link("打开网页版演示", destination: EconomyServerConfig.webpageURL)
                Button("重置沙盒账户", role: .destructive, action: demo.reset)
                    .disabled(demo.isWorking)
            }

            Section("四维确定性计分 · 去标识化样例 A") {
                Text("用户授权公开的演示汇总：07:36–15:13；清醒 31、REM 50、浅睡 250、深睡 105 分钟。阶段汇总 436 分钟，图轴 457 分钟，相差的 21 分钟不自行补齐、不计分；不包含姓名或原图。")
                    .font(.footnote)
                scoreBreakdown(
                    demo.state?.claims.first(where: { $0.scoreBreakdown != nil })?.scoreBreakdown
                    ?? .september4Example
                )
                Text("6 次中断来自图中可见片段估计；截图无法精确恢复每个切换分钟。25% 是当前激励参数，不是统一医学标准。")
                    .font(.footnote)
                    .foregroundStyle(.orange)
            }

            if let state = demo.state {
                Section("积分兑人民币 · 品牌预算试点") {
                    Text("正式模式由品牌方预付活动预算，平台按当期兑付率结算；一笔申请提交后锁定汇率。")
                        .font(.footnote)
                    LabeledContent(
                        "当前状态",
                        value: state.cashPolicy.payoutEnabled ? "真实兑付已开通" : "试点接入准备中"
                    )
                    LabeledContent(
                        "当期兑付率",
                        value: "100 积分 = \(yuan(state.cashPolicy.rateFenPer100Points))"
                    )
                    LabeledContent(
                        "浮动区间",
                        value: "\(yuan(state.cashPolicy.rateFloorFenPer100Points))–\(yuan(state.cashPolicy.rateCeilingFenPer100Points)) / 100 积分"
                    )
                    LabeledContent("预计可兑换", value: yuan(cashAmountFen(policy: state.cashPolicy)))
                    Stepper(
                        "兑换 \(cashPoints) 积分",
                        value: $cashPoints,
                        in: state.cashPolicy.minimumPoints...state.cashPolicy.maximumPoints,
                        step: 100
                    )
                    Button("使用全部积分") {
                        cashPoints = state.account.points
                    }
                    .disabled(state.account.points < state.cashPolicy.minimumPoints)
                    Button("提交兑付申请") {
                        demo.requestCashRedemption(points: cashPoints)
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(
                        demo.isWorking
                        || state.mode == "offline"
                        || cashPoints < state.cashPolicy.minimumPoints
                        || cashPoints > state.cashPolicy.maximumPoints
                        || cashPoints > state.account.points
                    )
                    Text("当前没有真实打款：提交后只保存接入申请，不扣积分。品牌资金到账、企业支付商户、用户实名与单独同意、财税和反作弊审核完成后，才能启用支付。")
                        .font(.footnote)
                        .foregroundStyle(.orange)
                    LabeledContent("品牌资金", value: state.cashPolicy.sponsorBudgetStatus)
                    LabeledContent("计划渠道", value: state.cashPolicy.payoutChannel)
                    if state.cashRedemptions.isEmpty {
                        Text("尚无兑付申请。")
                    }
                    ForEach(state.cashRedemptions) { redemption in
                        VStack(alignment: .leading, spacing: 4) {
                            Text("\(redemption.points) 积分 ≈ \(yuan(redemption.amountFen))")
                            Text("接入准备中 · 尚未打款")
                                .foregroundStyle(.orange)
                            Text("锁定汇率：100 积分 = \(yuan(redemption.rateFenPer100Points))")
                            Text("申请编号：\(shortened(redemption.id))")
                        }
                        .font(.caption)
                    }
                }

                Section("沙盒商城") {
                    ForEach(state.products) { product in
                        HStack {
                            VStack(alignment: .leading) {
                                Text(product.title)
                                Text("\(product.pricePoints) 积分")
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                            Spacer()
                            Button("兑换") { demo.buy(productId: product.id) }
                                .disabled(demo.isWorking || state.account.points < product.pricePoints)
                        }
                    }
                }

                Section("每晚唯一链上凭证（动态模拟）") {
                    Text("固定合约是审计入口；每次睡眠变化的是唯一凭证、交易和区块。以下逐晚记录明确为流程模拟，不会消耗测试币。")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                    if state.claims.isEmpty {
                        Text("尚无模拟睡眠。")
                    }
                    ForEach(state.claims) { claim in
                        VStack(alignment: .leading, spacing: 5) {
                            Text("\(claim.nightKey) · +\(claim.awardedPoints) 积分")
                            if let score = claim.scoreBreakdown {
                                Text("四维 V\(score.scoringVersion) · 阶段分 \(score.stagePoints) → 实发 \(score.awardedPoints)")
                                    .font(.caption)
                            }
                            if let receipt = claim.chainReceipt {
                                Text("模拟确认 · \(receipt.confirmations) 次确认")
                                    .font(.caption)
                                    .foregroundStyle(.orange)
                                Text("凭证 \(shortened(receipt.claimHash))")
                                Text("交易 \(shortened(receipt.transactionHash))")
                                Text("模拟区块 #\(receipt.blockNumber)")
                            } else {
                                Text(claim.batchId ?? "本地记录，未生成云端模拟凭证")
                            }
                        }
                        .font(.caption.monospaced())
                    }
                }

                Section("兑换记录与唯一凭证（动态模拟）") {
                    Text("每次积分消费都会生成不同且刷新稳定的兑换凭证、模拟交易和模拟区块；它们不是真实测试网交易。")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                    if state.orders.isEmpty {
                        Text("尚无兑换记录。")
                    }
                    ForEach(state.orders) { order in
                        VStack(alignment: .leading, spacing: 5) {
                            Text("\(order.title) · -\(order.pricePoints) 积分")
                            if let receipt = order.chainReceipt {
                                Text("模拟确认 · \(receipt.confirmations) 次确认")
                                    .foregroundStyle(.orange)
                                Text("兑换凭证 \(shortened(receipt.claimHash))")
                                Text("交易 \(shortened(receipt.transactionHash))")
                                Text("模拟区块 #\(receipt.blockNumber)")
                            } else {
                                Text("本地兑换，未生成云端模拟凭证")
                            }
                        }
                        .font(.caption.monospaced())
                    }
                }

                Section("真实 Monad 测试网锚点") {
                    Text("网络和合约地址保持固定是正常设计；每次正式锚定会产生不同交易、区块高度和 Merkle Root。")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                    LabeledContent("网络", value: "\(state.network.name) · \(state.network.chainId)")
                    LabeledContent("固定审计合约", value: state.network.contractAddress ?? "尚未部署")
                    if state.batches.isEmpty {
                        Text("尚无审计批次。")
                    }
                    ForEach(state.batches) { batch in
                        VStack(alignment: .leading, spacing: 5) {
                            Text("\(batch.claimCount) 份凭证 · V\(batch.scoringVersion) · \(batch.chainStatus)")
                            Text(batch.merkleRoot)
                                .font(.caption2.monospaced())
                                .lineLimit(2)
                            if let blockNumber = batch.blockNumber {
                                Text("真实区块 #\(blockNumber)")
                                    .font(.caption.monospaced())
                            }
                            if let hash = batch.transactionHash,
                               let url = URL(string: "\(state.network.explorerURL)/tx/\(hash)") {
                                Link("查看真实测试网交易", destination: url)
                            }
                        }
                    }
                }
            }
        }
        .navigationTitle("云端经济演示")
        .task { await demo.load() }
        .refreshable { await demo.load() }
    }

    private func shortened(_ value: String) -> String {
        guard value.count > 24 else { return value }
        return "\(value.prefix(12))…\(value.suffix(10))"
    }

    private func cashAmountFen(policy: EconomyDemoState.CashPolicy) -> Int {
        cashPoints * policy.rateFenPer100Points / 100
    }

    private func yuan(_ amountFen: Int) -> String {
        String(format: "¥%.2f", Double(amountFen) / 100)
    }

    @ViewBuilder
    private func scoreBreakdown(_ score: EconomyDemoState.ScoreBreakdown) -> some View {
        LabeledContent("有效睡眠", value: "\(score.countedMinutes) / 480 分钟")
        LabeledContent("浅睡", value: "\(score.stageMinutes.core) 分钟 × 1")
        LabeledContent("REM", value: "\(score.stageMinutes.rem) 分钟 × 2")
        LabeledContent("深睡", value: "\(score.stageMinutes.deep) 分钟 × \(String(format: "%.3f", score.effectiveDeepWeight))")
        LabeledContent("计分深睡占比", value: "\(String(format: "%.1f%%", score.deepRatioPercent))（仅实际睡眠）")
        if let vendorPercent = score.vendorReportedDeepPercent {
            LabeledContent("设备展示占比", value: "\(String(format: "%.1f%%", vendorPercent))（分母含清醒）")
        }
        LabeledContent("连续性", value: "约 \(score.interruptionCount) 次 · × \(String(format: "%.3f", score.continuityFactor))")
        LabeledContent("规律性", value: "× \(String(format: "%.3f", score.regularityFactor))")
        Text(score.regularityBasis)
            .font(.caption)
            .foregroundStyle(.secondary)
        LabeledContent("阶段分钟小计", value: "\(score.stagePoints)")
        LabeledContent("最终沙盒积分", value: "\(score.awardedPoints)")
        Text("\(score.stagePoints) × \(String(format: "%.3f", score.continuityFactor)) × \(String(format: "%.3f", score.regularityFactor)) = \(score.awardedPoints)")
            .font(.caption.monospaced())
            .textSelection(.enabled)
    }
}
