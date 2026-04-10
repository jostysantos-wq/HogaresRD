import SwiftUI

// MARK: - Brand Colors
extension Color {
    static let rdBlue  = Color(red: 0/255,  green: 56/255,  blue: 168/255)
    static let rdRed   = Color(red: 207/255, green: 20/255,  blue: 43/255)
    static let rdGreen = Color(red: 27/255,  green: 122/255, blue: 62/255)
    static let rdBg    = Color(red: 242/255, green: 246/255, blue: 255/255)
}

// MARK: - Root Tab View

struct ContentView: View {
    @EnvironmentObject var api:   APIService
    @EnvironmentObject var saved: SavedStore

    @State private var selectedTab = 0
    @State private var favAuthSheet: AuthView.Mode? = nil

    @Environment(\.scenePhase) private var scenePhase
    @State private var resendingVerification = false
    @State private var verificationSent = false
    @State private var verificationError = false
    @State private var showPopup = false
    @State private var popupDismissed = false

    var body: some View {
        TabView(selection: $selectedTab) {
            FeedView()
                .tabItem { Label("Feed", systemImage: "newspaper.fill") }
                .tag(0)

            BrowseView()
                .tabItem { Label("Explorar", systemImage: "magnifyingglass") }
                .tag(1)

            MessagesTabView()
                .tabItem { Label("Mensajes", systemImage: "bubble.left.and.bubble.right.fill") }
                .tag(2)

            ProfileTabView()
                .tabItem { Label("Perfil", systemImage: "person.fill") }
                .tag(3)
        }
        .tint(Color.rdBlue)
        .overlay {
            if showPopup, let user = api.currentUser {
                reminderPopup(user)
            }
        }
        .onReceive(NotificationCenter.default.publisher(for: .authRequiredForFavorite)) { _ in
            favAuthSheet = .login
        }
        .onReceive(NotificationCenter.default.publisher(for: .pushNotificationTapped)) { notif in
            handlePushTap(notif.userInfo)
        }
        .sheet(item: $favAuthSheet) { mode in
            AuthView(initialMode: mode)
                .environmentObject(api)
                .id(mode)
        }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active, api.currentUser != nil {
                Task { await api.refreshUser() }
            }
        }
        .onChange(of: api.currentUser?.id) {
            // Show popup shortly after login if needed
            schedulePopupIfNeeded()
        }
        .onAppear { schedulePopupIfNeeded() }
    }

    // MARK: - Popup Logic

    private func schedulePopupIfNeeded() {
        guard !popupDismissed, let user = api.currentUser else { return }
        guard !user.isEmailVerified else { return }
        // Show after a short delay so the app loads first
        Task { @MainActor in
            try? await Task.sleep(for: .seconds(1.5))
            if !popupDismissed { withAnimation(.easeInOut(duration: 0.25)) { showPopup = true } }
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

        switch type {
        case "new_message":
            selectedTab = 2 // Messages tab
        case "tour_update", "tour_reminder":
            selectedTab = 3 // Profile tab (tours are in profile)
        case "new_application", "status_changed", "payment_approved", "document_reviewed":
            selectedTab = 3 // Profile tab (applications are in profile)
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
                Label("Tareas", systemImage: "checklist")
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
                Label("Mis tareas", systemImage: "checklist")
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
