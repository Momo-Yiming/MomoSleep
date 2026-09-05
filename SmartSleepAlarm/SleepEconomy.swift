import CryptoKit
import Foundation
import Security
import SwiftUI

enum SleepTrustGrade: String, Codable, CaseIterable, Identifiable {
    case vendorSigned
    case appAttested
    case healthKitSource
    case unverified

    var id: String { rawValue }

    var title: String {
        switch self {
        case .vendorSigned: "A · 厂商签名"
        case .appAttested: "B · HealthKit + App Attest"
        case .healthKitSource: "C · HealthKit 来源"
        case .unverified: "D · 模拟或未验证"
        }
    }

    var multiplierBasisPoints: Int {
        switch self {
        case .vendorSigned: 10_000
        case .appAttested: 9_000
        case .healthKitSource: 7_000
        case .unverified: 0
        }
    }
}

struct SleepEconomyPolicy: Codable, Equatable {
    var scoringVersion = 2
    var maximumMinutes = 480
    var asleepWeight = 1
    var coreWeight = 1
    var remWeight = 2
    var dailyPointCap = 1_440
    var targetDeepBasisPoints = 2_500
    var minimumQualityBasisPoints = 7_000
    var interruptionPenaltyBasisPoints = 200
    var awakeMinutePenaltyBasisPoints = 10
    var regularityPenaltyWindowMinutes = 600
}

struct SleepStageMinutes: Codable, Equatable {
    var asleep = 0
    var core = 0
    var rem = 0
    var deep = 0
    var awake = 0
    var conflicting = 0

    var counted: Int { asleep + core + rem + deep }

    private enum CodingKeys: String, CodingKey {
        case asleep, core, rem, deep, awake, conflicting
    }

    init(
        asleep: Int = 0,
        core: Int = 0,
        rem: Int = 0,
        deep: Int = 0,
        awake: Int = 0,
        conflicting: Int = 0
    ) {
        self.asleep = asleep
        self.core = core
        self.rem = rem
        self.deep = deep
        self.awake = awake
        self.conflicting = conflicting
    }

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        asleep = try values.decodeIfPresent(Int.self, forKey: .asleep) ?? 0
        core = try values.decodeIfPresent(Int.self, forKey: .core) ?? 0
        rem = try values.decodeIfPresent(Int.self, forKey: .rem) ?? 0
        deep = try values.decodeIfPresent(Int.self, forKey: .deep) ?? 0
        awake = try values.decodeIfPresent(Int.self, forKey: .awake) ?? 0
        conflicting = try values.decodeIfPresent(Int.self, forKey: .conflicting) ?? 0
    }
}

struct SleepQualityContext: Codable, Equatable {
    var awakeMinutes: Int
    var interruptionCount: Int
    var scheduleDeviationMinutes: Int?
    var regularityBasis: String

    static let neutral = SleepQualityContext(
        awakeMinutes: 0,
        interruptionCount: 0,
        scheduleDeviationMinutes: nil,
        regularityBasis: "尚无多晚个人基线，本项按中性 1.0 计算"
    )

    static let september4Example = SleepQualityContext(
        awakeMinutes: 31,
        interruptionCount: 6,
        scheduleDeviationMinutes: 565,
        regularityBasis: "演示目标 21:00–07:00；入睡圆周偏差 636 分钟、醒来偏差 493 分钟，平均 565；不是多晚个人基线"
    )
}

struct SleepQualityBreakdown: Codable, Equatable {
    let awakeMinutes: Int
    let interruptionCount: Int
    let deepRatioBasisPoints: Int
    let effectiveDeepWeightBasisPoints: Int
    let stagePoints: Int
    let continuityFactorBasisPoints: Int
    let scheduleDeviationMinutes: Int?
    let regularityFactorBasisPoints: Int
    let regularityBasis: String
}

struct SleepEconomyAssessment: Equatable {
    let stageMinutes: SleepStageMinutes
    let availableMinutes: Int
    let quality: SleepQualityBreakdown
    let rawPoints: Int
    let awardedPoints: Int
    let estimatedPoints: Int
    let trustGrade: SleepTrustGrade
    let reason: String

