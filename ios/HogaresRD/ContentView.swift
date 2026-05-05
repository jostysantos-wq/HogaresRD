import SwiftUI

// MARK: - Brand Colors
//
// Brand tokens adapt to light + dark mode via UITraitCollection. Avoid
// hard-coded `Color(red:…)` literals in views — they ignore Dark Mode and
// produce invisible text on dark backgrounds. If you need a new tonal
// step, add it here so it updates everywhere at once.
extension Color {
    static let rdBlue  = Color(uiColor: UIColor { traits in
        traits.userInterfaceStyle == .dark
            ? UIColor(red: 0.36, green: 0.56, blue: 0.96, alpha: 1)
            : UIColor(red: 0.0,  green: 0.22, blue: 0.66, alpha: 1)
    })
    static let rdRed   = Color(uiColor: UIColor { traits in
        traits.userInterfaceStyle == .dark
            ? UIColor(red: 0.97, green: 0.36, blue: 0.40, alpha: 1)
            : UIColor(red: 0.81, green: 0.08, blue: 0.17, alpha: 1)
    })
    static let rdGreen = Color(uiColor: UIColor { traits in
        traits.userInterfaceStyle == .dark
            ? UIColor(red: 0.36, green: 0.78, blue: 0.55, alpha: 1)
            : UIColor(red: 0.11, green: 0.48, blue: 0.24, alpha: 1)
    })
    static let rdBg    = Color(uiColor: UIColor { traits in
        traits.userInterfaceStyle == .dark
            ? UIColor(red: 0.07, green: 0.10, blue: 0.16, alpha: 1)
            : UIColor(red: 0.95, green: 0.96, blue: 1.00, alpha: 1)
    })

    // ── Status palette tokens (adaptive) ──
    // Used by application/status pills throughout the app. Shipping
    // dark-mode variants here keeps the badges legible on dark
    // backgrounds. Names mirror the semantic meaning, not the hue.
    static let rdOrange = Color(uiColor: UIColor { traits in
        traits.userInterfaceStyle == .dark
            ? UIColor(red: 0.99, green: 0.62, blue: 0.18, alpha: 1)
            : UIColor(red: 0.85, green: 0.47, blue: 0.02, alpha: 1)
    })
    static let rdPurple = Color(uiColor: UIColor { traits in
        traits.userInterfaceStyle == .dark
            ? UIColor(red: 0.74, green: 0.46, blue: 0.95, alpha: 1)
            : UIColor(red: 0.55, green: 0.24, blue: 0.78, alpha: 1)
    })
    static let rdTeal = Color(uiColor: UIColor { traits in
        traits.userInterfaceStyle == .dark
            ? UIColor(red: 0.36, green: 0.80, blue: 0.80, alpha: 1)
            : UIColor(red: 0.18, green: 0.60, blue: 0.60, alpha: 1)
    })

    // ── Editorial palette (Profile redesign) ──
    // Imported from the iOS profile design (ios-profile.jsx). Same warm
    // cream + terracotta accents as the web's editorial home/dashboard.
    // All four read against light backgrounds; on dark mode they tilt
    // toward the same hue with higher luminance so the cream doesn't
    // wash out the foreground.
    static let rdCream = Color(uiColor: UIColor { traits in
        traits.userInterfaceStyle == .dark
            ? UIColor(red: 0.07, green: 0.07, blue: 0.09, alpha: 1)   // deep ink
            : UIColor(red: 0.984, green: 0.965, blue: 0.933, alpha: 1) // #FBF6EE
    })
    static let rdCreamDeep = Color(uiColor: UIColor { traits in
        traits.userInterfaceStyle == .dark
            ? UIColor(red: 0.10, green: 0.10, blue: 0.12, alpha: 1)
            : UIColor(red: 0.957, green: 0.945, blue: 0.918, alpha: 1) // #F4F1EA
    })
    static let rdAccent = Color(uiColor: UIColor { traits in
        traits.userInterfaceStyle == .dark
            ? UIColor(red: 0.92, green: 0.45, blue: 0.32, alpha: 1)
            : UIColor(red: 0.710, green: 0.298, blue: 0.188, alpha: 1) // #B54C30 terracotta
    })
    static let rdGold = Color(uiColor: UIColor { traits in
        traits.userInterfaceStyle == .dark
            ? UIColor(red: 0.95, green: 0.78, blue: 0.40, alpha: 1)
            : UIColor(red: 0.831, green: 0.651, blue: 0.290, alpha: 1) // #D4A64A
    })
}

// MARK: - Lazy Tab Helper

/// Wrapper for deep link listing ID to satisfy Identifiable requirement
struct DeepLinkID: Identifiable {
    let id: String
}

/// Defers a tab's body evaluation until the view first appears.
/// Prevents SwiftUI's TabView from initializing all 4 tabs up front.
struct LazyView<Content: View>: View {
    let build: () -> Content
    init(_ build: @autoclosure @escaping () -> Content) { self.build = build }
    var body: some View { build() }
}

// MARK: - Root Tab View

struct ContentView: View {
    @EnvironmentObject var api:   APIService
    @EnvironmentObject var saved: SavedStore

    @State private var selectedTab = 0
    @State private var favAuthSheet: AuthView.Mode? = nil

    @Environment(\.scenePhase) private var scenePhase
    @EnvironmentObject var pushService: PushNotificationService
    @State private var resendingVerification = false
    @State private var verificationSent = false
    @State private var verificationError = false
    @State private var showPopup = false
    @State private var popupDismissed = false
    @State private var showPushPrimer = false
    @State private var popupAd: Ad?
    @State private var showAdPopup = false

    // Deep link state — set when a Universal Link opens the app to a listing
    @State private var deepLinkListingID: String?

    // Red unread-message badge on the Messages tab bar icon. Polled on
    // scenePhase .active, on login, and every 30s while the app is in
    // foreground. Also kicked by incoming new_message push payloads
    // (via the .pushNotificationTapped notification) so it updates even
    // faster when a message actually arrives.
    @State private var unreadMessages = 0
    // Actionable task count — tasks either assigned to me that I haven't
    // completed, or tasks submitted for my review. Drives the badge on
    // the dedicated Tareas tab.
    @State private var unreadTasks = 0
    @State private var unreadPollTask: Task<Void, Never>?

