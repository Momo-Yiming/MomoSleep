import XCTest
#if SWIFT_PACKAGE
@testable import SmartSleepAlarmCore
#else
@testable import SmartSleepAlarm
#endif

final class SleepEvaluatorTests: XCTestCase {
    func testEconomyServerUsesPagesAndKeepsWorkerFallback() {
        XCTAssertEqual(EconomyServerConfig.webpageURL.host, "smart-sleep-economy-demo.pages.dev")
        XCTAssertEqual(EconomyServerConfig.apiBaseURLs.first, EconomyServerConfig.webpageURL)
        XCTAssertEqual(EconomyServerConfig.apiBaseURLs.count, 2)
    }

    func testOfflineEconomyRemainsUsableWithoutServer() throws {
        let initial = EconomyDemoState.offline(accountId: "test-account")
        let rewarded = try initial.addingOfflineNight(profile: "screenshot")
        XCTAssertEqual(rewarded.account.points, 390)
        XCTAssertEqual(rewarded.claims.count, 1)
        XCTAssertEqual(rewarded.claims.first?.scoreBreakdown?.stagePoints, 657)
        XCTAssertNil(rewarded.claims.first?.chainReceipt)
        XCTAssertEqual(rewarded.batches.first?.chainStatus, "anchored")
        XCTAssertEqual(rewarded.batches.first?.blockNumber, 59_626_845)

        let purchased = try rewarded.purchasingOfflineProduct(id: "eye-mask")
        XCTAssertEqual(purchased.account.points, 210)
        XCTAssertEqual(purchased.orders.first?.status, "local_demo")
        XCTAssertNil(purchased.orders.first?.chainReceipt)

        XCTAssertThrowsError(try rewarded.addingOfflineNight(profile: "screenshot"))
    }

    func testCashRedemptionPilotDoesNotPretendPaymentIsEnabled() {
        let state = EconomyDemoState.offline(accountId: "test-account")
        XCTAssertFalse(state.cashPolicy.payoutEnabled)
        XCTAssertEqual(state.cashPolicy.rateFenPer100Points, 100)
        XCTAssertEqual(state.cashPolicy.minimumPoints, 100)
        XCTAssertTrue(state.cashRedemptions.isEmpty)
    }

    private var calendar: Calendar {
        var value = Calendar(identifier: .gregorian)
        value.timeZone = TimeZone(secondsFromGMT: 0)!
        return value
    }
    private let now = Date(timeIntervalSince1970: 6 * 3600 + 45 * 60)
    private let policy = SleepPolicy(minimumSleep: 6 * 3600, minimumDeepREM: 90 * 60, wakeWindow: WakeWindow(startHour: 6, startMinute: 30, endHour: 7, endMinute: 0))

    func testWakesWhenAllThresholdsPass() {
        let samples = [sample(hoursAgo: 7, duration: 3 * 3600, stage: .core), sample(hoursAgo: 4, duration: 90 * 60, stage: .deep), sample(hoursAgo: 2.5, duration: 2.5 * 3600, stage: .rem)]
        XCTAssertTrue(SleepEvaluator.evaluate(samples: samples, policy: policy, now: now, calendar: calendar).canWake)
    }

    func testDoesNotWakeOutsideWindow() {
        let samples = [sample(hoursAgo: 7, duration: 3 * 3600, stage: .core), sample(hoursAgo: 4, duration: 2 * 3600, stage: .deep), sample(hoursAgo: 2, duration: 2 * 3600, stage: .rem)]
        let outside = Date(timeIntervalSince1970: 8 * 3600)
        XCTAssertFalse(SleepEvaluator.evaluate(samples: samples, policy: policy, now: outside, calendar: calendar).canWake)
    }

    func testOvernightWindowContainsLateNight() {
        let window = WakeWindow(startHour: 23, startMinute: 0, endHour: 1, endMinute: 0)
        XCTAssertTrue(window.contains(Date(timeIntervalSince1970: 30 * 60), calendar: calendar))
    }

    func testLatestAwakeStageBlocksWake() {
        let sleeping = sample(hoursAgo: 6, duration: 6 * 3600, stage: .rem)
        let awake = SleepSample(start: now.addingTimeInterval(-60), end: now, stage: .awake, source: "test")
        XCTAssertFalse(SleepEvaluator.evaluate(samples: [sleeping, awake], policy: policy, now: now, calendar: calendar).canWake)
    }