    static let empty = SleepEconomyAssessment(
        stageMinutes: SleepStageMinutes(),
        availableMinutes: 0,
        quality: SleepQualityBreakdown(
            awakeMinutes: 0,
            interruptionCount: 0,
            deepRatioBasisPoints: 0,
            effectiveDeepWeightBasisPoints: 10_000,
            stagePoints: 0,
            continuityFactorBasisPoints: 10_000,
            scheduleDeviationMinutes: nil,
            regularityFactorBasisPoints: 10_000,
            regularityBasis: SleepQualityContext.neutral.regularityBasis
        ),
        rawPoints: 0,
        awardedPoints: 0,
        estimatedPoints: 0,
        trustGrade: .unverified,
        reason: "暂无可计分睡眠"
    )
}

enum SleepEconomyEngine {
    static func assess(
        samples: [SleepSample],
        policy: SleepEconomyPolicy = SleepEconomyPolicy(),
        trustGrade: SleepTrustGrade? = nil,
        qualityContext: SleepQualityContext? = nil
    ) -> SleepEconomyAssessment {
        let session = SleepEvaluator.mostRecentSession(in: samples)
        let resolved = resolveStageSeconds(in: session)
        let availableSeconds = resolved.seconds.values.reduce(0, +)
        let grade = trustGrade ?? inferredTrustGrade(from: session)
        guard availableSeconds > 0 else { return .empty }
        let source = SleepStageMinutes(
            asleep: roundedMinutes(resolved.seconds[.asleep, default: 0]),
            core: roundedMinutes(resolved.seconds[.core, default: 0]),
            rem: roundedMinutes(resolved.seconds[.rem, default: 0]),
            deep: roundedMinutes(resolved.seconds[.deep, default: 0]),
            awake: roundedMinutes(resolved.awakeSeconds),
            conflicting: resolved.conflictingSeconds / 60
        )
        let context = qualityContext ?? SleepQualityContext(
            awakeMinutes: source.awake,
            interruptionCount: resolved.interruptionCount,
            scheduleDeviationMinutes: nil,
            regularityBasis: SleepQualityContext.neutral.regularityBasis
        )
        return score(stageMinutes: source, policy: policy, trustGrade: grade, qualityContext: context)
    }

    static func score(
        stageMinutes source: SleepStageMinutes,
        policy: SleepEconomyPolicy = SleepEconomyPolicy(),
        trustGrade grade: SleepTrustGrade = .unverified,
        qualityContext context: SleepQualityContext = .neutral
    ) -> SleepEconomyAssessment {
        let total = source.counted
        guard total > 0 else { return .empty }
        let counted = min(total, policy.maximumMinutes)
        let deepDistance = abs(source.deep * 10_000 - total * policy.targetDeepBasisPoints)
        let depthCloseness = max(
            0,
            10_000 - roundedDivide(deepDistance * 10_000, by: total * policy.targetDeepBasisPoints)
        )
        let effectiveDeepWeight = 10_000 + 2 * depthCloseness
        let weightedBasisPoints =
            (source.asleep * policy.asleepWeight + source.core * policy.coreWeight) * 10_000
            + source.rem * policy.remWeight * 10_000
            + source.deep * effectiveDeepWeight
        let stagePoints = min(
            policy.dailyPointCap,
            roundedDivide(weightedBasisPoints * counted, by: total * 10_000)
        )
        let awake = max(0, context.awakeMinutes)
        let interruptions = max(0, context.interruptionCount)
        let continuity = max(
            policy.minimumQualityBasisPoints,
            10_000 - interruptions * policy.interruptionPenaltyBasisPoints - awake * policy.awakeMinutePenaltyBasisPoints
        )
        let regularity = context.scheduleDeviationMinutes.map {
            max(
                policy.minimumQualityBasisPoints,
                10_000 - roundedDivide(max(0, $0) * 10_000, by: policy.regularityPenaltyWindowMinutes)
            )
        } ?? 10_000
        let awardedPoints = min(
            policy.dailyPointCap,
            roundedDivide(stagePoints * continuity * regularity, by: 100_000_000)
        )
        let estimatedPoints = awardedPoints * grade.multiplierBasisPoints / 10_000
        let scaleNumerator = counted
        let stageMinutes = SleepStageMinutes(
            asleep: source.asleep * scaleNumerator / total,
            core: source.core * scaleNumerator / total,
            rem: source.rem * scaleNumerator / total,
            deep: source.deep * scaleNumerator / total,
            awake: awake,
            conflicting: source.conflicting
        )
        let reason = grade == .unverified
            ? "四维 V2 模拟或未验证数据只展示试算，不进入真实结算"
            : "四维 V2 本地试算；正式积分仍需服务器防重复与真实性审核"
        return SleepEconomyAssessment(
            stageMinutes: stageMinutes,
            availableMinutes: total,
            quality: SleepQualityBreakdown(
                awakeMinutes: awake,
                interruptionCount: interruptions,
                deepRatioBasisPoints: roundedDivide(source.deep * 10_000, by: total),
                effectiveDeepWeightBasisPoints: effectiveDeepWeight,
                stagePoints: stagePoints,
                continuityFactorBasisPoints: continuity,
                scheduleDeviationMinutes: context.scheduleDeviationMinutes,
                regularityFactorBasisPoints: regularity,
                regularityBasis: context.regularityBasis
            ),
            rawPoints: stagePoints,
            awardedPoints: awardedPoints,
            estimatedPoints: estimatedPoints,
            trustGrade: grade,
            reason: reason
        )
    }

