import SwiftUI

// MARK: - Brand Colors
//
// The `Color.rdBlue/Red/Green/Bg/Orange/Purple/Teal` palette plus the
// new ink/surface/line/muted neutrals live in
// `DesignSystem/Tokens.swift`. Don't add `Color(red:…)` literals
// inline — extend the token file instead so dark mode + Dynamic Type
// keep working everywhere.

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
        ZStack(alignment: .bottom) {
            TabView(selection: $selectedTab) {
                FeedView()
                    .tabItem { Label("Inicio", systemImage: "newspaper.fill") }
                    .tag(0)
                    .toolbar(.hidden, for: .tabBar)

                LazyView(BrowseView())
                    .tabItem { Label("Explorar", systemImage: "magnifyingglass") }
                    .tag(1)
                    .toolbar(.hidden, for: .tabBar)

                LazyView(MessagesTabView())
                    .tabItem { Label("Mensajes", systemImage: "bubble.left.and.bubble.right.fill") }
                    .badge(unreadMessages)
                    .tag(2)
                    .toolbar(.hidden, for: .tabBar)

                LazyView(TasksTabView())
                    .tabItem { Label("Tareas", systemImage: "checklist") }
                    .badge(unreadTasks)
                    .tag(3)
                    .toolbar(.hidden, for: .tabBar)

                LazyView(ProfileTabView())
                    .tabItem { Label("Perfil", systemImage: "person.fill") }
                    .tag(4)
                    .toolbar(.hidden, for: .tabBar)
            }
            .tint(Color.rdBlue)

            FloatingTabBar(
                selection: $selectedTab,
                unreadMessages: unreadMessages,
                unreadTasks: unreadTasks
            )
            .ignoresSafeArea(.keyboard) // capsule stays put when keyboard rises
        }
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
        .onReceive(NotificationCenter.default.publisher(for: .profileQuickAction)) { notif in
            // Quick-action chip in ProfileTabView (and the SavedListings
            // empty-state CTA) routes deep links to the appropriate tab.
            // Only Messages and Explorar currently have dedicated tabs;
            // the rest stay inside the Profile stack via NavigationLink.
            guard let dest = notif.userInfo?["destination"] as? String else { return }
            switch dest {
            case ProfileTabView.tabMessages:
                withAnimation(.easeInOut(duration: 0.2)) { selectedTab = 2 }
            case "explorar":
                withAnimation(.easeInOut(duration: 0.2)) { selectedTab = 1 }
            default:
                // Other destinations are handled inside the Profile tab —
                // staying on tab 4 keeps NavigationStack-driven drill-downs
                // working without breaking other agents' work.
                break
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

// MARK: - Profile Tab (replaces old Alertas + ProfileMenuView)

struct ProfileTabView: View {
    @EnvironmentObject var api:   APIService
    @EnvironmentObject var saved: SavedStore
    @State private var authSheet: AuthView.Mode? = nil
    @State private var showPost = false
    @State private var showSubscription = false

    private var appVersion: String {
        Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "1.0.0"
    }

    var body: some View {
        NavigationStack {
            List {
                // ── Profile Header ──
                Section {
                    if let user = api.currentUser {
                        IdentityCard(user: user)
                            .listRowInsets(EdgeInsets(top: Spacing.s8, leading: Spacing.s16, bottom: Spacing.s8, trailing: Spacing.s16))
                            .listRowBackground(Color.clear)
                            .listRowSeparator(.hidden)
                    } else {
                        guestHeader
                    }
                }

                if let user = api.currentUser {
                    // ── Subscription banner (pro users only) ──
                    if let banner = subscriptionBannerStatus(user) {
                        Section {
                            SubscriptionStatusBanner(status: banner) {
                                showSubscription = true
                            }
                            .listRowInsets(EdgeInsets(top: Spacing.s4, leading: Spacing.s16, bottom: Spacing.s8, trailing: Spacing.s16))
                            .listRowBackground(Color.clear)
                            .listRowSeparator(.hidden)
                        }
                    }

                    // ── Quick actions ──
                    Section {
                        quickActionsRow(for: user)
                            .listRowInsets(EdgeInsets(top: Spacing.s4, leading: 0, bottom: Spacing.s8, trailing: 0))
                            .listRowBackground(Color.clear)
                            .listRowSeparator(.hidden)
                    }

                    // ── Account & Settings ──
                    Section {
                        NavigationLink {
                            ProfileView()
                        } label: {
                            IconTileRow(systemImage: "person.fill", label: "Cuenta y seguridad")
                        }
                        NavigationLink {
                            NotificationSettingsView()
                        } label: {
                            IconTileRow(systemImage: "bell.fill", label: "Notificaciones")
                        }
                        NavigationLink {
                            AppSettingsView()
                        } label: {
                            IconTileRow(systemImage: "gearshape.fill", label: "Apariencia")
                        }
                    } header: {
                        Text("Ajustes").sectionHeader()
                    }
                    .headerProminence(.increased)

                    // ── Client: Saved Homes + Saved Searches ──
                    if !user.isAgency {
                        Section {
                            NavigationLink {
                                SavedListingsView()
                            } label: {
                                if !saved.savedIDs.isEmpty {
                                    IconTileRow(
                                        systemImage: "heart.fill",
                                        label: "Propiedades guardadas",
                                        accessory: { DSCountPill(count: saved.savedIDs.count, tint: .rdRed) }
                                    )
                                } else {
                                    IconTileRow(systemImage: "heart.fill", label: "Propiedades guardadas")
                                }
                            }
                            NavigationLink {
                                SavedSearchesView().environmentObject(api)
                            } label: {
                                IconTileRow(systemImage: "bell.badge.fill", label: "Búsquedas guardadas")
                            }
                        } header: {
                            Text("Tu actividad").sectionHeader()
                        }
                        .headerProminence(.increased)
                    }

                    // ── Role-specific tools ──
                    if user.isAgency {
                        agentToolsSection(user)
                        if user.isInmobiliaria || user.canViewTeam {
                            teamManagementSection
                        }
                    } else {
                        clientToolsSection
                    }

                    // ── Support ──
                    supportSection

                    // ── Logout (detached, centered, destructive) ──
                    Section {
                        Button(role: .destructive) {
                            api.logout()
                        } label: {
                            Text("Cerrar sesión")
                                .font(.body.weight(.semibold))
                                .foregroundStyle(Color.rdRed)
                                .frame(maxWidth: .infinity)
                        }
                    }

                    // ── Version footer ──
                    Section {
                        EmptyView()
                    } footer: {
                        Text("HogaresRD v\(appVersion)")
                            .font(.caption2)
                            .foregroundStyle(Color.rdInkSoft)
                            .frame(maxWidth: .infinity, alignment: .center)
                            .padding(.top, Spacing.s8)
                    }
                } else {
                    // ── Guest Support ──
                    supportSection
                }
            }
            .listStyle(.insetGrouped)
            .scrollContentBackground(.hidden)
            .background(Color.rdSurface)
            .navigationTitle("Perfil")
            .sheet(item: $authSheet) { mode in
                AuthView(initialMode: mode)
                    .environmentObject(api)
                    .id(mode)
                    .presentationDragIndicator(.visible)
            }
            .sheet(isPresented: $showPost) {
                SubmitListingView()
                    .environmentObject(api)
                    .presentationDragIndicator(.visible)
            }
            .sheet(isPresented: $showSubscription) {
                PlansView()
                    .environmentObject(api)
                    .presentationDragIndicator(.visible)
            }
        }
    }

    // MARK: - Subscription banner mapping

    private func subscriptionBannerStatus(_ user: User) -> SubscriptionStatusBanner.Status? {
        guard let raw = user.subscriptionStatus?.lowercased(), !raw.isEmpty else { return nil }
        switch raw {
        case "active":
            return .active
        case "trial", "trialing":
            return .trialing(daysRemaining: user.trialDaysRemaining)
        case "past_due", "canceled", "cancelled", "unpaid":
            return .pastDue
        default:
            return nil
        }
    }

    // MARK: - Quick actions chip row

    @ViewBuilder
    private func quickActionsRow(for user: User) -> some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: Spacing.s8) {
                quickActionChip(
                    icon: "doc.text.fill",
                    label: user.isAgency ? "Aplicaciones" : "Mis aplicaciones",
                    tab: ProfileTabView.tabApplications
                )
                quickActionChip(
                    icon: "folder.fill",
                    label: "Mis documentos",
                    tab: ProfileTabView.tabDocuments
                )
                if !user.isAgency {
                    quickActionChip(
                        icon: "heart.fill",
                        label: "Guardados",
                        tab: ProfileTabView.tabSaved
                    )
                }
                quickActionChip(
                    icon: "bubble.left.and.bubble.right.fill",
                    label: "Mensajes",
                    tab: ProfileTabView.tabMessages
                )
            }
            .padding(.horizontal, Spacing.s16)
            .padding(.vertical, Spacing.s4)
        }
    }

    private func quickActionChip(icon: String, label: String, tab: String) -> some View {
        Button {
            NotificationCenter.default.post(
                name: .profileQuickAction,
                object: nil,
                userInfo: ["destination": tab]
            )
        } label: {
            HStack(spacing: 6) {
                Image(systemName: icon)
                    .font(.caption.weight(.semibold))
                Text(label)
                    .font(.subheadline.weight(.medium))
            }
            .foregroundStyle(Color.rdInk)
            .padding(.horizontal, Spacing.s12)
            .padding(.vertical, Spacing.s8)
            .background(
                Capsule().fill(Color.rdSurfaceMuted)
            )
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label)
        .accessibilityHint("Abre la pestaña de \(label.lowercased())")
    }

    // Quick-action destination identifiers — consumed by ContentView.
    static let tabApplications = "applications"
    static let tabDocuments    = "documents"
    static let tabSaved        = "saved"
    static let tabMessages     = "messages"

    // MARK: - Guest Header

    private var guestHeader: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 12) {
                ZStack {
                    Circle().fill(Color.rdBlue.opacity(0.08)).frame(width: 56, height: 56)
                    Image(systemName: "person.circle")
                        .font(.title)
                        .foregroundStyle(Color.rdBlue)
                }
                VStack(alignment: .leading, spacing: 3) {
                    Text("Bienvenido")
                        .font(.headline)
                    Text("Inicia sesión para acceder a todas las funciones")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }

            HStack(spacing: 10) {
                Button {
                    authSheet = .welcome
                } label: {
                    Text("Iniciar sesión")
                        .font(.caption).bold()
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 10)
                        .background(Color.rdBlue)
                        .foregroundStyle(.white)
                        .clipShape(Capsule())
                }
                Button {
                    authSheet = .pickRole
                } label: {
                    Text("Crear cuenta")
                        .font(.caption).bold()
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 10)
                        .background(Color.rdRed.opacity(0.1))
                        .foregroundStyle(Color.rdRed)
                        .clipShape(Capsule())
                        .overlay(Capsule().stroke(Color.rdRed.opacity(0.3), lineWidth: 1))
                }
            }
        }
        .padding(.vertical, 4)
    }

    // MARK: - Agent Tools

    private func agentToolsSection(_ user: User) -> some View {
        Section {
            NavigationLink {
                // Team leads (inmobiliaria + constructora) ALWAYS get the
                // full team dashboard. Secretaries get the limited secretary
                // dashboard. Everyone else (broker/agency) gets broker.
                if user.isTeamLead || user.effectiveAccessLevel >= 2 {
                    InmobiliariaDashboardView().environmentObject(api)
                } else if user.isSecretary {
                    SecretaryDashboardView().environmentObject(api)
                } else {
                    BrokerDashboardView().environmentObject(api)
                }
            } label: {
                IconTileRow(systemImage: "chart.bar.fill", label: "Dashboard")
            }
            NavigationLink {
                ChatIAView().environmentObject(api)
            } label: {
                IconTileRow(systemImage: "brain.head.profile.fill", label: "Chat IA")
            }
            Button {
                showPost = true
            } label: {
                IconTileRow(systemImage: "plus.circle.fill", label: "Publicar propiedad")
            }
            .buttonStyle(.plain)
            NavigationLink {
                AgencyDashboardView().environmentObject(api)
            } label: {
                IconTileRow(systemImage: "briefcase.fill", label: "Mi portafolio")
            }
            NavigationLink {
                ApplicationsView()
            } label: {
                IconTileRow(systemImage: "doc.text.fill", label: "Aplicaciones recibidas")
            }
            NavigationLink {
                BrokerToursView().environmentObject(api)
            } label: {
                IconTileRow(systemImage: "calendar.badge.clock", label: "Visitas agendadas")
            }
            NavigationLink {
                AdCampaignsView().environmentObject(api)
            } label: {
                IconTileRow(systemImage: "megaphone.fill", label: "Publicidad (Meta Ads)")
            }
            NavigationLink {
                BrokerAvailabilityView().environmentObject(api)
            } label: {
                IconTileRow(systemImage: "clock.badge.checkmark", label: "Disponibilidad")
            }
        } header: {
            Text("Herramientas de agente").sectionHeader()
        }
        .headerProminence(.increased)
    }

    // MARK: - Team Management (Inmobiliaria only)

    private var teamManagementSection: some View {
        let level = api.currentUser?.effectiveAccessLevel ?? 1
        return Section {
            if level >= 2 {
                NavigationLink {
                    InmobiliariaTeamListView().environmentObject(api)
                } label: {
                    IconTileRow(systemImage: "person.2.fill", label: "Mis agentes")
                }
                NavigationLink {
                    InmobiliariaPerformanceListView().environmentObject(api)
                } label: {
                    IconTileRow(systemImage: "chart.line.uptrend.xyaxis", label: "Rendimiento del equipo")
                }
            }
            if level >= 3 {
                NavigationLink {
                    InmobiliariaRequestsListView().environmentObject(api)
                } label: {
                    IconTileRow(systemImage: "person.badge.plus", label: "Solicitudes de afiliación")
                }
            }
        } header: {
            Text("Gestión de equipo").sectionHeader()
        }
        .headerProminence(.increased)
    }

    // MARK: - Client Tools

    private var clientToolsSection: some View {
        Section {
            NavigationLink {
                MyToursView().environmentObject(api)
            } label: {
                IconTileRow(systemImage: "calendar.badge.clock", label: "Mis visitas")
            }
            NavigationLink {
                ApplicationsView()
            } label: {
                IconTileRow(systemImage: "doc.text.fill", label: "Mis aplicaciones")
            }
            NavigationLink {
                ChatIAView().environmentObject(api)
            } label: {
                IconTileRow(systemImage: "brain.head.profile.fill", label: "Asistente IA")
            }
        } header: {
            Text("Herramientas").sectionHeader()
        }
        .headerProminence(.increased)
    }

    // MARK: - Support

    private var supportSection: some View {
        Section {
            Link(destination: URL(string: "https://hogaresrd.com/contacto")!) {
                IconTileRow(
                    systemImage: "questionmark.circle.fill",
                    label: "Ayuda",
                    accessory: {
                        Image(systemName: "arrow.up.right")
                            .font(.caption2.weight(.semibold))
                            .foregroundStyle(Color.rdInkSoft)
                            .accessibilityHidden(true)
                    }
                )
            }
            Link(destination: URL(string: "https://hogaresrd.com/terminos")!) {
                IconTileRow(
                    systemImage: "doc.text.fill",
                    label: "Términos de uso",
                    accessory: {
                        Image(systemName: "arrow.up.right")
                            .font(.caption2.weight(.semibold))
                            .foregroundStyle(Color.rdInkSoft)
                            .accessibilityHidden(true)
                    }
                )
            }
            Link(destination: URL(string: "https://hogaresrd.com/privacidad")!) {
                IconTileRow(
                    systemImage: "lock.shield.fill",
                    label: "Privacidad",
                    accessory: {
                        Image(systemName: "arrow.up.right")
                            .font(.caption2.weight(.semibold))
                            .foregroundStyle(Color.rdInkSoft)
                            .accessibilityHidden(true)
                    }
                )
            }
        } header: {
            Text("Soporte").sectionHeader()
        }
        .headerProminence(.increased)
    }
}