    var body: some View {
        // System TabView. iOS 26+ renders the new Liquid Glass material
        // automatically; on iOS 17–18 it falls back to the legacy
        // translucent material. Either way the bar owns its own safe-
        // area inset, so individual tab views no longer need manual
        // bottom padding to clear it.
        TabView(selection: $selectedTab) {
            FeedView()
                .tabItem { Label("Inicio", systemImage: "newspaper.fill") }
                .tag(0)

            LazyView(BrowseView())
                .tabItem { Label("Explorar", systemImage: "magnifyingglass") }
                .tag(1)

            LazyView(MessagesTabView())
                .tabItem { Label("Mensajes", systemImage: "bubble.left.and.bubble.right.fill") }
                .badge(unreadMessages)
                .tag(2)

            LazyView(TasksTabView())
                .tabItem { Label("Tareas", systemImage: "checklist") }
                .badge(unreadTasks)
                .tag(3)

            LazyView(ProfileTabView())
                .tabItem { Label("Perfil", systemImage: "person.fill") }
                .tag(4)
        }
        .tint(Color.rdBlue)
        .modifier(TabBarMinimizeOnScrollIfAvailable())
        .overlay {
            if showPopup, let user = api.currentUser {
                reminderPopup(user)
            } else if showPushPrimer {
                PushPermissionPrimer(isPresented: $showPushPrimer)
                    .environmentObject(pushService)
            } else if showAdPopup, let ad = popupAd {
                popupAdOverlay(ad)
            }
        }
        .onReceive(NotificationCenter.default.publisher(for: .authRequiredForFavorite)) { _ in
            favAuthSheet = .welcome
        }
        .onReceive(NotificationCenter.default.publisher(for: .pushSoftAskTriggered)) { _ in
            // Only show if not already showing the email verification popup
            if !showPopup {
                withAnimation(.easeInOut(duration: 0.25)) { showPushPrimer = true }
            }
        }
        .onReceive(NotificationCenter.default.publisher(for: .pushNotificationTapped)) { notif in
            handlePushTap(notif.userInfo)
        }
        .onReceive(NotificationCenter.default.publisher(for: .pushNotificationReceived)) { notif in
            // Foreground push arrived — refresh the unread badge right
            // away instead of waiting for the next 30s poll. We don't
            // navigate on a receive (only on tap).
            let type = (notif.userInfo?["type"] as? String) ?? ""
            if type == "new_message" {
                Task { await refreshUnreadCount() }
            }
        }
        .onReceive(NotificationCenter.default.publisher(for: .deepLinkListing)) { notif in
            if let id = notif.userInfo?["listingId"] as? String {
                deepLinkListingID = id
            }
        }
        .fullScreenCover(item: Binding(
            get: { deepLinkListingID.map { DeepLinkID(id: $0) } },
            set: { deepLinkListingID = $0?.id }
        )) { item in
            NavigationStack {
                ListingDetailView(id: item.id)
                    .toolbar {
                        ToolbarItem(placement: .cancellationAction) {
                            Button("Cerrar") { deepLinkListingID = nil }
                        }
                    }
            }
            .environmentObject(api)
            .environmentObject(saved)
        }
        .sheet(item: $favAuthSheet) { mode in
            AuthView(initialMode: mode)
                .environmentObject(api)
                .id(mode)
        }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active, api.currentUser != nil {
                Task {
                    await api.refreshUser()
                    // After refresh, if the server says the email is
                    // verified, make sure any stale popup goes away.
                    await MainActor.run {
                        if api.currentUser?.emailVerified == true && showPopup {
                            withAnimation(.easeInOut(duration: 0.25)) { showPopup = false }
                        }
                    }
                }
                // Immediate unread refresh + restart the poll timer
                Task { await refreshUnreadCount() }
                startUnreadPolling()
                // Check for popup ad on foreground
                Task { await checkPopupAd() }
            } else if phase == .background || phase == .inactive {
                stopUnreadPolling()
            }
        }
        .onChange(of: selectedTab) { _, newTab in
            // Opening the Messages or Tasks tab refreshes the badge
            // so it clears/updates promptly.
            if newTab == 2 || newTab == 3 {
                Task { await refreshUnreadCount() }
            }
        }
        .onChange(of: api.currentUser?.emailVerified) { _, newValue in
            // Server flipped the user to verified → hide popup immediately
            if newValue == true && showPopup {
                withAnimation(.easeInOut(duration: 0.25)) { showPopup = false }
            }
        }
        .onChange(of: api.currentUser?.id) { _, newId in
            // Show popup shortly after login if needed
            schedulePopupIfNeeded()
            // Start/stop the unread poll when the user logs in or out
            if newId == nil {
                stopUnreadPolling()
                unreadMessages = 0
                unreadTasks = 0
            } else {
                Task { await refreshUnreadCount() }
                startUnreadPolling()
            }
        }
        .onAppear {
            // Refresh first so the stored user isn't stale — then decide.
            Task {
                if api.currentUser != nil { await api.refreshUser() }
                await MainActor.run { schedulePopupIfNeeded() }
            }
            if api.currentUser != nil {
                Task { await refreshUnreadCount() }
                startUnreadPolling()
            }
            // Check popup ad on first launch (after a delay for other popups)
            Task {
                try? await Task.sleep(for: .seconds(3))
                await checkPopupAd()
            }
        }
        .onDisappear { stopUnreadPolling() }
    }

    // MARK: - Unread message badge polling

    private func refreshUnreadCount() async {
        guard api.currentUser != nil else {
            await MainActor.run {
                unreadMessages = 0
                unreadTasks = 0
            }
            return
        }
        // Fetch both counters in parallel so the two badges update in
        // lockstep and we don't double the latency on scene activation.
        async let msgs  = api.getConversationsUnreadCount()
        async let tasks = api.getTasksBadgeCount()
        let (m, t) = await (msgs, tasks)
        await MainActor.run {
            unreadMessages = m
            unreadTasks    = t
        }
    }

    private func startUnreadPolling() {
        stopUnreadPolling()
        unreadPollTask = Task { @MainActor in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(45))
                if Task.isCancelled { return }
                await refreshUnreadCount()
            }
        }
    }

    private func stopUnreadPolling() {
        unreadPollTask?.cancel()
        unreadPollTask = nil
    }

    // MARK: - Popup Logic
    //
    // Security-first: treat `emailVerified == nil` as unverified.
    // Rationale: if we don't know, ask — safer than silently assuming the
    // user is verified. We compensate for false positives by:
    //   1. Always calling refreshUser() BEFORE deciding (onAppear). The
    //      server always returns a concrete boolean, so nil is resolved.
    //   2. Re-checking the value after the 1.5s animation delay so a late
    //      refresh can cancel the queued popup.
    //   3. Observing currentUser.emailVerified with .onChange so the popup
    //      auto-dismisses the moment the server flips the flag to true
    //      (e.g. after a successful /api/auth/me that revealed the user
    //      was already verified all along).
    //
    // If the initial refresh fails (network down) and the field stays nil,
    // the popup will show. When the user taps "Reenviar", the server will
    // either send a new link or report "already verified" — both resolve
    // the unknown state in a follow-up refresh, and the popup closes.
    private func schedulePopupIfNeeded() {
        guard !popupDismissed, let user = api.currentUser else { return }
        // Only SKIP when we have explicit proof of verification.
        guard user.emailVerified != true else { return }
        Task { @MainActor in
            try? await Task.sleep(for: .seconds(1.5))
            guard !popupDismissed else { return }
            // Re-check — refreshUser() may have updated the field to true
            guard api.currentUser?.emailVerified != true else { return }
            // onAppear already refreshed the user — just re-check the field
            guard api.currentUser?.emailVerified != true else { return }
            withAnimation(.easeInOut(duration: 0.25)) { showPopup = true }
        }
    }

    private func dismissPopup() {
        withAnimation(.easeInOut(duration: 0.25)) { showPopup = false }
        popupDismissed = true
    }

    // MARK: - Popup Ad

    private func checkPopupAd() async {
        // Don't show ad popup if another popup, sheet, or fullscreen cover is active
        guard !showPopup, !showPushPrimer, !showAdPopup,
              deepLinkListingID == nil, favAuthSheet == nil else { return }
        guard let ad = await api.fetchPopupAd() else { return }
        // Per-ad cooldown check
        let key = "popup_ad_last_shown_\(ad.id)"
        let lastShown = UserDefaults.standard.double(forKey: key)
        let cooldownSeconds = Double(ad.cooldown_hours ?? 2) * 3600
        if lastShown > 0 && Date().timeIntervalSince1970 - lastShown < cooldownSeconds { return }
        // Show after a brief delay
        await MainActor.run {
            popupAd = ad
            withAnimation(.easeInOut(duration: 0.3)) { showAdPopup = true }
        }
        api.trackAdImpression(ad.id)
    }

    private func dismissAdPopup() {
        if let ad = popupAd {
            UserDefaults.standard.set(Date().timeIntervalSince1970, forKey: "popup_ad_last_shown_\(ad.id)")
        }
        withAnimation(.easeInOut(duration: 0.25)) { showAdPopup = false }
    }

    private func popupAdOverlay(_ ad: Ad) -> some View {
        ZStack {
            Color.black.opacity(0.55)
                .ignoresSafeArea()
                .onTapGesture { dismissAdPopup() }

            ZStack(alignment: .topTrailing) {
                // Full-bleed ad image — tappable
                Button {
                    api.trackAdClick(ad.id)
                    if let url = ad.targetURL { UIApplication.shared.open(url) }
                    dismissAdPopup()
                } label: {
                    CachedAsyncImage(url: ad.imageURL, maxPixelSize: 1200) { phase in
                        switch phase {
                        case .success(let img):
                            img.resizable().scaledToFit()
                        case .failure:
                            Color.gray.opacity(0.2).frame(height: 300)
                        default:
                            Color.gray.opacity(0.1).frame(height: 300)
                                .overlay(ProgressView())
                        }
                    }
                }
                .buttonStyle(.plain)
                .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))

                // X button — top right, overlaid on image
                Button { dismissAdPopup() } label: {
                    Image(systemName: "xmark.circle.fill")
                        .font(.system(size: 30))
                        .foregroundStyle(.white)
                        .shadow(color: .black.opacity(0.5), radius: 4, y: 2)
                }
                .buttonStyle(.plain)
                .offset(x: 8, y: -8)
            }
            .padding(.horizontal, 28)
            .transition(.scale(scale: 0.85).combined(with: .opacity))
        }
        .transition(.opacity)
    }

    // MARK: - Reminder Popup

    @ViewBuilder
    private func reminderPopup(_ user: User) -> some View {
        ZStack {
            // Dimmed background
            Color.black.opacity(0.4)
                .ignoresSafeArea()
                .onTapGesture { dismissPopup() }

            VStack(spacing: 0) {
                // Close button
                HStack {
                    Spacer()
                    Button { dismissPopup() } label: {
                        Image(systemName: "xmark.circle.fill")
                            .font(.system(size: 28))
                            .foregroundStyle(.secondary)
                    }
                    .buttonStyle(.plain)
                }
                .padding(.bottom, 4)

                // Email verification card
                VStack(spacing: 14) {
                    Image(systemName: "envelope.badge.shield.half.filled")
                        .font(.system(size: 40))
                        .foregroundStyle(Color(red: 0.9, green: 0.5, blue: 0))
                    Text("Verifica tu correo")
                        .font(.title3.bold())
                    Text("Enviamos un enlace de verificacion a **\(user.email)**. Revisa tu bandeja de entrada o spam.")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)

                    if verificationSent {
                        Label("Correo enviado", systemImage: "checkmark.circle.fill")
                            .font(.subheadline.bold())
                            .foregroundStyle(.green)
                    } else if verificationError {
                        Label("Error al enviar", systemImage: "xmark.circle.fill")
                            .font(.subheadline.bold())
                            .foregroundStyle(.red)
                    } else {
                        Button {
                            Task {
                                resendingVerification = true
                                verificationError = false
                                do {
                                    try await api.resendVerificationEmail()
                                    verificationSent = true
                                    Task { @MainActor in try? await Task.sleep(for: .seconds(5)); verificationSent = false }
                                } catch {
                                    verificationError = true
                                    Task { @MainActor in try? await Task.sleep(for: .seconds(3)); verificationError = false }
                                }
                                resendingVerification = false
                            }
                        } label: {
                            if resendingVerification {
                                ProgressView()
                                    .frame(maxWidth: .infinity)
                                    .padding(.vertical, 12)
                            } else {
                                Text("Reenviar correo")
                                    .font(.subheadline.bold())
                                    .foregroundStyle(.white)
                                    .frame(maxWidth: .infinity)
                                    .padding(.vertical, 12)
                                    .background(Color(red: 0.9, green: 0.5, blue: 0), in: RoundedRectangle(cornerRadius: 10))
                            }
                        }
                        .buttonStyle(.plain)
                    }
                }
                .padding(20)
                .background(Color(.secondarySystemGroupedBackground))
                .clipShape(RoundedRectangle(cornerRadius: 14))
            }
            .padding(24)
            .background(Color(.systemGroupedBackground))
            .clipShape(RoundedRectangle(cornerRadius: 20))
            .shadow(color: .black.opacity(0.2), radius: 20, y: 10)
            .padding(.horizontal, 28)
            .transition(.scale(scale: 0.85).combined(with: .opacity))
        }
        .transition(.opacity)
    }

    /// Handle push notification tap — navigate to relevant tab
    ///
    /// #34: Application-related pushes carry `application_id` (and an
    /// optional `url` web fallback). When present we route into the
    /// Profile → Mis Aplicaciones list and post `.deepLinkApplication`
    /// so `ApplicationsView` can push the detail view onto its
    /// NavigationStack. The receiving view chooses buyer vs broker
    /// detail based on the current user's role.
    private func handlePushTap(_ userInfo: [AnyHashable: Any]?) {
        guard let info = userInfo else { return }
        let type = info["type"] as? String ?? ""

        // Any message-related push should also kick the unread refresh
        // so the red badge on the Messages tab updates without waiting
        // for the next 30s poll.
        if type == "new_message" {
            Task { await refreshUnreadCount() }
        }

        switch type {
        case "new_message":
            selectedTab = 2 // Messages tab
        case "task_assigned", "task_requested":
            selectedTab = 3 // Tasks tab — direct access
            Task { await refreshUnreadCount() }
        case "tour_update", "tour_reminder":
            selectedTab = 4 // Profile tab (tours are in profile)
        case "new_application", "status_changed", "payment_approved", "document_reviewed":
            selectedTab = 4 // Profile tab (applications are in profile)
            // Deep-link to the specific application if the payload carries one.
            if let appId = info["application_id"] as? String, !appId.isEmpty {
                // Small delay so the Profile tab settles before we
                // post — otherwise NavigationStack may swallow the
                // push if ApplicationsView hasn't subscribed yet.
                Task { @MainActor in
                    try? await Task.sleep(for: .milliseconds(300))
                    NotificationCenter.default.post(
                        name: .deepLinkApplication,
                        object: nil,
                        userInfo: ["applicationId": appId]
                    )
                }
            }
        case "saved_search_match", "new_listing":
            selectedTab = 1 // Browse/Explore tab
        default:
            selectedTab = 0 // Feed
        }
    }
}