    static func inferredTrustGrade(from samples: [SleepSample]) -> SleepTrustGrade {
        guard !samples.isEmpty else { return .unverified }
        let unverifiedMarkers = ["模拟", "test", "check"]
        if samples.contains(where: { sample in
            unverifiedMarkers.contains { sample.source.localizedCaseInsensitiveContains($0) }
        }) {
            return .unverified
        }
        return .healthKitSource
    }

    private static func roundedMinutes(_ seconds: Int) -> Int {
        roundedDivide(seconds, by: 60)
    }

    private static func roundedDivide(_ numerator: Int, by denominator: Int) -> Int {
        guard denominator > 0 else { return 0 }
        return (numerator + denominator / 2) / denominator
    }

    private static func resolveStageSeconds(in samples: [SleepSample]) -> (seconds: [SleepStage: Int], awakeSeconds: Int, interruptionCount: Int, conflictingSeconds: Int) {
        let valid = samples.filter { $0.end > $0.start && $0.stage != .inBed }
        let boundaries = Array(Set(valid.flatMap { [$0.start, $0.end] })).sorted()
        guard boundaries.count > 1 else { return ([:], 0, 0, 0) }

        var seconds: [SleepStage: Int] = [:]
        var conflictingSeconds = 0
        var resolvedSegments: [(start: Date, end: Date, stage: SleepStage)] = []
        for (start, end) in zip(boundaries, boundaries.dropFirst()) {
            let duration = Int(end.timeIntervalSince(start))
            guard duration > 0 else { continue }
            let covering = valid.filter { $0.start < end && $0.end > start }.map(\.stage)
            let hasAwake = covering.contains(.awake)
            let specific = Set(covering.filter { $0 == .core || $0 == .rem || $0 == .deep })
            if (hasAwake && (!specific.isEmpty || covering.contains(.asleep))) || specific.count > 1 {
                conflictingSeconds += duration
                continue
            }
            if hasAwake {
                resolvedSegments.append((start, end, .awake))
            } else if let stage = specific.first {
                seconds[stage, default: 0] += duration
                resolvedSegments.append((start, end, stage))
            } else if covering.contains(.asleep) {
                seconds[.asleep, default: 0] += duration
                resolvedSegments.append((start, end, .asleep))
            }
        }
        let sleepSegments = resolvedSegments.filter { $0.stage.countsAsSleep }
        guard let firstSleep = sleepSegments.first?.start, let lastSleep = sleepSegments.last?.end else {
            return (seconds, 0, 0, conflictingSeconds)
        }
        let internalAwake = resolvedSegments.filter { $0.stage == .awake && $0.start >= firstSleep && $0.end <= lastSleep }
        var mergedAwake: [(Date, Date)] = []
        for segment in internalAwake {
            if let last = mergedAwake.last, segment.start <= last.1 {
                mergedAwake[mergedAwake.count - 1].1 = max(last.1, segment.end)
            } else {
                mergedAwake.append((segment.start, segment.end))
            }
        }
        let awakeSeconds = mergedAwake.reduce(0) { $0 + Int($1.1.timeIntervalSince($1.0)) }
        let interruptionCount = mergedAwake.filter { $0.1.timeIntervalSince($0.0) >= 3 * 60 }.count
        return (seconds, awakeSeconds, interruptionCount, conflictingSeconds)
    }
}

