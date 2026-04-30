import SwiftUI
import UserNotifications
import AuthenticationServices

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
    @State private var verifyBanner: String?
    @State private var verifyBannerIsError: Bool = false

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

                // Verify-email transient banner — auto-dismisses after 3s
                if let msg = verifyBanner {
                    VStack {
                        HStack(spacing: 10) {
                            Image(systemName: verifyBannerIsError
                                  ? "exclamationmark.circle.fill"
                                  : "checkmark.circle.fill")
                            Text(msg).font(.system(size: 14, weight: .semibold))
                            Spacer(minLength: 0)
                        }
                        .padding(.horizontal, 16)
                        .padding(.vertical, 12)
                        .foregroundStyle(.white)
                        .background(verifyBannerIsError ? Color.red : Color.green,
                                    in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                        .padding(.horizontal, 16)
                        .padding(.top, 8)
                        Spacer()
                    }
                    .transition(.move(edge: .top).combined(with: .opacity))
                    .zIndex(1001)
                }
            }
            .animation(.easeInOut(duration: 0.4), value: showSplash)
            .animation(.easeInOut(duration: 0.25), value: lockManager.isLocked)
            .animation(.easeInOut(duration: 0.25), value: verifyBanner)
            .onAppear {
                checkAppleCredentialState()
            }
            .onChange(of: scenePhase) { _, newPhase in
                lockManager.handleScenePhase(newPhase, isLoggedIn: api.currentUser != nil)
                // Clear notification badge when app becomes active
                if newPhase == .active {
                    Task {
                        try? await UNUserNotificationCenter.current().setBadgeCount(0)
                        await APIService.shared.resetPushBadge()
                    }
                }
            }
            .onOpenURL { url in handleDeepLink(url) }
            .task {
                // Clear stale badge on cold launch — .onChange doesn't
                // fire for the initial .active transition on some devices.
                try? await UNUserNotificationCenter.current().setBadgeCount(0)
                await APIService.shared.resetPushBadge()

                try? await Task.sleep(for: .seconds(0.8))
                showSplash = false
                // Deferred init — push service checks system permissions
                // AFTER splash, not during app init (avoids main-thread stall).
                pushService.deferredInit()
            }
        }
    }

    /// Bug #3: if a saved Apple userID exists, check whether the credential
    /// is still valid. If revoked / not-found we force a logout so the app
    /// doesn't keep using a dead token.
    private func checkAppleCredentialState() {
        guard let savedUserID = UserDefaults.standard.string(forKey: "apple_user_id"),
              !savedUserID.isEmpty else { return }
        ASAuthorizationAppleIDProvider().getCredentialState(forUserID: savedUserID) { state, _ in
            if state == .revoked || state == .notFound {
                Task { @MainActor in
                    APIService.shared.logout()
                }
            }
        }
    }

    /// Show a transient banner for 3 seconds.
    private func showVerifyBanner(_ message: String, isError: Bool) {
        verifyBannerIsError = isError
        verifyBanner = message
        Task {
            try? await Task.sleep(for: .seconds(3))
            await MainActor.run { verifyBanner = nil }
        }
    }

    // MARK: - Universal Link Handler

    /// Parses incoming URLs from Universal Links and affiliate share links.
    /// Supported patterns:
    ///   /verify-email?token={token}
    ///   /listing/{id}?ref={token}
    ///   /r/{token}/{listingId}
    ///   /r/{token}
    private func handleDeepLink(_ url: URL) {
        // Only honor Universal Links from our verified domains. If a custom
        // URL scheme is added later, an attacker could craft a URL with a
        // `/verify-email?token=…` path and trigger a server call — reject
        // anything that isn't an https://hogaresrd.com link.
        guard url.scheme == "https",
              url.host == "hogaresrd.com" || url.host == "www.hogaresrd.com"
        else { return }

        let path = url.path
        let comps = URLComponents(url: url, resolvingAgainstBaseURL: false)
        let refToken = comps?.queryItems?.first(where: { $0.name == "ref" })?.value

        // Store affiliate ref token for lead attribution
        if let ref = refToken, !ref.isEmpty {
            APIService.shared.pendingRefToken = ref
        }

        let segments = path.split(separator: "/").map(String.init)

        // /verify-email?token=... — email verification deep link
        if segments.first == "verify-email" {
            if let token = comps?.queryItems?.first(where: { $0.name == "token" })?.value,
               !token.isEmpty {
                Task {
                    let ok = await APIService.shared.verifyEmail(token: token)
                    await MainActor.run {
                        if ok {
                            showVerifyBanner("Tu correo fue verificado.", isError: false)
                        } else {
                            showVerifyBanner("No se pudo verificar tu correo. El enlace puede haber expirado.", isError: true)
                        }
                    }
                }
            }
        } else if segments.first == "listing", let listingId = segments.dropFirst().first {
            // /listing/{id} — open listing detail
            NotificationCenter.default.post(
                name: .deepLinkListing,
                object: nil,
                userInfo: ["listingId": listingId]
            )
        } else if segments.first == "r", segments.count >= 1 {
            // /r/{token} or /r/{token}/{listingId}
            let token = segments.count >= 2 ? segments[1] : nil
            if let t = token, !t.isEmpty { APIService.shared.pendingRefToken = t }

            if segments.count >= 3 {
                // /r/{token}/{listingId}
                let listingId = segments[2]
                NotificationCenter.default.post(
                    name: .deepLinkListing,
                    object: nil,
                    userInfo: ["listingId": listingId]
                )
            }
            // /r/{token} alone — just stores the ref, app opens to default screen
        }
    }
}