    func testOverlappingSamplesAreNotDoubleCounted() {
        let first = SleepSample(start: now.addingTimeInterval(-6 * 3600), end: now.addingTimeInterval(-3 * 3600), stage: .core, source: "test")
        let overlap = SleepSample(start: now.addingTimeInterval(-5 * 3600), end: now, stage: .rem, source: "test")
        let result = SleepEvaluator.evaluate(samples: [first, overlap], policy: policy, now: now, calendar: calendar)
        XCTAssertEqual(result.totalSleep, 6 * 3600)
        XCTAssertEqual(result.deepREM, 5 * 3600)
    }

    func testPreviousNightIsNotCounted() {
        let oldNight = SleepSample(start: now.addingTimeInterval(-30 * 3600), end: now.addingTimeInterval(-25 * 3600), stage: .deep, source: "test")
        let recent = SleepSample(start: now.addingTimeInterval(-3 * 3600), end: now, stage: .rem, source: "test")
        let result = SleepEvaluator.evaluate(samples: [oldNight, recent], policy: policy, now: now, calendar: calendar)
        XCTAssertEqual(result.totalSleep, 3 * 3600)
        XCTAssertFalse(result.canWake)
    }

    func testMinimumSleepFailureReason() {
        let short = SleepSample(start: now.addingTimeInterval(-4 * 3600), end: now, stage: .rem, source: "test")
        let result = SleepEvaluator.evaluate(samples: [short], policy: policy, now: now, calendar: calendar)
        XCTAssertFalse(result.canWake)
        XCTAssertEqual(result.reason, "总睡眠未达最短时长")
    }

    func testDeepREMFailureReason() {
        let core = SleepSample(start: now.addingTimeInterval(-6.5 * 3600), end: now.addingTimeInterval(-0.5 * 3600), stage: .core, source: "test")
        let rem = SleepSample(start: now.addingTimeInterval(-0.5 * 3600), end: now, stage: .rem, source: "test")
        let result = SleepEvaluator.evaluate(samples: [core, rem], policy: policy, now: now, calendar: calendar)
        XCTAssertFalse(result.canWake)
        XCTAssertEqual(result.reason, "Deep + REM 累积不足")
    }

    func testPredictedWakeUsesCycleBoundaryInsideWindow() {
        let bedtime = calendar.date(from: DateComponents(year: 2026, month: 8, day: 25, hour: 23))!
        let target = WakePlanner.predictedWake(
            bedtime: bedtime,
            wakeWindow: WakeWindow(startHour: 6, startMinute: 30, endHour: 7, endMinute: 0),
            sleepLatencyMinutes: 15,
            cycleMinutes: 90,
            calendar: calendar
        )
        XCTAssertEqual(calendar.component(.hour, from: target), 6)
        XCTAssertEqual(calendar.component(.minute, from: target), 45)
    }

    func testPredictedWakeFallsBackToWindowEnd() {
        let bedtime = calendar.date(from: DateComponents(year: 2026, month: 8, day: 25, hour: 23))!
        let target = WakePlanner.predictedWake(
            bedtime: bedtime,
            wakeWindow: WakeWindow(startHour: 6, startMinute: 30, endHour: 6, endMinute: 40),
            sleepLatencyMinutes: 15,
            cycleMinutes: 90,
            calendar: calendar
        )
        XCTAssertEqual(calendar.component(.hour, from: target), 6)
        XCTAssertEqual(calendar.component(.minute, from: target), 40)
    }

    func testPredictedWakeUsesLatestCycleBoundaryInsideWideWindow() {
        let bedtime = calendar.date(from: DateComponents(year: 2026, month: 8, day: 25, hour: 22))!
        let target = WakePlanner.predictedWake(
            bedtime: bedtime,
            wakeWindow: WakeWindow(startHour: 3, startMinute: 45, endHour: 7, endMinute: 15),
            sleepLatencyMinutes: 0,
            cycleMinutes: 90,
            calendar: calendar
        )
        XCTAssertEqual(calendar.component(.hour, from: target), 7)
        XCTAssertEqual(calendar.component(.minute, from: target), 0)
    }

    func testEconomyWeightsAndScalesWholeNightToEightHours() {
        let samples = [
            economySample(startHoursAgo: 10, endHoursAgo: 4, stage: .core),
            economySample(startHoursAgo: 4, endHoursAgo: 2, stage: .rem),
            economySample(startHoursAgo: 2, endHoursAgo: 0, stage: .deep)
        ]
        let result = SleepEconomyEngine.assess(samples: samples)
        XCTAssertEqual(result.stageMinutes, SleepStageMinutes(core: 288, rem: 96, deep: 96))
        XCTAssertEqual(result.stageMinutes.counted, 480)
        XCTAssertEqual(result.quality.stagePoints, 730)
        XCTAssertEqual(result.rawPoints, 730)
        XCTAssertEqual(result.awardedPoints, 730)
        XCTAssertEqual(result.estimatedPoints, 511)
        XCTAssertEqual(result.trustGrade, .healthKitSource)
    }