// MARK: - Profile quick-action notification
//
// ProfileTabView posts this when the user taps a chip in the "Quick
// actions" row. ContentView observes it and switches tabs accordingly.
extension Notification.Name {
    static let profileQuickAction = Notification.Name("rd.profileQuickAction")
}

// MARK: - FloatingTabBar
//
// Custom glass tab bar matching the home screenshot — capsule
// background with .ultraThinMaterial blur, dark forest-green active
// pill, icon-only items. Hidden behind the system TabView for
// accessibility (system bar still owns labels via .toolbar(.hidden)
// → still scoped via tabItem labels).

struct FloatingTabBar: View {
    @Binding var selection: Int
    var unreadMessages: Int = 0
    var unreadTasks: Int = 0

    // Use the design-system ink token for the active pill so it tracks
    // dark-mode changes. Previously this was a hard-coded forest-green
    // RGB (31, 61, 51) that ignored Dark Mode.
    private var tabActive: Color { .rdInk }

    private struct Item {
        let tag: Int
        let icon: String
        let label: String
        let badge: Int
    }

    private var items: [Item] {
        [
            Item(tag: 0, icon: "house.fill",       label: "Inicio",   badge: 0),
            Item(tag: 1, icon: "location.fill",    label: "Explorar", badge: 0),
            Item(tag: 2, icon: "bubble.left.fill", label: "Mensajes", badge: unreadMessages),
            Item(tag: 3, icon: "checklist",        label: "Tareas",   badge: unreadTasks),
            Item(tag: 4, icon: "person.fill",      label: "Perfil",   badge: 0),
        ]
    }