struct SleepClaimReceipt: Codable, Identifiable, Equatable {
    let id: UUID
    let createdAt: Date
    let nightKey: String
    let commitment: String
    let localNullifier: String
    let salt: String
    let scoringVersion: Int
    let trustGrade: SleepTrustGrade
    let stageMinutes: SleepStageMinutes
    let quality: SleepQualityBreakdown?
    let rawPoints: Int
    let awardedPoints: Int?
    let estimatedPoints: Int
    let sampleCount: Int
}

enum SleepClaimError: LocalizedError, Equatable {
    case noSleep
    case randomGenerationFailed
    case duplicateNight
    case duplicateCommitment

    var errorDescription: String? {
        switch self {
        case .noSleep: "没有可生成凭证的睡眠数据。"
        case .randomGenerationFailed: "无法生成本地随机盐。"
        case .duplicateNight: "这一生理夜已经生成过凭证，不能重复领取。"
        case .duplicateCommitment: "相同睡眠凭证已经存在。"
        }
    }
}

enum SleepClaimBuilder {
    static func makeReceipt(
        samples: [SleepSample],
        accountPseudonym: String,
        policy: SleepEconomyPolicy = SleepEconomyPolicy(),
        calendar: Calendar = .current,
        createdAt: Date = .now,
        salt suppliedSalt: Data? = nil
    ) throws -> SleepClaimReceipt {
        let session = SleepEvaluator.mostRecentSession(in: samples)
        let assessment = SleepEconomyEngine.assess(samples: session, policy: policy)
        guard assessment.availableMinutes > 0, let sessionEnd = session.map(\.end).max() else {
            throw SleepClaimError.noSleep
        }
        let salt = try suppliedSalt ?? randomSalt()
        let nightKey = biologicalNightKey(for: sessionEnd, calendar: calendar)
        let nullifier = sha256("sleep-nullifier-v1|\(accountPseudonym)|\(nightKey)")
        let sampleLines = session
            .filter { $0.end > $0.start }
            .sorted { ($0.start, $0.end, $0.stage.rawValue, $0.id.uuidString) < ($1.start, $1.end, $1.stage.rawValue, $1.id.uuidString) }
            .map {
                let start = Int64(($0.start.timeIntervalSince1970 * 1_000).rounded())
                let end = Int64(($0.end.timeIntervalSince1970 * 1_000).rounded())
                return "\($0.id.uuidString)|\(start)|\(end)|\($0.stage.rawValue)|\($0.source)"
            }
            .joined(separator: "\n")
        let canonical = [
            "sleep-claim-v2",
            "account=\(accountPseudonym)",
            "night=\(nightKey)",
            "scoreVersion=\(policy.scoringVersion)",
            "stagePoints=\(assessment.quality.stagePoints)",
            "deepRatioBP=\(assessment.quality.deepRatioBasisPoints)",
            "deepWeightBP=\(assessment.quality.effectiveDeepWeightBasisPoints)",
            "continuityBP=\(assessment.quality.continuityFactorBasisPoints)",
            "interruptions=\(assessment.quality.interruptionCount)",
            "awakeMinutes=\(assessment.quality.awakeMinutes)",
            "regularityBP=\(assessment.quality.regularityFactorBasisPoints)",
            "scheduleDeviationMinutes=\(assessment.quality.scheduleDeviationMinutes.map(String.init) ?? "unknown")",
            "rawPoints=\(assessment.rawPoints)",
            "awardedPoints=\(assessment.awardedPoints)",
            "estimatedPoints=\(assessment.estimatedPoints)",
            "trust=\(assessment.trustGrade.rawValue)",
            "salt=\(salt.hexString)",
            sampleLines
        ].joined(separator: "\n")
        return SleepClaimReceipt(
            id: UUID(),
            createdAt: createdAt,
            nightKey: nightKey,
            commitment: sha256(canonical),
            localNullifier: nullifier,
            salt: salt.hexString,
            scoringVersion: policy.scoringVersion,
            trustGrade: assessment.trustGrade,
            stageMinutes: assessment.stageMinutes,
            quality: assessment.quality,
            rawPoints: assessment.rawPoints,
            awardedPoints: assessment.awardedPoints,
            estimatedPoints: assessment.estimatedPoints,
            sampleCount: session.count
        )
    }