    func testEconomyUsesOneTwoThreeStageWeights() {
        let samples = [
            economySample(startHoursAgo: 7, endHoursAgo: 3, stage: .core),
            economySample(startHoursAgo: 3, endHoursAgo: 1, stage: .rem),
            economySample(startHoursAgo: 1, endHoursAgo: 0, stage: .deep)
        ]
        let result = SleepEconomyEngine.assess(samples: samples)
        XCTAssertEqual(result.rawPoints, 609)
        XCTAssertEqual(result.awardedPoints, 609)
        XCTAssertEqual(result.estimatedPoints, 426)
    }

    func testFourDimensionScreenshotExampleIsDeterministic() {
        let source = SleepStageMinutes(core: 250, rem: 50, deep: 105, awake: 31)
        let first = SleepEconomyEngine.score(
            stageMinutes: source,
            trustGrade: .vendorSigned,
            qualityContext: .september4Example
        )
        let second = SleepEconomyEngine.score(
            stageMinutes: source,
            trustGrade: .vendorSigned,
            qualityContext: .september4Example
        )
        XCTAssertEqual(first, second)
        XCTAssertEqual(first.availableMinutes, 405)
        XCTAssertEqual(first.quality.deepRatioBasisPoints, 2_593)
        XCTAssertEqual(first.quality.effectiveDeepWeightBasisPoints, 29_260)
        XCTAssertEqual(first.quality.stagePoints, 657)
        XCTAssertEqual(first.quality.continuityFactorBasisPoints, 8_490)
        XCTAssertEqual(first.quality.regularityFactorBasisPoints, 7_000)
        XCTAssertEqual(first.rawPoints, 657)
        XCTAssertEqual(first.awardedPoints, 390)
        XCTAssertEqual(first.estimatedPoints, 390)
    }

    func testDeepTargetAndQualityPenaltiesAreMonotonic() {
        let low = SleepEconomyEngine.score(stageMinutes: SleepStageMinutes(core: 420, deep: 60), trustGrade: .vendorSigned)
        let target = SleepEconomyEngine.score(stageMinutes: SleepStageMinutes(core: 360, deep: 120), trustGrade: .vendorSigned)
        let high = SleepEconomyEngine.score(stageMinutes: SleepStageMinutes(core: 300, deep: 180), trustGrade: .vendorSigned)
        XCTAssertGreaterThan(target.rawPoints, low.rawPoints)
        XCTAssertGreaterThan(target.rawPoints, high.rawPoints)

        let interrupted = SleepEconomyEngine.score(
            stageMinutes: SleepStageMinutes(core: 360, deep: 120),
            trustGrade: .vendorSigned,
            qualityContext: SleepQualityContext(awakeMinutes: 20, interruptionCount: 3, scheduleDeviationMinutes: nil, regularityBasis: "test")
        )
        let irregular = SleepEconomyEngine.score(
            stageMinutes: SleepStageMinutes(core: 360, deep: 120),
            trustGrade: .vendorSigned,
            qualityContext: SleepQualityContext(awakeMinutes: 20, interruptionCount: 3, scheduleDeviationMinutes: 120, regularityBasis: "test")
        )
        XCTAssertLessThan(interrupted.awardedPoints, target.awardedPoints)
        XCTAssertLessThan(irregular.awardedPoints, interrupted.awardedPoints)
    }

    func testEconomyDoesNotSettleMockData() {
        let mock = SleepSample(
            start: now.addingTimeInterval(-7 * 3600),
            end: now,
            stage: .deep,
            source: "模拟数据"
        )
        let result = SleepEconomyEngine.assess(samples: [mock])
        XCTAssertEqual(result.rawPoints, 420)
        XCTAssertEqual(result.awardedPoints, 420)
        XCTAssertEqual(result.estimatedPoints, 0)
        XCTAssertEqual(result.trustGrade, .unverified)
    }

    func testEconomyExcludesConflictingStageIntervals() {
        let core = economySample(startHoursAgo: 2, endHoursAgo: 0, stage: .core)
        let rem = economySample(startHoursAgo: 1, endHoursAgo: 0, stage: .rem)
        let result = SleepEconomyEngine.assess(samples: [core, rem])
        XCTAssertEqual(result.stageMinutes.core, 60)
        XCTAssertEqual(result.stageMinutes.conflicting, 60)
        XCTAssertEqual(result.stageMinutes.counted, 60)
    }