    var body: some View {
        HStack(spacing: 0) {
            ForEach(items, id: \.tag) { item in
                Button {
                    withAnimation(.spring(response: 0.35, dampingFraction: 0.85)) {
                        selection = item.tag
                    }
                } label: {
                    cell(for: item)
                }
                .buttonStyle(.plain)
                .accessibilityLabel(item.label)
                .accessibilityAddTraits(selection == item.tag ? .isSelected : [])
                .accessibilityValue(item.badge > 0 ? "\(item.badge) sin leer" : "")
            }
        }
        .padding(.horizontal, 8)
        .frame(height: 64)
        .background(
            Capsule(style: .continuous)
                .fill(.ultraThinMaterial)
                .overlay(
                    Capsule(style: .continuous)
                        .strokeBorder(Color.rdLine, lineWidth: 1)
                )
        )
        .shadow(color: .black.opacity(0.16), radius: 24, x: 0, y: 10)
        .shadow(color: .black.opacity(0.06), radius: 4,  x: 0, y: 2)
        .padding(.horizontal, 28)
        .padding(.bottom, 14)
    }

    @ViewBuilder
    private func cell(for item: Item) -> some View {
        let active = (selection == item.tag)

        ZStack {
            if active {
                Circle()
                    .fill(tabActive)
                    .frame(width: 46, height: 46)
                    .transition(.scale.combined(with: .opacity))
            }

            ZStack(alignment: .topTrailing) {
                Image(systemName: item.icon)
                    .font(.system(size: 18, weight: active ? .semibold : .regular))
                    .foregroundStyle(active ? .white : Color.rdInkSoft)
                    .frame(width: 44, height: 44)

                if item.badge > 0 {
                    Text(item.badge > 99 ? "99+" : "\(item.badge)")
                        .font(.system(size: 9, weight: .bold))
                        .foregroundStyle(.white)
                        .padding(.horizontal, 5)
                        .padding(.vertical, 2)
                        .background(Color.rdRed, in: Capsule())
                        .offset(x: 4, y: -2)
                }
            }
        }
        .frame(maxWidth: .infinity, minHeight: 60)
        .contentShape(Rectangle())
    }
}