// MARK: - Messages Tab

struct MessagesTabView: View {
    @EnvironmentObject var api: APIService
    @State private var showAuth = false

    var body: some View {
        NavigationStack {
            if api.currentUser != nil {
                ConversationsView()
                    .environmentObject(api)
            } else {
                messagesGuestView
                    .navigationTitle("Mensajes")
            }
        }
        .sheet(isPresented: $showAuth) {
            AuthView().environmentObject(api)
        }
    }

    private var messagesGuestView: some View {
        VStack(spacing: 24) {
            Spacer()
            ZStack {
                Circle().fill(Color.rdBlue.opacity(0.08)).frame(width: 110, height: 110)
                Image(systemName: "bubble.left.and.bubble.right")
                    .font(.system(size: 48))
                    .foregroundStyle(Color.rdBlue)
            }
            VStack(spacing: 8) {
                Text("Tus mensajes")
                    .font(.title2).bold()
                Text("Inicia sesión para ver tus\nconversaciones con agentes.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
            }
            Button { showAuth = true } label: {
                Text("Iniciar sesión")
                    .font(.subheadline.bold())
                    .foregroundStyle(.white)
                    .padding(.horizontal, 32).padding(.vertical, 12)
                    .background(Color.rdBlue, in: RoundedRectangle(cornerRadius: 12))
            }
            .buttonStyle(.plain)
            Spacer()
        }
    }
}

// MARK: - Tasks Tab

struct TasksTabView: View {
    @EnvironmentObject var api: APIService
    @State private var showAuth = false

