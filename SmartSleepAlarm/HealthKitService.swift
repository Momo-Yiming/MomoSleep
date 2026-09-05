import Foundation
import HealthKit

final class HealthKitService {
    private let store = HKHealthStore()
    private let sleepType = HKObjectType.categoryType(forIdentifier: .sleepAnalysis)!
    private var observer: HKObserverQuery?
    private var metricObservers: [HKObserverQuery] = []

    private struct MetricDefinition {
        let identifier: HKQuantityTypeIdentifier
        let name: String
        let unit: HKUnit
        let scale: Double
        let suffix: String
    }

    private static let metricDefinitions = [
        MetricDefinition(identifier: .heartRate, name: "心率", unit: .count().unitDivided(by: .minute()), scale: 1, suffix: "次/分"),
        MetricDefinition(identifier: .restingHeartRate, name: "静息心率", unit: .count().unitDivided(by: .minute()), scale: 1, suffix: "次/分"),
        MetricDefinition(identifier: .oxygenSaturation, name: "血氧", unit: .percent(), scale: 100, suffix: "%"),
        MetricDefinition(identifier: .respiratoryRate, name: "呼吸频率", unit: .count().unitDivided(by: .minute()), scale: 1, suffix: "次/分"),
        MetricDefinition(identifier: .stepCount, name: "步数", unit: .count(), scale: 1, suffix: "步")
    ]

    private static var metricTypes: [HKQuantityType] {
        metricDefinitions.compactMap { HKObjectType.quantityType(forIdentifier: $0.identifier) }
    }

    func requestAuthorization() async throws {
        guard HKHealthStore.isHealthDataAvailable() else { throw HealthError.unavailable }
        try await store.requestAuthorization(toShare: [], read: Set([sleepType] + Self.metricTypes))
    }

    func fetchMetricSnapshots(hours: Int = 24) async throws -> [HealthMetricSnapshot] {
        let start = Calendar.current.date(byAdding: .hour, value: -hours, to: .now)!
        var snapshots: [HealthMetricSnapshot] = []
        for definition in Self.metricDefinitions {
            guard let type = HKObjectType.quantityType(forIdentifier: definition.identifier) else { continue }
            let samples = try await fetchQuantitySamples(type: type, start: start)
            let ringConnSamples = samples.filter { $0.sourceRevision.source.name.localizedCaseInsensitiveContains("ringconn") }
            let latest = ringConnSamples.first ?? samples.first
            snapshots.append(HealthMetricSnapshot(
                identifier: definition.identifier.rawValue,
                name: definition.name,
                suffix: definition.suffix,
                sampleCount: samples.count,
                ringConnSampleCount: ringConnSamples.count,
                latestValue: latest.map { $0.quantity.doubleValue(for: definition.unit) * definition.scale },
                latestDate: latest?.endDate,
                latestSource: latest.map { "\($0.sourceRevision.source.name) (\($0.sourceRevision.source.bundleIdentifier))" }
            ))
        }
        return snapshots
    }

    func fetchSleepSamples(days: Int = 2) async throws -> [SleepSample] {
        let start = Calendar.current.date(byAdding: .day, value: -days, to: .now)!
        let predicate = HKQuery.predicateForSamples(withStart: start, end: .now, options: .strictStartDate)
        return try await withCheckedThrowingContinuation { continuation in
            let query = HKSampleQuery(sampleType: sleepType, predicate: predicate, limit: HKObjectQueryNoLimit, sortDescriptors: [NSSortDescriptor(key: HKSampleSortIdentifierEndDate, ascending: false)]) { _, results, error in
                if let error { continuation.resume(throwing: error); return }
                continuation.resume(returning: (results as? [HKCategorySample] ?? []).compactMap(Self.map))
            }
            store.execute(query)
        }
    }

    func startObserving(onChange: @escaping @Sendable () async -> Void) async throws {
        if observer != nil {
            try await store.enableBackgroundDelivery(for: sleepType, frequency: .immediate)
            return
        }
        let query = HKObserverQuery(sampleType: sleepType, predicate: nil) { _, completion, error in
            guard error == nil else { completion(); return }
            Task {
                await onChange()
                completion()
            }
        }
        observer = query
        store.execute(query)
        do { try await store.enableBackgroundDelivery(for: sleepType, frequency: .immediate) }
        catch {
            store.stop(query)
            observer = nil
            throw error
        }
    }

    func startMetricObserving(onChange: @escaping @Sendable () async -> Void) async throws {
        if !metricObservers.isEmpty {
            for type in Self.metricTypes {
                try await store.enableBackgroundDelivery(for: type, frequency: .immediate)
            }
            return
        }

        for type in Self.metricTypes {
            let query = HKObserverQuery(sampleType: type, predicate: nil) { _, completion, error in
                guard error == nil else { completion(); return }
                Task {
                    await onChange()
                    completion()
                }
            }
            metricObservers.append(query)
            store.execute(query)
            do {
                try await store.enableBackgroundDelivery(for: type, frequency: .immediate)
            } catch {
                store.stop(query)
                metricObservers.removeAll { $0 === query }
                throw error
            }
        }
    }

    private func fetchQuantitySamples(type: HKQuantityType, start: Date) async throws -> [HKQuantitySample] {
        let predicate = HKQuery.predicateForSamples(withStart: start, end: .now, options: .strictStartDate)
        return try await withCheckedThrowingContinuation { continuation in
            let query = HKSampleQuery(
                sampleType: type,
                predicate: predicate,
                limit: HKObjectQueryNoLimit,
                sortDescriptors: [NSSortDescriptor(key: HKSampleSortIdentifierEndDate, ascending: false)]
            ) { _, results, error in
                if let error { continuation.resume(throwing: error); return }
                continuation.resume(returning: results as? [HKQuantitySample] ?? [])
            }
            store.execute(query)
        }
    }

    private static func map(_ sample: HKCategorySample) -> SleepSample? {
        let stage: SleepStage
        switch HKCategoryValueSleepAnalysis(rawValue: sample.value) {
        case .awake: stage = .awake
        case .inBed: stage = .inBed
        case .asleepDeep: stage = .deep
        case .asleepREM: stage = .rem
        case .asleepCore: stage = .core
        case .asleepUnspecified: stage = .asleep
        default: return nil
        }
        return SleepSample(id: sample.uuid, start: sample.startDate, end: sample.endDate, stage: stage, source: "\(sample.sourceRevision.source.name) (\(sample.sourceRevision.source.bundleIdentifier))")
    }
}

struct HealthMetricSnapshot: Identifiable {
    let identifier: String
    let name: String
    let suffix: String
    let sampleCount: Int
    let ringConnSampleCount: Int
    let latestValue: Double?
    let latestDate: Date?
    let latestSource: String?

    var id: String { identifier }

    var formattedValue: String {
        guard let latestValue else { return "无数据" }
        return "\(latestValue.formatted(.number.precision(.fractionLength(0...1)))) \(suffix)"
    }
}

enum HealthError: LocalizedError {
    case unavailable

    var errorDescription: String? { "此设备不可用 HealthKit。" }
}
