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

                    // ── Client: Saved Homes ──
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
                        }
                    }

                    // ── Role-specific tools ──
                    if user.isAgency {
                        agentToolsSection(user)
                        if user.isInmobiliaria {
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
                AuthView(initialMode: mode).environmentObject(api)
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
        if user.isInmobiliaria {
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
        if user.isInmobiliaria { return Color(red: 0.4, green: 0.1, blue: 0.6) }
        if user.isAgency { return Color.rdBlue }
        return Color.rdGreen
    }

    // MARK: - Agent Tools

    private func agentToolsSection(_ user: User) -> some View {
        Section("Herramientas de Agente") {
            NavigationLink {
                if user.isInmobiliaria {
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
                BrokerAvailabilityView().environmentObject(api)
            } label: {
                Label("Disponibilidad", systemImage: "clock.badge.checkmark")
            }
        }
    }

    // MARK: - Team Management (Inmobiliaria only)

    private var teamManagementSection: some View {
        Section("Gestión de Equipo") {
            NavigationLink {
                InmobiliariaTeamListView().environmentObject(api)
            } label: {
                Label("Mis agentes", systemImage: "person.2.fill")
            }
            NavigationLink {
                InmobiliariaRequestsListView().environmentObject(api)
            } label: {
                Label("Solicitudes de afiliación", systemImage: "person.badge.plus")
            }
            NavigationLink {
                InmobiliariaPerformanceListView().environmentObject(api)
            } label: {
                Label("Rendimiento del equipo", systemImage: "chart.line.uptrend.xyaxis")
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