    var body: some View {
        NavigationStack {
            if api.currentUser != nil {
                TasksView()
                    .environmentObject(api)
            } else {
                tasksGuestView
                    .navigationTitle("Tareas")
            }
        }
        .sheet(isPresented: $showAuth) {
            AuthView().environmentObject(api)
        }
    }

    private var tasksGuestView: some View {
        VStack(spacing: 24) {
            Spacer()
            ZStack {
                Circle().fill(Color.rdBlue.opacity(0.08)).frame(width: 110, height: 110)
                Image(systemName: "checklist")
                    .font(.system(size: 48))
                    .foregroundStyle(Color.rdBlue)
            }
            VStack(spacing: 8) {
                Text("Tus tareas")
                    .font(.title2).bold()
                Text("Inicia sesión para ver las tareas\nasignadas a ti.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
            }
            Button { showAuth = true } label: {
                Text("Iniciar sesión")
                    .font(.subheadline.bold())
                    .foregroundStyle(.white)
                    .padding(.horizontal, 32).padding(.vertical, 12)
                    .background(Color.rdBlue, in: RoundedRectangle(cornerRadius: 12))
            }
            .buttonStyle(.plain)
            Spacer()
        }
    }
}

// MARK: - Profile Tab — editorial redesign
//
// Mirrors the "ios-profile" design from claude.ai/design (cream
// editorial palette, floating-avatar hero, 3 KPI tiles for
// rating / ranking / cierres, then rounded-card section list).
// All existing menu items are preserved — only the visual shell
// and grouping changed.

struct ProfileTabView: View {
    @EnvironmentObject var api:   APIService
    @EnvironmentObject var saved: SavedStore
    @State private var authSheet: AuthView.Mode? = nil
    @State private var showPost = false
    @State private var showSubscription = false