    func testSleepClaimCommitmentIsDeterministicAndSalted() throws {
        let id = UUID(uuidString: "00000000-0000-0000-0000-000000000001")!
        let sample = SleepSample(
            id: id,
            start: now.addingTimeInterval(-7 * 3600),
            end: now,
            stage: .rem,
            source: "RingConn (example)"
        )
        let salt = Data(repeating: 7, count: 32)
        let first = try SleepClaimBuilder.makeReceipt(
            samples: [sample],
            accountPseudonym: "local-account",
            calendar: calendar,
            createdAt: now,
            salt: salt
        )
        let second = try SleepClaimBuilder.makeReceipt(
            samples: [sample],
            accountPseudonym: "local-account",
            calendar: calendar,
            createdAt: now,
            salt: salt
        )
        let differentSalt = try SleepClaimBuilder.makeReceipt(
            samples: [sample],
            accountPseudonym: "local-account",
            calendar: calendar,
            createdAt: now,
            salt: Data(repeating: 8, count: 32)
        )
        XCTAssertEqual(first.commitment, second.commitment)
        XCTAssertEqual(first.localNullifier, second.localNullifier)
        XCTAssertNotEqual(first.commitment, differentSalt.commitment)
    }

    func testLegacyLedgerWithoutAwakeOrAwardedPointsStillDecodes() throws {
        let json = #"{"receipts":[{"id":"00000000-0000-0000-0000-000000000001","createdAt":0,"nightKey":"2026-09-01","commitment":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","localNullifier":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","salt":"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc","scoringVersion":1,"trustGrade":"healthKitSource","stageMinutes":{"asleep":0,"core":300,"rem":60,"deep":60,"conflicting":0},"rawPoints":600,"estimatedPoints":420,"sampleCount":3}]}"#
        let ledger = try JSONDecoder().decode(SleepClaimLedger.self, from: Data(json.utf8))
        XCTAssertEqual(ledger.receipts.count, 1)
        XCTAssertEqual(ledger.receipts[0].stageMinutes.awake, 0)
        XCTAssertNil(ledger.receipts[0].awardedPoints)
        XCTAssertEqual(ledger.receipts[0].estimatedPoints, 420)
    }

    func testLedgerRejectsASecondClaimForTheSameBiologicalNight() throws {
        let sample = economySample(startHoursAgo: 7, endHoursAgo: 0, stage: .rem)
        let first = try SleepClaimBuilder.makeReceipt(
            samples: [sample], accountPseudonym: "local-account", calendar: calendar,
            createdAt: now, salt: Data(repeating: 1, count: 32)
        )
        let second = try SleepClaimBuilder.makeReceipt(
            samples: [sample], accountPseudonym: "local-account", calendar: calendar,
            createdAt: now, salt: Data(repeating: 2, count: 32)
        )
        var ledger = SleepClaimLedger()
        try ledger.append(first)
        XCTAssertThrowsError(try ledger.append(second)) { error in
            XCTAssertEqual(error as? SleepClaimError, .duplicateNight)
        }
    }

    func testMerkleProofVerifiesAndDetectsTampering() throws {
        let commitments = [String(repeating: "11", count: 32), String(repeating: "22", count: 32), String(repeating: "33", count: 32)]
        let proof = try XCTUnwrap(SleepMerkleTree.proof(for: commitments[1], in: commitments))
        XCTAssertTrue(SleepMerkleTree.verify(proof))
        let tampered = SleepMerkleProof(commitment: String(repeating: "44", count: 32), root: proof.root, nodes: proof.nodes)
        XCTAssertFalse(SleepMerkleTree.verify(tampered))
    }

    private func sample(hoursAgo: Double, duration: TimeInterval, stage: SleepStage) -> SleepSample {
        let end = now.addingTimeInterval(-hoursAgo * 3600)
        return SleepSample(start: end.addingTimeInterval(-duration), end: end, stage: stage, source: "test")
    }

    private func economySample(startHoursAgo: Double, endHoursAgo: Double, stage: SleepStage) -> SleepSample {
        SleepSample(
            start: now.addingTimeInterval(-startHoursAgo * 3600),
            end: now.addingTimeInterval(-endHoursAgo * 3600),
            stage: stage,
            source: "RingConn (example)"
        )
    }
}
