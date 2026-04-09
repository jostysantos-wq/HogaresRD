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
            print("Push permission error: \(error)")
            return false
        }
    }

    func handleDeviceToken(_ tokenData: Data) {
        let token = tokenData.map { String(format: "%02.2hhx", $0) }.joined()
        print("[Push] Device token received: \(token.prefix(16))...")
        DispatchQueue.main.async {
            self.deviceToken = token
        }
        Task {
            await registerTokenWithServer(token)
        }
    }

    func handleRegistrationError(_ error: Error) {
        print("APNs registration error: \(error)")
    }

    private func registerTokenWithServer(_ token: String) async {
        do {
            try await APIService.shared.registerPushToken(token: token)
            print("Push token registered with server")
        } catch {
            print("Failed to register push token: \(error)")
        }
    }
}

extension Notification.Name {
    static let pushNotificationTapped = Notification.Name("pushNotificationTapped")
}