    // Hero KPIs — populated async on appear. Nil = "—" placeholder.
    @State private var ratingAvg:  Double? = nil
    @State private var totalSales: Int?    = nil

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    if let user = api.currentUser {
                        ProfileHeroCard(
                            user: user,
                            rating: ratingAvg,
                            sales: totalSales
                        )
                        .environmentObject(api)
                        .padding(.horizontal, 20)
                        .padding(.top, 4)

                        loggedInSections(user)
                            .padding(.horizontal, 20)
                    } else {
                        guestHero
                            .padding(.horizontal, 20)
                            .padding(.top, 18)
                        ProfileSectionCard(title: "Soporte") {
                            supportRows
                        }
                        .padding(.horizontal, 20)
                    }
                }
                .padding(.bottom, 24)   // small visual gap; system tab bar handles its own safe-area inset
            }
            .background(profileBackdrop)
            .navigationTitle("Mi Perfil")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                if api.currentUser != nil {
                    ToolbarItem(placement: .primaryAction) {
                        NavigationLink {
                            NotificationsView().environmentObject(api)
                        } label: {
                            Image(systemName: "bell")
                                .font(.system(size: 15, weight: .semibold))
                                .foregroundStyle(.primary)
                        }
                    }
                }
            }
            .sheet(item: $authSheet) { mode in
                AuthView(initialMode: mode).environmentObject(api).id(mode)
            }
            .sheet(isPresented: $showPost) {
                SubmitListingView().environmentObject(api)
            }
            .sheet(isPresented: $showSubscription) {
                PlansView().environmentObject(api)
            }
            .task { await loadStats() }
            .refreshable { await loadStats() }
        }
    }

    // ── Backdrop ────────────────────────────────────────────────
    // Backdrop is a separate component (ProfileBackdrop) so detail
    // screens reachable from the tab — Cuenta y seguridad, etc. —
    // can apply the same wash and feel like one continuous flow.
    private var profileBackdrop: some View { ProfileBackdrop() }

    // ── Logged-in sections ──────────────────────────────────────
    @ViewBuilder
    private func loggedInSections(_ user: User) -> some View {
        // General — account + notifications + appearance
        ProfileSectionCard(title: "General") {
            ProfileNavRow(
                icon: "person.text.rectangle.fill",
                label: "Cuenta y seguridad",
                sub: "Datos personales, contraseña, 2FA"
            ) { ProfileView() }
            Divider().padding(.leading, 64)
            ProfileNavRow(
                icon: "bell.fill",
                label: "Notificaciones",
                sub: "Push, email y preferencias"
            ) { NotificationSettingsView() }
            Divider().padding(.leading, 64)
            ProfileNavRow(
                icon: "gearshape.fill",
                label: "Apariencia",
                sub: "Tema claro, oscuro o sistema"
            ) { AppSettingsView() }
            Divider().padding(.leading, 64)
            ProfileActionRow(
                icon: "crown.fill",
                iconAccent: Color.rdGold,
                label: "Suscripción",
                sub: subscriptionRowSub(user),
                action: { showSubscription = true }
            )
        }

        // Client-only: saved listings + saved searches
        if !user.isAgency {
            ProfileSectionCard(title: "Mi actividad") {
                ProfileNavRow(
                    icon: "heart.fill",
                    iconAccent: Color.rdRed,
                    label: "Propiedades guardadas",
                    sub: saved.savedIDs.isEmpty ? "Aún sin favoritos"
                        : "\(saved.savedIDs.count) guardada\(saved.savedIDs.count == 1 ? "" : "s")"
                ) { SavedListingsView() }
                Divider().padding(.leading, 64)
                ProfileNavRow(
                    icon: "bell.badge.fill",
                    label: "Búsquedas guardadas",
                    sub: "Recibe alertas de nuevas propiedades"
                ) { SavedSearchesView().environmentObject(api) }
            }

            ProfileSectionCard(title: "Herramientas") {
                ProfileNavRow(
                    icon: "calendar.badge.clock",
                    label: "Mis visitas",
                    sub: nil
                ) { MyToursView().environmentObject(api) }
                Divider().padding(.leading, 64)
                ProfileNavRow(
                    icon: "doc.text.fill",
                    label: "Mis aplicaciones",
                    sub: nil
                ) { ApplicationsView() }
                Divider().padding(.leading, 64)
                ProfileNavRow(
                    icon: "brain.head.profile.fill",
                    iconAccent: Color.rdAccent,
                    label: "Asistente IA",
                    sub: nil
                ) { ChatIAView().environmentObject(api) }
                Divider().padding(.leading, 64)
                ProfileNavRow(
                    icon: "link",
                    label: "Conectores",
                    sub: nil
                ) { ConnectorsView() }
            }
        }

        // Agency / inmobiliaria tools
        if user.isAgency {
            ProfileSectionCard(title: "Herramientas de Agente") {
                ProfileNavRow(
                    icon: "chart.bar.fill",
                    label: "Dashboard",
                    sub: "Vista general de tu actividad"
                ) {
                    // api is already in the environment from the parent
                    // NavigationStack — child views inherit via the SwiftUI
                    // chain, no need for explicit .environmentObject here.
                    if user.isTeamLead || user.effectiveAccessLevel >= 2 {
                        InmobiliariaDashboardView()
                    } else if user.isSecretary {
                        SecretaryDashboardView()
                    } else {
                        BrokerDashboardView()
                    }
                }
                Divider().padding(.leading, 64)
                ProfileNavRow(
                    icon: "brain.head.profile.fill",
                    iconAccent: Color.rdAccent,
                    label: "Chat IA",
                    sub: nil
                ) { ChatIAView().environmentObject(api) }
                Divider().padding(.leading, 64)
                ProfileActionRow(
                    icon: "plus.circle.fill",
                    iconAccent: Color.rdAccent,
                    label: "Publicar propiedad",
                    sub: nil,
                    action: { showPost = true }
                )
                Divider().padding(.leading, 64)
                ProfileNavRow(
                    icon: "briefcase.fill",
                    iconAccent: Color.rdTeal,
                    label: "Mi portafolio",
                    sub: nil
                ) { AgencyDashboardView().environmentObject(api) }
                Divider().padding(.leading, 64)
                ProfileNavRow(
                    icon: "doc.text.fill",
                    label: "Aplicaciones recibidas",
                    sub: nil
                ) { ApplicationsView() }
                Divider().padding(.leading, 64)
                ProfileNavRow(
                    icon: "calendar.badge.clock",
                    label: "Visitas agendadas",
                    sub: nil
                ) { BrokerToursView().environmentObject(api) }
                Divider().padding(.leading, 64)
                ProfileNavRow(
                    icon: "megaphone.fill",
                    iconAccent: Color.rdAccent,
                    label: "Publicidad (Meta Ads)",
                    sub: nil
                ) { AdCampaignsView().environmentObject(api) }
                Divider().padding(.leading, 64)
                ProfileNavRow(
                    icon: "clock.badge.checkmark",
                    label: "Disponibilidad",
                    sub: nil
                ) { BrokerAvailabilityView().environmentObject(api) }
            }

            // Team management (inmobiliaria/constructora + access >= 2)
            if user.canViewTeam {
                ProfileSectionCard(title: "Gestión de Equipo") {
                    ProfileNavRow(
                        icon: "person.2.fill",
                        label: "Mis agentes",
                        sub: nil
                    ) { InmobiliariaTeamListView().environmentObject(api) }
                    Divider().padding(.leading, 64)
                    ProfileNavRow(
                        icon: "chart.line.uptrend.xyaxis",
                        label: "Rendimiento del equipo",
                        sub: nil
                    ) { InmobiliariaPerformanceListView().environmentObject(api) }
                    if user.canManageTeam {
                        Divider().padding(.leading, 64)
                        ProfileNavRow(
                            icon: "person.badge.plus",
                            label: "Solicitudes de afiliación",
                            sub: nil
                        ) { InmobiliariaRequestsListView().environmentObject(api) }
                    }
                }
            }
        }

        // Soporte (links out)
        ProfileSectionCard(title: "Soporte") {
            supportRows
        }

        // Logout (destructive)
        ProfileSectionCard(title: nil) {
            Button(role: .destructive) {
                api.logout()
            } label: {
                ProfileRowLabel(
                    icon: "rectangle.portrait.and.arrow.right",
                    iconAccent: Color.rdAccent,
                    label: "Cerrar sesión",
                    sub: nil,
                    danger: true,
                    showChevron: false
                )
            }
            .buttonStyle(.plain)
        }
    }

    // ── Reusable bits ───────────────────────────────────────────
    @ViewBuilder
    private var supportRows: some View {
        ProfileExternalRow(
            icon: "questionmark.circle.fill",
            label: "Centro de ayuda",
            url:   URL(string: "https://hogaresrd.com/contacto")!
        )
        Divider().padding(.leading, 64)
        ProfileExternalRow(
            icon: "doc.text.fill",
            label: "Términos de uso",
            url:   URL(string: "https://hogaresrd.com/terminos")!
        )
        Divider().padding(.leading, 64)
        ProfileExternalRow(
            icon: "lock.shield.fill",
            label: "Privacidad",
            url:   URL(string: "https://hogaresrd.com/privacidad")!
        )
    }

    private var guestHero: some View {
        VStack(spacing: 18) {
            ZStack {
                Circle()
                    .fill(Color.rdAccent.opacity(0.10))
                    .frame(width: 116, height: 116)
                Image(systemName: "person.fill")
                    .font(.system(size: 48))
                    .foregroundStyle(Color.rdAccent)
            }

            VStack(spacing: 6) {
                Text("Bienvenido a HogaresRD")
                    .font(.system(size: 22, weight: .semibold, design: .serif))
                Text("Inicia sesión para guardar propiedades,\nrecibir actualizaciones y más.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
            }

            VStack(spacing: 10) {
                Button {
                    authSheet = .welcome
                } label: {
                    Text("Iniciar sesión")
                        .font(.headline)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 14)
                        .background(Color.rdAccent)
                        .foregroundStyle(.white)
                        .clipShape(RoundedRectangle(cornerRadius: 14))
                }
                Button {
                    authSheet = .pickRole
                } label: {
                    Text("Crear cuenta gratis")
                        .font(.headline)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 14)
                        .background(Color.rdAccent.opacity(0.10))
                        .foregroundStyle(Color.rdAccent)
                        .clipShape(RoundedRectangle(cornerRadius: 14))
                        .overlay(
                            RoundedRectangle(cornerRadius: 14)
                                .stroke(Color.rdAccent.opacity(0.25), lineWidth: 1.2)
                        )
                }
            }
            .padding(.top, 4)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 24)
    }

    // ── Helpers ─────────────────────────────────────────────────

    private func subscriptionRowSub(_ user: User) -> String {
        if !user.isAgency { return "Plan Cliente · Gratis" }
        switch user.role {
        case "broker", "agency":   return "Plan Broker"
        case "inmobiliaria":       return "Plan Inmobiliaria"
        case "constructora":       return "Plan Constructora"
        case "secretary":          return "Asociado a tu inmobiliaria"
        default:                   return "Activo"
        }
    }

    private func loadStats() async {
        guard let user = api.currentUser, user.isAgency else {
            ratingAvg  = nil
            totalSales = nil
            return
        }
        async let salesTask: Int? = {
            (try? await api.getDashboardSales())?.totalSales
        }()
        async let ratingTask: Double? = await fetchMyRating(user: user)
        let (s, r) = await (salesTask, ratingTask)
        await MainActor.run {
            self.totalSales = s
            self.ratingAvg  = r
        }
    }

    /// Pull the aggregate rating from the public reviews endpoint for
    /// the user's own inmobiliaria. Brokers attached to an inmobiliaria
    /// inherit their team's score; team leads see their own. Returns
    /// nil when the endpoint isn't applicable (no reviews, 404, etc.).
    private func fetchMyRating(user: User) async -> Double? {
        let inmId: String? = {
            if user.isInmobiliaria { return user.id }
            // Brokers/agency under an inmobiliaria — use the parent.
            // user model doesn't carry inmobiliaria_id; fall back to nil.
            return nil
        }()
        guard let id = inmId else { return nil }
        guard let url = URL(string: "\(apiBase)/api/inmobiliaria/\(id)/reviews"),
              let req = try? api.authedRequest(url) else { return nil }
        guard let (data, _) = try? await URLSession.shared.data(for: req) else { return nil }
        struct Wrap: Decodable { let average: Double? }
        return (try? JSONDecoder().decode(Wrap.self, from: data))?.average
    }
}

