import Foundation

@main
enum CoreCheck {
    static func main() {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(secondsFromGMT: 0)!
        let now = Date(timeIntervalSince1970: 6 * 3600 + 45 * 60)
        let policy = SleepPolicy(
            minimumSleep: 6 * 3600,
            minimumDeepREM: 90 * 60,
            wakeWindow: WakeWindow(startHour: 6, startMinute: 30, endHour: 7, endMinute: 0)
        )

        let passing = [
            sample(now: now, startHoursAgo: 7, endHoursAgo: 4, stage: .core),
            sample(now: now, startHoursAgo: 4, endHoursAgo: 2.5, stage: .deep),
            sample(now: now, startHoursAgo: 2.5, endHoursAgo: 0, stage: .rem)
        ]
        require(SleepEvaluator.evaluate(samples: passing, policy: policy, now: now, calendar: calendar).canWake, "all thresholds should pass")

        let awake = SleepSample(start: now.addingTimeInterval(-60), end: now, stage: .awake, source: "check")
        require(!SleepEvaluator.evaluate(samples: passing + [awake], policy: policy, now: now, calendar: calendar).canWake, "latest awake stage should block wake")

        let overlap = [
            sample(now: now, startHoursAgo: 6, endHoursAgo: 3, stage: .core),
            sample(now: now, startHoursAgo: 5, endHoursAgo: 0, stage: .rem)
        ]
        let overlapResult = SleepEvaluator.evaluate(samples: overlap, policy: policy, now: now, calendar: calendar)
        require(overlapResult.totalSleep == 6 * 3600, "overlapping sleep must not be double-counted")
        require(overlapResult.deepREM == 5 * 3600, "Deep/REM overlap must not be double-counted")

        let oldNight = sample(now: now, startHoursAgo: 30, endHoursAgo: 25, stage: .deep)
        let recentNap = sample(now: now, startHoursAgo: 3, endHoursAgo: 0, stage: .rem)
        let latestSession = SleepEvaluator.evaluate(samples: [oldNight, recentNap], policy: policy, now: now, calendar: calendar)
        require(latestSession.totalSleep == 3 * 3600, "previous sleep sessions must not count")
        require(!latestSession.canWake, "a short latest session must not pass with an older night")

        let overnight = WakeWindow(startHour: 23, startMinute: 0, endHour: 1, endMinute: 0)
        require(overnight.contains(Date(timeIntervalSince1970: 30 * 60), calendar: calendar), "overnight wake window should wrap midnight")

        let short = sample(now: now, startHoursAgo: 4, endHoursAgo: 0, stage: .rem)
        let shortResult = SleepEvaluator.evaluate(samples: [short], policy: policy, now: now, calendar: calendar)
        require(!shortResult.canWake && shortResult.reason == "总睡眠未达最短时长", "short sleep should fail minimum duration")

        let core = sample(now: now, startHoursAgo: 6.5, endHoursAgo: 0.5, stage: .core)
        let littleREM = sample(now: now, startHoursAgo: 0.5, endHoursAgo: 0, stage: .rem)
        let recoveryResult = SleepEvaluator.evaluate(samples: [core, littleREM], policy: policy, now: now, calendar: calendar)
        require(!recoveryResult.canWake && recoveryResult.reason == "Deep + REM 累积不足", "low Deep/REM should fail recovery threshold")

        let outside = Date(timeIntervalSince1970: 8 * 3600)
        require(!SleepEvaluator.evaluate(samples: passing, policy: policy, now: outside, calendar: calendar).canWake, "outside wake window should fail")

        let bedtime = calendar.date(from: DateComponents(year: 2026, month: 8, day: 25, hour: 23))!
        let predicted = WakePlanner.predictedWake(
            bedtime: bedtime,
            wakeWindow: policy.wakeWindow,
            sleepLatencyMinutes: 15,
            cycleMinutes: 90,
            calendar: calendar
        )
        require(calendar.component(.hour, from: predicted) == 6 && calendar.component(.minute, from: predicted) == 45, "prediction should choose the 06:45 cycle boundary")

        let fallback = WakePlanner.predictedWake(
            bedtime: bedtime,
            wakeWindow: WakeWindow(startHour: 6, startMinute: 30, endHour: 6, endMinute: 40),
            sleepLatencyMinutes: 15,
            cycleMinutes: 90,
            calendar: calendar
        )
        require(calendar.component(.hour, from: fallback) == 6 && calendar.component(.minute, from: fallback) == 40, "prediction should fall back to the window end")

        let latestBoundary = WakePlanner.predictedWake(
            bedtime: calendar.date(from: DateComponents(year: 2026, month: 8, day: 25, hour: 22))!,
            wakeWindow: WakeWindow(startHour: 3, startMinute: 45, endHour: 7, endMinute: 15),
            sleepLatencyMinutes: 0,
            cycleMinutes: 90,
            calendar: calendar
        )
        require(calendar.component(.hour, from: latestBoundary) == 7 && calendar.component(.minute, from: latestBoundary) == 0, "prediction should choose the latest cycle boundary in a wide window")
        print("Core checks passed (13 assertions).")
    }

    private static func sample(now: Date, startHoursAgo: Double, endHoursAgo: Double, stage: SleepStage) -> SleepSample {
        SleepSample(
            start: now.addingTimeInterval(-startHoursAgo * 3600),
            end: now.addingTimeInterval(-endHoursAgo * 3600),
            stage: stage,
            source: "check"
        )
    }

    private static func require(_ condition: @autoclosure () -> Bool, _ message: String) {
        guard condition() else { fatalError("Core check failed: \(message)") }
    }
}
