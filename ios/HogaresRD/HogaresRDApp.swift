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

    @StateObject private var api   = APIService.shared
    @StateObject private var saved = SavedStore.shared
    @StateObject private var pushService = PushNotificationService.shared
    @AppStorage("appColorScheme") private var schemePref: String = "system"

    private var preferredScheme: ColorScheme? {
        switch schemePref {
        case "dark":  return .dark
        case "light": return .light
        default:      return nil
        }
    }

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environmentObject(api)
                .environmentObject(saved)
                .environmentObject(pushService)
                .preferredColorScheme(preferredScheme)
        }
    }
}
