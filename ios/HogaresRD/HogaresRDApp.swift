import SwiftUI
import UserNotifications

// MARK: - AppDelegate (Push Notifications)

class AppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    func application(_ application: UIApplication,
                     didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        UNUserNotificationCenter.current().delegate = self
        return true
    }

    func application(_ application: UIApplication,
                     didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        PushNotificationService.shared.handleDeviceToken(deviceToken)
    }

    func application(_ application: UIApplication,
                     didFailToRegisterForRemoteNotificationsWithError error: Error) {
        PushNotificationService.shared.handleRegistrationError(error)
    }

    // Show notifications even when the app is in the foreground
    func userNotificationCenter(_ center: UNUserNotificationCenter,
                                willPresent notification: UNNotification) async
        -> UNNotificationPresentationOptions {
        // Fire a lightweight "received" signal so ContentView can refresh
        // its unread-message badge immediately instead of waiting for the
        // next 30s poll — the user sees the red dot appear the instant
        // the push banner drops down.
        let userInfo = notification.request.content.userInfo
        await MainActor.run {
            NotificationCenter.default.post(
                name: .pushNotificationReceived,
                object: nil,
                userInfo: userInfo
            )
        }
        return [.banner, .badge, .sound]
    }

    // Handle notification tap
    func userNotificationCenter(_ center: UNUserNotificationCenter,
                                didReceive response: UNNotificationResponse) async {
        let userInfo = response.notification.request.content.userInfo
        await MainActor.run {
            NotificationCenter.default.post(
                name: .pushNotificationTapped,
                object: nil,
                userInfo: userInfo
            )
        }
    }
}

// MARK: - App Entry Point

@main
struct HogaresRDApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) var appDelegate

    @StateObject private var api         = APIService.shared
    @StateObject private var saved       = SavedStore.shared
    @StateObject private var pushService = PushNotificationService.shared
    @StateObject private var lockManager = AppLockManager.shared
    @AppStorage("appColorScheme") private var schemePref: String = "system"
    @Environment(\.scenePhase) private var scenePhase

    private var preferredScheme: ColorScheme? {
        switch schemePref {
        case "dark":  return .dark
        case "light": return .light
        default:      return nil
        }
    }

    @State private var showSplash = true

    var body: some Scene {
        WindowGroup {
            ZStack {
                ContentView()
                    .environmentObject(api)
                    .environmentObject(saved)
                    .environmentObject(pushService)
                    .environmentObject(lockManager)
                    .preferredColorScheme(preferredScheme)

                // Lock screen overlay
                if lockManager.isLocked, api.currentUser != nil {
                    LockScreenView()
                        .environmentObject(api)
                        .environmentObject(lockManager)
                        .transition(.opacity)
                        .zIndex(999)
                }

                // Splash screen — shown on launch
                if showSplash {
                    SplashView()
                        .transition(.opacity)
                        .zIndex(1000)
                }
            }
            .animation(.easeInOut(duration: 0.4), value: showSplash)
            .animation(.easeInOut(duration: 0.25), value: lockManager.isLocked)
            .onChange(of: scenePhase) { _, newPhase in
                lockManager.handleScenePhase(newPhase, isLoggedIn: api.currentUser != nil)
                // Clear notification badge when app becomes active
                if newPhase == .active {
                    UNUserNotificationCenter.current().setBadgeCount(0)
                }
            }
            .task {
                try? await Task.sleep(for: .seconds(0.8))
                showSplash = false
                // Deferred init — push service checks system permissions
                // AFTER splash, not during app init (avoids main-thread stall).
                pushService.deferredInit()
            }
        }
    }
}