    static func biologicalNightKey(for sessionEnd: Date, calendar: Calendar = .current) -> String {
        let shifted = calendar.date(byAdding: .hour, value: -12, to: sessionEnd) ?? sessionEnd
        let components = calendar.dateComponents([.year, .month, .day], from: shifted)
        return String(format: "%04d-%02d-%02d", components.year ?? 0, components.month ?? 0, components.day ?? 0)
    }

    private static func randomSalt() throws -> Data {
        var bytes = [UInt8](repeating: 0, count: 32)
        guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else {
            throw SleepClaimError.randomGenerationFailed
        }
        return Data(bytes)
    }

    private static func sha256(_ text: String) -> String {
        Data(SHA256.hash(data: Data(text.utf8))).hexString
    }
}

struct SleepClaimLedger: Codable, Equatable {
    private(set) var receipts: [SleepClaimReceipt] = []

    var totalEstimatedPoints: Int { receipts.reduce(0) { $0 + $1.estimatedPoints } }
    var merkleRoot: String? { SleepMerkleTree.root(for: receipts.map(\.commitment)) }

    mutating func append(_ receipt: SleepClaimReceipt) throws {
        guard !receipts.contains(where: { $0.localNullifier == receipt.localNullifier }) else {
            throw SleepClaimError.duplicateNight
        }
        guard !receipts.contains(where: { $0.commitment == receipt.commitment }) else {
            throw SleepClaimError.duplicateCommitment
        }
        receipts.append(receipt)
        receipts.sort { $0.createdAt > $1.createdAt }
    }
}

struct SleepMerkleProofNode: Codable, Equatable {
    let hash: String
    let siblingOnLeft: Bool
}

struct SleepMerkleProof: Codable, Equatable {
    let commitment: String
    let root: String
    let nodes: [SleepMerkleProofNode]
}

enum SleepMerkleTree {
    static func root(for commitments: [String]) -> String? {
        build(commitments: commitments)?.levels.last?.first?.hexString
    }

    static func proof(for commitment: String, in commitments: [String]) -> SleepMerkleProof? {
        guard let tree = build(commitments: commitments),
              var index = tree.sortedCommitments.firstIndex(of: commitment),
              let root = tree.levels.last?.first?.hexString else { return nil }
        var nodes: [SleepMerkleProofNode] = []
        for level in tree.levels.dropLast() {
            let siblingIndex = index.isMultiple(of: 2) ? min(index + 1, level.count - 1) : index - 1
            nodes.append(SleepMerkleProofNode(hash: level[siblingIndex].hexString, siblingOnLeft: !index.isMultiple(of: 2)))
            index /= 2
        }
        return SleepMerkleProof(commitment: commitment, root: root, nodes: nodes)
    }

    static func verify(_ proof: SleepMerkleProof) -> Bool {
        guard var value = leafHash(proof.commitment) else { return false }
        for node in proof.nodes {
            guard let sibling = Data(hexString: node.hash) else { return false }
            value = node.siblingOnLeft ? parentHash(sibling, value) : parentHash(value, sibling)
        }
        return value.hexString == proof.root
    }

    private static func build(commitments: [String]) -> (sortedCommitments: [String], levels: [[Data]])? {
        let sorted = commitments.sorted()
        guard !sorted.isEmpty else { return nil }
        let leaves = sorted.compactMap(leafHash)
        guard leaves.count == sorted.count else { return nil }
        var levels = [leaves]
        var current = leaves
        while current.count > 1 {
            var next: [Data] = []
            for index in stride(from: 0, to: current.count, by: 2) {
                let right = index + 1 < current.count ? current[index + 1] : current[index]
                next.append(parentHash(current[index], right))
            }
            levels.append(next)
            current = next
        }
        return (sorted, levels)
    }

    private static func leafHash(_ commitment: String) -> Data? {
        guard let value = Data(hexString: commitment) else { return nil }
        return Data(SHA256.hash(data: Data([0]) + value))
    }

    private static func parentHash(_ left: Data, _ right: Data) -> Data {
        Data(SHA256.hash(data: Data([1]) + left + right))
    }
}

struct SleepEconomyView: View {
    @EnvironmentObject private var model: SleepViewModel