// MARK: - Profile Hero Card
//
// Floating-avatar header card. Layout: avatar overlaps the top of a
// white rounded card; below the avatar sits the name (serif),
// optional subtitle (agency / role), and a 3-tile KPI grid for
// rating / ranking / cierres. KPI tiles are hidden for non-agency
// users — those metrics aren't meaningful for plain clients.

private struct ProfileHeroCard: View {
    let user: User
    let rating: Double?
    let sales:  Int?

    @EnvironmentObject var api: APIService

    var body: some View {
        ZStack(alignment: .top) {
            // Card body
            VStack(spacing: 18) {
                Spacer().frame(height: 58)   // room for the floating avatar

                // Name (serif italic last name) + subtitle
                VStack(spacing: 6) {
                    nameView
                        .multilineTextAlignment(.center)
                    subtitleView
                }
                .frame(maxWidth: .infinity)

                if user.isAgency {
                    HStack(spacing: 10) {
                        kpiTile(
                            label: "Calificación",
                            value: rating.map { String(format: "%.1f", $0) } ?? "—",
                            icon: "star.fill",
                            tint: Color.rdGold
                        )
                        kpiTile(
                            label: "Ranking",
                            value: rankingLabel(),
                            icon: "trophy.fill",
                            tint: Color.rdAccent
                        )
                        kpiTile(
                            label: "Cierres",
                            value: sales.map(String.init) ?? "—",
                            icon: "briefcase.fill",
                            tint: Color.rdTeal
                        )
                    }
                }
            }
            .padding(.horizontal, 18)
            .padding(.bottom, 18)
            .frame(maxWidth: .infinity)
            .background(
                RoundedRectangle(cornerRadius: 22, style: .continuous)
                    .fill(Color(.systemBackground))
            )
            .overlay(
                RoundedRectangle(cornerRadius: 22, style: .continuous)
                    .stroke(Color.black.opacity(0.04), lineWidth: 1)
            )
            .shadow(color: .black.opacity(0.04), radius: 12, y: 4)
            .padding(.top, 58)   // pushes the card down so the avatar floats above

            // Floating avatar — absolute, centered horizontally
            avatar
        }
    }

