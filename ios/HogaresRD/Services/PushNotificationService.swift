import Foundation
import UserNotifications
import UIKit

class PushNotificationService: NSObject, ObservableObject {
    static let shared = PushNotificationService()

    @Published var isAuthorized = false
    @Published var authStatus: UNAuthorizationStatus = .notDetermined
    @Published var deviceToken: String?

    override init() {
        super.init()
        // Don't call checkAuthorizationStatus() here — it hits an async
        // system API that stalls the main thread before the splash renders.
        // HogaresRDApp calls deferredInit() after splash instead.
    }

    /// Call AFTER splash screen to avoid blocking launch.
    func deferredInit() {
        checkAuthorizationStatus()
        // Always re-register to ensure the server has the latest token
        UNUserNotificationCenter.current().getNotificationSettings { settings in
            if settings.authorizationStatus == .authorized {
                DispatchQueue.main.async {
                    UIApplication.shared.registerForRemoteNotifications()
                }
            }
        }
    }

    func checkAuthorizationStatus() {
        UNUserNotificationCenter.current().getNotificationSettings { settings in
            DispatchQueue.main.async {
                self.authStatus = settings.authorizationStatus
                self.isAuthorized = settings.authorizationStatus == .authorized
            }
        }
    }

    /// Async version — returns current authorization so callers can await
    /// the result rather than racing against the published property.
    @discardableResult
    func refreshAuthorizationStatus() async -> UNAuthorizationStatus {
        let settings = await UNUserNotificationCenter.current().notificationSettings()
        await MainActor.run {
            self.authStatus = settings.authorizationStatus
            self.isAuthorized = settings.authorizationStatus == .authorized
        }
        return settings.authorizationStatus
    }

    func requestPermission() async -> Bool {
        do {
            let granted = try await UNUserNotificationCenter.current()
                .requestAuthorization(options: [.alert, .badge, .sound])
            await MainActor.run {
                self.isAuthorized = granted
                self.authStatus = granted ? .authorized : .denied
                if granted {
                    UIApplication.shared.registerForRemoteNotifications()
                }
            }
            return granted
        } catch {
            debugLog("Push permission error: \(error)")
            return false
        }
    }

    func handleDeviceToken(_ tokenData: Data) {
        let token = tokenData.map { String(format: "%02.2hhx", $0) }.joined()
            debugLog("[Push] Device token received: \(token.prefix(16))...")
        // Match the rest of the file's MainActor.run / Task @MainActor style
        // — this @Published is otherwise mutated inconsistently across
        // dispatch primitives.
        Task { @MainActor in
            self.deviceToken = token
        }
        Task {
            await registerTokenWithServer(token)
        }
    }

    func handleRegistrationError(_ error: Error) {
            debugLog("APNs registration error: \(error)")
    }

    private func registerTokenWithServer(_ token: String) async {
        do {
            try await APIService.shared.registerPushToken(token: token)
            debugLog("Push token registered with server")
        } catch {
            debugLog("Failed to register push token: \(error)")
        }
    }

    /// Enable all in-app notification category preferences. Called after
    /// the user grants permission via the soft-ask primer so every channel
    /// is on by default (they can still disable individual ones from the
    /// Notifications settings screen).
    @MainActor
    func enableAllPreferences() {
        let defaults = UserDefaults.standard
        defaults.set(true, forKey: "push_user_enabled")
        defaults.set(true, forKey: "notif_newListings")
        defaults.set(true, forKey: "notif_priceDrops")
        defaults.set(true, forKey: "notif_similar")
        defaults.set(true, forKey: "notif_agentMessages")
        defaults.set(true, forKey: "notif_appUpdates")
    }
}

extension Notification.Name {
    static let pushNotificationTapped = Notification.Name("pushNotificationTapped")
    /// Fired by willPresent when a push arrives while the app is in the
    /// foreground. Used by ContentView to refresh the unread-message
    /// badge without waiting for the next 30s poll.
    static let pushNotificationReceived = Notification.Name("pushNotificationReceived")
    /// Fired when a Universal Link opens the app with a listing ID.
    /// ContentView navigates to the listing detail.
    static let deepLinkListing = Notification.Name("rd.deepLinkListing")
}
