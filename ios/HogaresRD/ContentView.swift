import SwiftUI

// MARK: - Brand Colors
extension Color {
    static let rdBlue  = Color(red: 0/255,  green: 56/255,  blue: 168/255)
    static let rdRed   = Color(red: 207/255, green: 20/255,  blue: 43/255)
    static let rdGreen = Color(red: 27/255,  green: 122/255, blue: 62/255)
    static let rdBg    = Color(red: 242/255, green: 246/255, blue: 255/255)
}

// MARK: - Lazy Tab Helper

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

    // Red unread-message badge on the Messages tab bar icon. Polled on
    // scenePhase .active, on login, and every 30s while the app is in
    // foreground. Also kicked by incoming new_message push payloads
    // (via the .pushNotificationTapped notification) so it updates even
    // faster when a message actually arrives.
    @State private var unreadMessages = 0
    // Actionable task count — tasks either assigned to me that I haven't
    // completed, or tasks submitted for my review. Drives the badge on
    // the Profile tab (which is where the Tareas menu lives).
    @State private var unreadTasks = 0
    @State private var unreadPollTask: Task<Void, Never>?

    var body: some View {
        TabView(selection: $selectedTab) {
            FeedView()
                .tabItem { Label("Feed", systemImage: "newspaper.fill") }
                .tag(0)

            LazyView(BrowseView())
                .tabItem { Label("Explorar", systemImage: "magnifyingglass") }
                .tag(1)

            LazyView(MessagesTabView())
                .tabItem { Label("Mensajes", systemImage: "bubble.left.and.bubble.right.fill") }
                .badge(unreadMessages)
                .tag(2)

            LazyView(ProfileTabView(unreadTasks: unreadTasks))
                .tabItem { Label("Perfil", systemImage: "person.fill") }
                .badge(unreadTasks)
                .tag(3)
        }
        .tint(Color.rdBlue)
        .overlay {
            if showPopup, let user = api.currentUser {
                reminderPopup(user)
            } else if showPushPrimer {
                PushPermissionPrimer(isPresented: $showPushPrimer)
                    .environmentObject(pushService)
            }
        }
        .onReceive(NotificationCenter.default.publisher(for: .authRequiredForFavorite)) { _ in
            favAuthSheet = .login
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
            } else if phase == .background || phase == .inactive {
                stopUnreadPolling()
            }
        }
        .onChange(of: selectedTab) { _, newTab in
            // Opening the Messages tab clears the badge optimistically
            // (the thread read endpoint will clear it server-side once
            // the user opens a specific conversation).
            if newTab == 2 {
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
                try? await Task.sleep(for: .seconds(30))
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
            withAnimation(.easeInOut(duration: 0.25)) { showPopup = true }
        }
    }

    private func dismissPopup() {
        withAnimation(.easeInOut(duration: 0.25)) { showPopup = false }
        popupDismissed = true
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
        case "tour_update", "tour_reminder":
            selectedTab = 3 // Profile tab (tours are in profile)
        case "new_application", "status_changed", "payment_approved", "document_reviewed":
            selectedTab = 3 // Profile tab (applications are in profile)
        case "task_assigned", "task_requested":
            // Tasks live under Profile → Tareas. Route there so the
            // client lands directly on the work the agent asked for.
            selectedTab = 3
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
    // Red badge count for the Tareas menu row. Propagated down from
    // ContentView so the same /api/tasks/badge-count poll drives
    // BOTH the Profile tab badge and the menu row indicator.
    var unreadTasks: Int = 0

    var body: some View {
        NavigationStack {
            List {
                // ── Profile Header ──
                Section {
                    if let user = api.currentUser {
                        loggedInHeader(user)
                    } else {
                        guestHeader
                    }
                }

                if let user = api.currentUser {
                    // ── Account & Settings ──
                    Section {
                        NavigationLink {
                            ProfileView()
                        } label: {
                            Label("Cuenta y seguridad", systemImage: "person.fill")
                        }
                        NavigationLink {
                            NotificationSettingsView()
                        } label: {
                            Label("Notificaciones", systemImage: "bell.fill")
                        }
                        NavigationLink {
                            AppSettingsView()
                        } label: {
                            Label("Apariencia", systemImage: "gearshape.fill")
                        }
                    }

                    // ── Client: Saved Homes + Saved Searches ──
                    if !user.isAgency {
                        Section {
                            NavigationLink {
                                SavedListingsView()
                            } label: {
                                HStack {
                                    Label("Propiedades guardadas", systemImage: "heart.fill")
                                    Spacer()
                                    if !saved.savedIDs.isEmpty {
                                        Text("\(saved.savedIDs.count)")
                                            .font(.caption2).bold()
                                            .foregroundStyle(.white)
                                            .padding(.horizontal, 7).padding(.vertical, 3)
                                            .background(Color.rdRed)
                                            .clipShape(Capsule())
                                    }
                                }
                            }
                            NavigationLink {
                                SavedSearchesView().environmentObject(api)
                            } label: {
                                Label("Búsquedas guardadas", systemImage: "bell.badge.fill")
                            }
                        }
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

                    // ── Logout ──
                    Section {
                        Button(role: .destructive) {
                            api.logout()
                        } label: {
                            Label("Cerrar sesión", systemImage: "rectangle.portrait.and.arrow.right")
                                .foregroundStyle(Color.rdRed)
                        }
                    }
                } else {
                    // ── Guest Support ──
                    supportSection
                }
            }
            .navigationTitle("Perfil")
            .sheet(item: $authSheet) { mode in
                AuthView(initialMode: mode)
                    .environmentObject(api)
                    .id(mode)
            }
            .sheet(isPresented: $showPost) {
                SubmitListingView().environmentObject(api)
            }
        }
    }

    // MARK: - Headers

    private func loggedInHeader(_ user: User) -> some View {
        HStack(spacing: 14) {
            AvatarView(user: user, size: 56, editable: true, color: avatarColor(user))
                .environmentObject(api)
            VStack(alignment: .leading, spacing: 3) {
                Text(user.name)
                    .font(.headline)
                Text(user.email)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                roleBadge(user)
            }
        }
        .padding(.vertical, 4)
    }

    private var guestHeader: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 12) {
                ZStack {
                    Circle().fill(Color.rdBlue.opacity(0.08)).frame(width: 56, height: 56)
                    Image(systemName: "person.circle")
                        .font(.system(size: 28))
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
                    authSheet = .login
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

    // MARK: - Role Badge

    @ViewBuilder
    private func roleBadge(_ user: User) -> some View {
        if user.isConstructora {
            Label("Constructora", systemImage: "hammer.fill")
                .font(.caption2).bold()
                .foregroundStyle(Color(red: 0.7, green: 0.35, blue: 0.04))
        } else if user.isInmobiliaria {
            Label("Inmobiliaria", systemImage: "building.2.crop.circle.fill")
                .font(.caption2).bold()
                .foregroundStyle(Color(red: 0.4, green: 0.1, blue: 0.6))
        } else if user.isSecretary {
            Label("Secretaria", systemImage: "person.text.rectangle.fill")
                .font(.caption2).bold()
                .foregroundStyle(Color(red: 0.18, green: 0.55, blue: 0.34))
        } else if user.isAgency {
            Label("Agente / Broker", systemImage: "person.badge.key.fill")
                .font(.caption2).bold()
                .foregroundStyle(Color.rdBlue)
        } else {
            Label("Cliente", systemImage: "person.fill")
                .font(.caption2).bold()
                .foregroundStyle(Color.rdGreen)
        }
    }

    private func avatarColor(_ user: User) -> Color {
        if user.isConstructora { return Color(red: 0.7, green: 0.35, blue: 0.04) }
        if user.isInmobiliaria { return Color(red: 0.4, green: 0.1, blue: 0.6) }
        if user.isAgency { return Color.rdBlue }
        return Color.rdGreen
    }

    // MARK: - Agent Tools

    private func agentToolsSection(_ user: User) -> some View {
        Section("Herramientas de Agente") {
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
                Label("Dashboard", systemImage: "chart.bar.fill")
            }
            NavigationLink {
                ChatIAView().environmentObject(api)
            } label: {
                Label("Chat IA", systemImage: "brain.head.profile.fill")
            }
            Button {
                showPost = true
            } label: {
                Label("Publicar propiedad", systemImage: "plus.circle.fill")
                    .foregroundStyle(Color.rdRed)
            }
            NavigationLink {
                AgencyDashboardView().environmentObject(api)
            } label: {
                Label("Mi portafolio", systemImage: "briefcase.fill")
            }
            NavigationLink {
                ApplicationsView()
            } label: {
                Label("Aplicaciones recibidas", systemImage: "doc.text.fill")
            }
            NavigationLink {
                BrokerToursView().environmentObject(api)
            } label: {
                Label("Visitas agendadas", systemImage: "calendar.badge.clock")
            }
            NavigationLink {
                TasksView().environmentObject(api)
            } label: {
                HStack {
                    Label("Tareas", systemImage: "checklist")
                    Spacer()
                    if unreadTasks > 0 {
                        Text("\(unreadTasks)")
                            .font(.caption.bold())
                            .foregroundStyle(.white)
                            .padding(.horizontal, 8).padding(.vertical, 3)
                            .background(Color.red, in: Capsule())
                    }
                }
            }
            NavigationLink {
                AdCampaignsView().environmentObject(api)
            } label: {
                Label("Publicidad (Meta Ads)", systemImage: "megaphone.fill")
            }
            NavigationLink {
                BrokerAvailabilityView().environmentObject(api)
            } label: {
                Label("Disponibilidad", systemImage: "clock.badge.checkmark")
            }
        }
    }

    // MARK: - Team Management (Inmobiliaria only)

    private var teamManagementSection: some View {
        let level = api.currentUser?.effectiveAccessLevel ?? 1
        return Section("Gestión de Equipo") {
            if level >= 2 {
                NavigationLink {
                    InmobiliariaTeamListView().environmentObject(api)
                } label: {
                    Label("Mis agentes", systemImage: "person.2.fill")
                }
                NavigationLink {
                    InmobiliariaPerformanceListView().environmentObject(api)
                } label: {
                    Label("Rendimiento del equipo", systemImage: "chart.line.uptrend.xyaxis")
                }
            }
            if level >= 3 {
                NavigationLink {
                    InmobiliariaRequestsListView().environmentObject(api)
                } label: {
                    Label("Solicitudes de afiliación", systemImage: "person.badge.plus")
                }
            }
        }
    }

    // MARK: - Client Tools

    private var clientToolsSection: some View {
        Section("Herramientas") {
            NavigationLink {
                MyToursView().environmentObject(api)
            } label: {
                Label("Mis visitas", systemImage: "calendar.badge.clock")
            }
            NavigationLink {
                ApplicationsView()
            } label: {
                Label("Mis aplicaciones", systemImage: "doc.text.fill")
            }
            NavigationLink {
                TasksView().environmentObject(api)
            } label: {
                HStack {
                    Label("Mis tareas", systemImage: "checklist")
                    Spacer()
                    if unreadTasks > 0 {
                        Text("\(unreadTasks)")
                            .font(.caption.bold())
                            .foregroundStyle(.white)
                            .padding(.horizontal, 8).padding(.vertical, 3)
                            .background(Color.red, in: Capsule())
                    }
                }
            }
            NavigationLink {
                ChatIAView().environmentObject(api)
            } label: {
                Label("Asistente IA", systemImage: "brain.head.profile.fill")
            }
            NavigationLink {
                ConnectorsView()
            } label: {
                Label("Conectores", systemImage: "link")
            }
        }
    }

    // MARK: - Support

    private var supportSection: some View {
        Section("Soporte") {
            Link(destination: URL(string: "https://hogaresrd.com/contacto")!) {
                HStack {
                    Label("Ayuda", systemImage: "questionmark.circle.fill")
                    Spacer()
                    Image(systemName: "arrow.up.right")
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                }
            }
            Link(destination: URL(string: "https://hogaresrd.com/terminos")!) {
                HStack {
                    Label("Términos de uso", systemImage: "doc.text.fill")
                    Spacer()
                    Image(systemName: "arrow.up.right")
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                }
            }
            Link(destination: URL(string: "https://hogaresrd.com/privacidad")!) {
                HStack {
                    Label("Privacidad", systemImage: "lock.shield.fill")
                    Spacer()
                    Image(systemName: "arrow.up.right")
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                }
            }
        }
    }
}