    private var nameView: Text {
        let parts = user.name.split(separator: " ", maxSplits: 1, omittingEmptySubsequences: true)
        let first = String(parts.first ?? "")
        let last  = parts.count > 1 ? String(parts[1]) : ""

        let firstText = Text(first)
            .font(.system(size: 28, weight: .semibold, design: .serif))
            .foregroundStyle(.primary)

        if last.isEmpty { return firstText }
        return firstText
            + Text(" ")
            + Text(last)
                .font(.system(size: 28, weight: .semibold, design: .serif))
                .italic()
                .foregroundStyle(.secondary)
    }

    @ViewBuilder
    private var subtitleView: some View {
        if let agency = user.agencyName, !agency.isEmpty {
            HStack(spacing: 5) {
                Image(systemName: "mappin.and.ellipse")
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
                Text(agency)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }
        } else {
            Text(roleLabel)
                .font(.subheadline)
                .foregroundStyle(.secondary)
        }
    }

    private var roleLabel: String {
        if user.isConstructora  { return "Constructora" }
        if user.isInmobiliaria  { return "Inmobiliaria" }
        if user.isSecretary     { return "Secretaria" }
        if user.isAgency        { return "Agente · Broker" }
        return "Cliente"
    }

    private var avatar: some View {
        ZStack {
            Circle()
                .fill(Color.rdCream)
                .frame(width: 116, height: 116)
                .shadow(color: Color.rdAccent.opacity(0.18), radius: 14, y: 4)
            AvatarView(user: user, size: 108, editable: true, color: Color.rdAccent)
                .environmentObject(api)
                .clipShape(Circle())
                .overlay(Circle().stroke(Color(.systemBackground), lineWidth: 2))
        }
    }

    private func kpiTile(label: String, value: String, icon: String, tint: Color) -> some View {
        VStack(spacing: 6) {
            Text(label)
                .font(.system(size: 10.5, weight: .medium))
                .foregroundStyle(.secondary)
                .tracking(0.3)
            HStack(spacing: 5) {
                Image(systemName: icon)
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(tint)
                Text(value)
                    .font(.system(size: 14.5, weight: .bold))
                    .foregroundStyle(.primary)
            }
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 11)
        .padding(.horizontal, 6)
        .background(Color.rdCreamDeep)
        .overlay(
            RoundedRectangle(cornerRadius: 14)
                .stroke(Color.black.opacity(0.04), lineWidth: 1)
        )
        .clipShape(RoundedRectangle(cornerRadius: 14))
    }

    /// Coarse ranking proxy. The server doesn't expose a percentile
    /// metric yet, so we derive a label from the (rating, sales) pair
    /// when available — better than a flat "—" for the common case
    /// of an active agent. Rough buckets only; replace with a real
    /// endpoint later.
    private func rankingLabel() -> String {
        guard let s = sales else { return "—" }
        if s >= 25 { return "Top 5%" }
        if s >= 15 { return "Top 10%" }
        if s >= 8  { return "Top 25%" }
        if s >= 3  { return "Top 50%" }
        return "—"
    }
}

// MARK: - Profile Backdrop
//
// Soft warm cream gradient with a subtle gold + terracotta wash at
// the top — matches the iOS profile design's "ellipse 80% 30% at
// 50% 0%" radial accents. Reused by ProfileTabView's tab and by
// the Cuenta y seguridad detail screen so the cream feels continuous.

struct ProfileBackdrop: View {
    var body: some View {
        ZStack {
            Color.rdCream.ignoresSafeArea()
            VStack(spacing: 0) {
                LinearGradient(
                    colors: [
                        Color.rdGold.opacity(0.18),
                        Color.rdAccent.opacity(0.10),
                        Color.clear,
                    ],
                    startPoint: .top,
                    endPoint:   .bottom
                )
                .frame(height: 220)
                .blur(radius: 60)
                Spacer()
            }
            .ignoresSafeArea()
        }
    }
}

// MARK: - Profile Section Card
//
// Wraps a stack of rows in a rounded card, with an optional uppercase
// eyebrow above. Mirrors the design's section-list pattern.

