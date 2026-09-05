import Foundation

enum SleepStage: String, CaseIterable, Codable, Identifiable {
    case awake = "Awake"
    case asleep = "Asleep"
    case core = "Core"
    case deep = "Deep"
    case rem = "REM"
    case inBed = "In bed"

    var id: String { rawValue }
    var countsAsSleep: Bool { self != .awake && self != .inBed }
}

struct SleepSample: Identifiable {
    let id: UUID
    let start: Date
    let end: Date
    let stage: SleepStage
    let source: String

    init(id: UUID = UUID(), start: Date, end: Date, stage: SleepStage, source: String) {
        self.id = id
        self.start = start
        self.end = end
        self.stage = stage
        self.source = source
    }

    var duration: TimeInterval { max(0, end.timeIntervalSince(start)) }
}

struct SleepPolicy: Codable {
    var minimumSleep: TimeInterval = 6 * 60 * 60
    var minimumDeepREM: TimeInterval = 90 * 60
    var allowedLatestStages: Set<SleepStage> = [.asleep, .core, .rem]
    var wakeWindow = WakeWindow(startHour: 6, startMinute: 30, endHour: 7, endMinute: 0)
}

struct WakeWindow: Codable, Equatable {
    let startHour: Int
    let startMinute: Int
    let endHour: Int
    let endMinute: Int

    func contains(_ date: Date, calendar: Calendar = .current) -> Bool {
        let value = calendar.component(.hour, from: date) * 60 + calendar.component(.minute, from: date)
        let start = startHour * 60 + startMinute
        let end = endHour * 60 + endMinute
        return start <= end ? (start...end).contains(value) : value >= start || value <= end
    }
}

struct SleepEvaluation {
    let canWake: Bool
    let totalSleep: TimeInterval
    let deepREM: TimeInterval
    let latestStage: SleepStage?
    let reason: String
}

enum WakePlanner {
    static func predictedWake(
        bedtime: Date,
        wakeWindow: WakeWindow,
        sleepLatencyMinutes: Int,
        cycleMinutes: Int,
        calendar: Calendar = .current
    ) -> Date {
        let windowStart = nextDate(
            after: bedtime,
            hour: wakeWindow.startHour,
            minute: wakeWindow.startMinute,
            calendar: calendar
        )
        var windowEnd = calendar.date(
            bySettingHour: wakeWindow.endHour,
            minute: wakeWindow.endMinute,
            second: 0,
            of: windowStart
        ) ?? windowStart
        if windowEnd < windowStart {
            windowEnd = calendar.date(byAdding: .day, value: 1, to: windowEnd) ?? windowEnd
        }

        let latency = TimeInterval(max(0, sleepLatencyMinutes) * 60)
        let cycle = TimeInterval(max(1, cycleMinutes) * 60)
        let estimatedSleepStart = bedtime.addingTimeInterval(latency)
        guard estimatedSleepStart < windowEnd else { return windowEnd }

        let cyclesToWindow = max(1, Int(ceil(windowStart.timeIntervalSince(estimatedSleepStart) / cycle)))
        let firstCandidate = estimatedSleepStart.addingTimeInterval(TimeInterval(cyclesToWindow) * cycle)
        guard firstCandidate <= windowEnd else { return windowEnd }

        let additionalCycles = Int(floor(windowEnd.timeIntervalSince(firstCandidate) / cycle))
        return firstCandidate.addingTimeInterval(TimeInterval(additionalCycles) * cycle)
    }

    private static func nextDate(after date: Date, hour: Int, minute: Int, calendar: Calendar) -> Date {
        var components = calendar.dateComponents([.year, .month, .day], from: date)
        components.hour = hour
        components.minute = minute
        components.second = 0
        var result = calendar.date(from: components) ?? date
        if result < date {
            result = calendar.date(byAdding: .day, value: 1, to: result) ?? result
        }
        return result
    }
}

enum SleepEvaluator {
    static func evaluate(samples: [SleepSample], policy: SleepPolicy, now: Date = .now, calendar: Calendar = .current) -> SleepEvaluation {
        let session = mostRecentSession(in: samples)
        let sleepSamples = session.filter { $0.stage.countsAsSleep }
        let totalSleep = mergedDuration(of: sleepSamples)
        let deepREM = mergedDuration(of: sleepSamples.filter { $0.stage == .deep || $0.stage == .rem })
        let latestStage = session
            .filter { $0.stage != .inBed && $0.end > $0.start }
            .max(by: { ($0.end, $0.start) < ($1.end, $1.start) })?
            .stage

        guard latestStage != nil else {
            return SleepEvaluation(canWake: false, totalSleep: totalSleep, deepREM: deepREM, latestStage: nil, reason: "暂无睡眠样本")
        }
        guard policy.wakeWindow.contains(now, calendar: calendar) else {
            return SleepEvaluation(canWake: false, totalSleep: totalSleep, deepREM: deepREM, latestStage: latestStage, reason: "尚未进入唤醒窗口")
        }
        guard totalSleep >= policy.minimumSleep else {
            return SleepEvaluation(canWake: false, totalSleep: totalSleep, deepREM: deepREM, latestStage: latestStage, reason: "总睡眠未达最短时长")
        }
        guard deepREM >= policy.minimumDeepREM else {
            return SleepEvaluation(canWake: false, totalSleep: totalSleep, deepREM: deepREM, latestStage: latestStage, reason: "Deep + REM 累积不足")
        }
        guard let latestStage, policy.allowedLatestStages.contains(latestStage) else {
            return SleepEvaluation(canWake: false, totalSleep: totalSleep, deepREM: deepREM, latestStage: latestStage, reason: "最近阶段不适合唤醒")
        }
        return SleepEvaluation(canWake: true, totalSleep: totalSleep, deepREM: deepREM, latestStage: latestStage, reason: "满足 MVP 唤醒条件")
    }

    static func mostRecentSession(in samples: [SleepSample]) -> [SleepSample] {
        let sorted = samples.filter { $0.end > $0.start }.sorted { ($0.start, $0.end) < ($1.start, $1.end) }
        guard let latest = sorted.last else { return [] }
        var session = [latest]
        var boundary = latest.start
        for sample in sorted.dropLast().reversed() {
            guard boundary.timeIntervalSince(sample.end) <= 2 * 3600 else { break }
            session.append(sample)
            boundary = min(boundary, sample.start)
        }
        return session
    }

    private static func mergedDuration(of samples: [SleepSample]) -> TimeInterval {
        let intervals = samples
            .filter { $0.end > $0.start }
            .map { ($0.start, $0.end) }
            .sorted { $0.0 < $1.0 }
        guard var current = intervals.first else { return 0 }
        var total: TimeInterval = 0
        for interval in intervals.dropFirst() {
            if interval.0 <= current.1 {
                current.1 = max(current.1, interval.1)
            } else {
                total += current.1.timeIntervalSince(current.0)
                current = interval
            }
        }
        return total + current.1.timeIntervalSince(current.0)
    }
}