    var body: some View {
        List {
            Section("本晚积分试算") {
                LabeledContent("可信等级", value: model.economyAssessment.trustGrade.title)
                LabeledContent("有效睡眠", value: "\(model.economyAssessment.stageMinutes.counted) / 480 分钟")
                LabeledContent("浅睡 / Core", value: "\(model.economyAssessment.stageMinutes.asleep + model.economyAssessment.stageMinutes.core) 分钟 × 1")
                LabeledContent("REM", value: "\(model.economyAssessment.stageMinutes.rem) 分钟 × 2")
                LabeledContent(
                    "深睡",
                    value: "\(model.economyAssessment.stageMinutes.deep) 分钟 × \(factor(model.economyAssessment.quality.effectiveDeepWeightBasisPoints))"
                )
                LabeledContent(
                    "深睡占比",
                    value: "\(percent(model.economyAssessment.quality.deepRatioBasisPoints))（模型目标 25%）"
                )
                LabeledContent(
                    "连续性",
                    value: "\(model.economyAssessment.quality.interruptionCount) 次中断 · × \(factor(model.economyAssessment.quality.continuityFactorBasisPoints))"
                )
                LabeledContent("内部清醒", value: "\(model.economyAssessment.quality.awakeMinutes) 分钟")
                LabeledContent(
                    "规律性",
                    value: "× \(factor(model.economyAssessment.quality.regularityFactorBasisPoints))"
                )
                Text(model.economyAssessment.quality.regularityBasis)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                if model.economyAssessment.stageMinutes.conflicting > 0 {
                    LabeledContent("冲突未计分", value: "\(model.economyAssessment.stageMinutes.conflicting) 分钟")
                }
                LabeledContent("阶段分钟小计", value: "\(model.economyAssessment.quality.stagePoints)")
                LabeledContent("四维后积分", value: "\(model.economyAssessment.awardedPoints)")
                LabeledContent("可信度后试算", value: "\(model.economyAssessment.estimatedPoints)")
                Text(model.economyAssessment.reason)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                Text("25% 是当前可版本化的激励模型参数，不是统一医学标准。")
                    .font(.footnote)
                    .foregroundStyle(.orange)
            }

            Section("本地睡眠凭证") {
                Button("生成本晚本地凭证", action: model.createLocalSleepClaim)
                    .buttonStyle(.borderedProminent)
                Text(model.economyStatus)
                    .font(.footnote)
                LabeledContent("实验凭证", value: "\(model.economyLedger.receipts.count) 份")
                LabeledContent("本地试算总积分", value: "\(model.economyLedger.totalEstimatedPoints)")
                if let root = model.economyLedger.merkleRoot {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("当前批次 Merkle Root")
                        Text(root).font(.caption.monospaced()).textSelection(.enabled)
                    }
                }
            }

            if !model.economyLedger.receipts.isEmpty {
                Section("凭证记录") {
                    ForEach(model.economyLedger.receipts) { receipt in
                        VStack(alignment: .leading, spacing: 4) {
                            Text("生理夜 \(receipt.nightKey) · \(receipt.estimatedPoints) 试算积分")
                                .fontWeight(.semibold)
                            Text(receipt.trustGrade.title)
                                .font(.caption)
                                .foregroundStyle(.secondary)
                            Text(receipt.commitment)
                                .font(.caption2.monospaced())
                                .foregroundStyle(.secondary)
                                .lineLimit(2)
                                .textSelection(.enabled)
                        }
                    }
                }
            }

            Section("当前边界") {
                Text("这里只生成加盐哈希、本地防重复记录和 Merkle 批次根；不会上传健康数据，不会发币，也不会产生可提现余额。正式结算必须经过 App Attest、中心服务器和实名支付风控。")
                    .font(.footnote)
            }
        }
        .navigationTitle("睡眠积分实验")
    }

    private func factor(_ basisPoints: Int) -> String {
        String(format: "%.3f", Double(basisPoints) / 10_000)
    }

    private func percent(_ basisPoints: Int) -> String {
        String(format: "%.1f%%", Double(basisPoints) / 100)
    }
}

private extension Data {
    var hexString: String { map { String(format: "%02x", $0) }.joined() }

    init?(hexString: String) {
        guard hexString.count.isMultiple(of: 2) else { return nil }
        var data = Data(capacity: hexString.count / 2)
        var index = hexString.startIndex
        while index < hexString.endIndex {
            let next = hexString.index(index, offsetBy: 2)
            guard let byte = UInt8(hexString[index..<next], radix: 16) else { return nil }
            data.append(byte)
            index = next
        }
        self = data
    }
}