struct ProfileSectionCard<Content: View>: View {
    let title: String?
    @ViewBuilder var content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if let title {
                Text(title.uppercased())
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(.secondary)
                    .tracking(1.0)
                    .padding(.horizontal, 4)
            }
            VStack(spacing: 0) {
                content
            }
            .background(
                RoundedRectangle(cornerRadius: 16, style: .continuous)
                    .fill(Color(.systemBackground))
            )
            .overlay(
                RoundedRectangle(cornerRadius: 16, style: .continuous)
                    .stroke(Color.black.opacity(0.04), lineWidth: 1)
            )
            .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
            .shadow(color: .black.opacity(0.03), radius: 8, y: 2)
        }
    }
}

// MARK: - Profile Row Label
//
// The shared visual for every row in a section card: 36×36 tinted
// icon tile, label + optional subtitle, and an optional chevron.
// Used as the `label:` for NavigationLink, Button, and Link.

struct ProfileRowLabel: View {
    let icon: String
    var iconAccent: Color = .primary
    let label: String
    let sub: String?
    var danger: Bool = false
    var showChevron: Bool = true

    var body: some View {
        HStack(spacing: 14) {
            ZStack {
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .fill(danger ? Color.rdAccent.opacity(0.12) : Color.rdCreamDeep)
                    .frame(width: 36, height: 36)
                Image(systemName: icon)
                    .font(.system(size: 16, weight: .medium))
                    .foregroundStyle(danger ? Color.rdAccent : iconAccent)
            }
            VStack(alignment: .leading, spacing: 2) {
                Text(label)
                    .font(.system(size: 14.5, weight: .semibold))
                    .foregroundStyle(danger ? Color.rdAccent : .primary)
                if let sub, !sub.isEmpty {
                    Text(sub)
                        .font(.system(size: 11.5))
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
            }
            Spacer(minLength: 8)
            if showChevron {
                Image(systemName: "chevron.right")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(.tertiary)
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 13)
        .contentShape(Rectangle())
    }
}

// MARK: - Profile Nav / External Rows

/// Either a NavigationLink (when `destination` is supplied) or a
/// Button (when `action` is supplied). Picks one path so callers
/// don't have to wrap NavigationLink boilerplate at every site.
/// NavigationLink-style row: tapping pushes `destination`. The
/// @ViewBuilder annotation on the initializer parameter is what lets
/// the call site write `if/else` branches that resolve to
/// `_ConditionalContent<…>` instead of bare expression statements
/// (which produce "result is unused" warnings).
struct ProfileNavRow<Destination: View>: View {
    let icon: String
    var iconAccent: Color = .primary
    let label: String
    let sub: String?
    @ViewBuilder let destination: () -> Destination

    init(
        icon: String,
        iconAccent: Color = .primary,
        label: String,
        sub: String?,
        @ViewBuilder destination: @escaping () -> Destination
    ) {
        self.icon = icon
        self.iconAccent = iconAccent
        self.label = label
        self.sub = sub
        self.destination = destination
    }

    var body: some View {
        NavigationLink {
            destination()
        } label: {
            ProfileRowLabel(
                icon: icon, iconAccent: iconAccent,
                label: label, sub: sub
            )
        }
        .buttonStyle(.plain)
    }
}

/// Button-style row: tapping fires `action`. Separate type from
/// ProfileNavRow so overload resolution at the call site is
/// unambiguous (both share the icon/label/sub prefix).
struct ProfileActionRow: View {
    let icon: String
    var iconAccent: Color = .primary
    let label: String
    let sub: String?
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            ProfileRowLabel(
                icon: icon, iconAccent: iconAccent,
                label: label, sub: sub
            )
        }
        .buttonStyle(.plain)
    }
}

/// Toggle-style row inside a ProfileSectionCard. Same icon-tile +
/// label + optional sub layout as the nav rows, but the trailing
/// element is a SwiftUI Toggle (or a ProgressView while `loading`).
struct ProfileToggleRow: View {
    let icon: String
    var iconAccent: Color = .primary
    let label: String
    let sub: String?
    @Binding var isOn: Bool
    var loading: Bool = false

    var body: some View {
        HStack(spacing: 14) {
            ZStack {
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .fill(Color.rdCreamDeep)
                    .frame(width: 36, height: 36)
                Image(systemName: icon)
                    .font(.system(size: 16, weight: .medium))
                    .foregroundStyle(iconAccent)
            }
            VStack(alignment: .leading, spacing: 2) {
                Text(label)
                    .font(.system(size: 14.5, weight: .semibold))
                    .foregroundStyle(.primary)
                if let sub, !sub.isEmpty {
                    Text(sub)
                        .font(.system(size: 11.5))
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            Spacer(minLength: 8)
            if loading {
                ProgressView()
            } else {
                Toggle("", isOn: $isOn)
                    .labelsHidden()
                    .tint(Color.rdAccent)
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 13)
    }
}

struct ProfileExternalRow: View {
    let icon: String
    let label: String
    let url:   URL

    var body: some View {
        Link(destination: url) {
            HStack(spacing: 14) {
                ZStack {
                    RoundedRectangle(cornerRadius: 10, style: .continuous)
                        .fill(Color.rdCreamDeep)
                        .frame(width: 36, height: 36)
                    Image(systemName: icon)
                        .font(.system(size: 16, weight: .medium))
                        .foregroundStyle(.primary)
                }
                Text(label)
                    .font(.system(size: 14.5, weight: .semibold))
                    .foregroundStyle(.primary)
                Spacer()
                Image(systemName: "arrow.up.right")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(.tertiary)
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 13)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
}

// MARK: - Tab bar modifiers
//
// We removed the old custom-capsule FloatingTabBar in favour of the
// system TabView. iOS 26 renders Liquid Glass automatically on the
// standard tab bar; nothing extra is needed for the look itself.
//
// We DO opt into iOS 26's `tabBarMinimizeBehavior(.onScrollDown)` so
// the bar collapses to a compact icon strip while the user scrolls
// content down — same behaviour the new App Store + Apple News etc.
// adopted. Older iOS versions silently fall through.

private struct TabBarMinimizeOnScrollIfAvailable: ViewModifier {
    func body(content: Content) -> some View {
        if #available(iOS 26.0, *) {
            content.tabBarMinimizeBehavior(.onScrollDown)
        } else {
            content
        }
    }
}
