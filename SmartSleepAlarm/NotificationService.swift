import Foundation
import UserNotifications
#if canImport(AlarmKit) && os(iOS)
import AlarmKit
import SwiftUI
#endif

enum WakeAlarmChannel: String {
    case alarmKit = "AlarmKit 系统闹钟"
    case notification = "普通本地通知"
}

#if canImport(AlarmKit) && os(iOS)
@available(iOS 26.0, *)
private struct WakeAlarmMetadata: AlarmMetadata {}
#endif

enum NotificationService {
    private static let wakeupID = "smart-sleep-wakeup"
    private static let testID = "smart-sleep-test"
    private static let alarmKitWakeupIDKey = "alarmkit-wakeup-id"

    static func requestAuthorization() async throws -> Bool {
        try await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound])
    }

    static func scheduleWakeup(at date: Date, title: String, message: String) async throws -> WakeAlarmChannel {
#if canImport(AlarmKit) && os(iOS)
        if #available(iOS 26.0, *), try await scheduleAlarmKitWakeup(at: date) {
            UNUserNotificationCenter.current().removePendingNotificationRequests(withIdentifiers: [wakeupID])
            return .alarmKit
        }
#endif
        guard try await requestAuthorization() else {
            throw CocoaError(.userCancelled)
        }
        let center = UNUserNotificationCenter.current()
        center.removePendingNotificationRequests(withIdentifiers: [wakeupID])
        let content = UNMutableNotificationContent()
        content.title = title
        content.body = message
        content.sound = .default
        let trigger = UNCalendarNotificationTrigger(dateMatching: Calendar.current.dateComponents([.year, .month, .day, .hour, .minute], from: date), repeats: false)
        try await center.add(UNNotificationRequest(identifier: wakeupID, content: content, trigger: trigger))
        return .notification
    }

#if canImport(AlarmKit) && os(iOS)
    @available(iOS 26.0, *)
    private static func scheduleAlarmKitWakeup(at date: Date) async throws -> Bool {
        let manager = AlarmManager.shared
        let authorization: AlarmManager.AuthorizationState
        switch manager.authorizationState {
        case .notDetermined:
            authorization = try await manager.requestAuthorization()
        case let state:
            authorization = state
        }
        guard case .authorized = authorization else { return false }

        let defaults = UserDefaults.standard
        let id = defaults.string(forKey: alarmKitWakeupIDKey).flatMap(UUID.init(uuidString:)) ?? UUID()
        try? manager.cancel(id: id)

        let alert: AlarmPresentation.Alert
        if #available(iOS 26.1, *) {
            alert = AlarmPresentation.Alert(title: "智能睡眠闹钟")
        } else {
            let stopButton = AlarmButton(text: "停止", textColor: .white, systemImageName: "stop.circle")
            alert = AlarmPresentation.Alert(title: "智能睡眠闹钟", stopButton: stopButton)
        }
        let attributes = AlarmAttributes<WakeAlarmMetadata>(
            presentation: AlarmPresentation(alert: alert),
            tintColor: .indigo
        )
        let configuration = AlarmManager.AlarmConfiguration<WakeAlarmMetadata>.alarm(
            schedule: .fixed(date),
            attributes: attributes
        )
        _ = try await manager.schedule(id: id, configuration: configuration)
        defaults.set(id.uuidString, forKey: alarmKitWakeupIDKey)
        return true
    }
#endif

    static func scheduleTest() async throws {
        let center = UNUserNotificationCenter.current()
        center.removeDeliveredNotifications(withIdentifiers: [testID])
        center.removePendingNotificationRequests(withIdentifiers: [testID])
        let content = UNMutableNotificationContent()
        content.title = "通知测试成功"
        content.body = "这只验证本地通知，不验证 HealthKit 后台或 RingConn 同步。"
        content.sound = .default
        let trigger = UNTimeIntervalNotificationTrigger(timeInterval: 5, repeats: false)
        try await center.add(UNNotificationRequest(identifier: testID, content: content, trigger: trigger))
    }

    static func testWasDelivered() async -> Bool {
        await withCheckedContinuation { continuation in
            UNUserNotificationCenter.current().getDeliveredNotifications { notifications in
                continuation.resume(returning: notifications.contains { $0.request.identifier == testID })
            }
        }
    }
}
