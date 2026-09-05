import SwiftUI
import UserNotifications
#if os(iOS)
import UIKit

final class AppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        UNUserNotificationCenter.current().delegate = self
        return true
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification) async -> UNNotificationPresentationOptions {
        [.banner, .sound]
    }
}
#elseif os(macOS)
import AppKit

final class AppDelegate: NSObject, NSApplicationDelegate, UNUserNotificationCenterDelegate {
    func applicationDidFinishLaunching(_ notification: Notification) {
        UNUserNotificationCenter.current().delegate = self
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification) async -> UNNotificationPresentationOptions {
        [.banner, .sound]
    }
}
#endif

@main
struct SmartSleepAlarmApp: App {
#if os(iOS)
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
#elseif os(macOS)
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
#endif
    @StateObject private var model = SleepViewModel()

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environmentObject(model)
                .task { model.startBackgroundObservation() }
                .onOpenURL { url in
                    if url.scheme == "smartsleepalarm", url.host == "test-notification" {
                        model.scheduleFiveSecondTest()
                    }
                }
        }
#if os(macOS)
        .commands {
            CommandMenu("验证") {
                Button("运行五场景自检") { model.runScenarioSelfCheck() }
                    .keyboardShortcut("r", modifiers: [.command, .shift])
                Divider()
                Button("满足所有条件") { model.useMockScenario(.wakeReady) }
                    .keyboardShortcut("1", modifiers: [.command])
                Button("睡眠时长不足") { model.useMockScenario(.tooShort) }
                    .keyboardShortcut("2", modifiers: [.command])
                Button("Deep + REM 不足") { model.useMockScenario(.insufficientDeepREM) }
                    .keyboardShortcut("3", modifiers: [.command])
                Button("最近阶段为 Awake") { model.useMockScenario(.latestAwake) }
                    .keyboardShortcut("4", modifiers: [.command])
                Button("不在唤醒窗口") { model.useMockScenario(.outsideWindow) }
                    .keyboardShortcut("5", modifiers: [.command])
            }
        }
#endif
    }
}
