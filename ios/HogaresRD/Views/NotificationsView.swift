import SwiftUI

struct NotificationsView: View {
    @EnvironmentObject var api:   APIService
    @EnvironmentObject var saved: SavedStore

    var body: some View {
        NavigationStack {
            notificationsContent
                .navigationTitle("Alertas")
                .toolbar {
                    ToolbarItem(placement: .navigationBarTrailing) {
                        NavigationLink {
                            ProfileMenuView()
                        } label: {
                            if let user = api.currentUser {
                                ZStack {
                                    Circle()
                                        .fill(Color.rdBlue)
                                        .frame(width: 32, height: 32)
                                    Text(user.initials)
                                        .font(.caption2).bold()
                                        .foregroundStyle(.white)
                                }
                            } else {
                                Image(systemName: "person.circle.fill")
                                    .font(.title3)
                                    .foregroundStyle(Color.rdBlue)
                            }
                        }
                    }
                }
        }
    }

    // MARK: - Notifications Content

    @ViewBuilder
    private var notificationsContent: some View {
        if api.currentUser != nil {
            List {
                Section {
                    HStack(spacing: 14) {
                        ZStack {
                            Circle().fill(Color.rdBlue.opacity(0.1)).frame(width: 44, height: 44)
                            Image(systemName: "bell.badge.fill")
                                .foregroundStyle(Color.rdBlue)
                        }
                        VStack(alignment: .leading, spacing: 3) {
                            Text("Bienvenido a HogaresRD")
                                .font(.subheadline).bold()
                            Text("Recibirás notificaciones sobre propiedades y actualizaciones aquí.")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                    }
                    .padding(.vertical, 4)
                }

                Section("Alertas de precio") {
                    emptyNotificationRow(
                        icon: "arrow.down.circle.fill",
                        color: .rdGreen,
                        title: "Bajas de precio",
                        subtitle: "Guarda propiedades para recibir alertas de cambio de precio"
                    )
                }

                Section("Nuevas propiedades") {
                    emptyNotificationRow(
                        icon: "sparkles",
                        color: .rdBlue,
                        title: "Propiedades nuevas",
                        subtitle: "Configura alertas para recibir notificaciones de nuevos listados"
                    )
                }
            }
        } else {
            VStack(spacing: 24) {
                Spacer()
                ZStack {
                    Circle().fill(Color.rdBlue.opacity(0.08)).frame(width: 110, height: 110)
                    Image(systemName: "bell.circle")
                        .font(.system(size: 52))
                        .foregroundStyle(Color.rdBlue)
                }
                VStack(spacing: 8) {
                    Text("Tus alertas")
                        .font(.title2).bold()
                    Text("Inicia sesión para recibir\nnotificaciones de propiedades.")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                }
                Spacer()
            }
        }
    }

    private func emptyNotificationRow(icon: String, color: Color, title: String, subtitle: String) -> some View {
        HStack(spacing: 14) {
            ZStack {
                Circle().fill(color.opacity(0.1)).frame(width: 40, height: 40)
                Image(systemName: icon).foregroundStyle(color)
            }
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(.subheadline).bold()
                Text(subtitle).font(.caption).foregroundStyle(.secondary)
            }
        }
        .padding(.vertical, 2)
    }
}

// MARK: - Profile Menu (full page, pushes from right)

struct ProfileMenuView: View {
    @EnvironmentObject var api:   APIService
    @EnvironmentObject var saved: SavedStore
    @State private var authSheet: AuthView.Mode? = nil

    var body: some View {
        List {
            // ── Small profile header ──
            Section {
                if let user = api.currentUser {
                    HStack(spacing: 14) {
                        ZStack {
                            Circle()
                                .fill(LinearGradient(colors: [Color.rdBlue, Color.rdBlue.opacity(0.7)],
                                                     startPoint: .topLeading, endPoint: .bottomTrailing))
                                .frame(width: 52, height: 52)
                            Text(user.initials)
                                .font(.title3).bold()
                                .foregroundStyle(.white)
                        }
                        VStack(alignment: .leading, spacing: 3) {
                            Text(user.name)
                                .font(.headline)
                            Text(user.email)
                                .font(.caption)
                                .foregroundStyle(.secondary)
                            if user.isInmobiliaria {
                                Label("Inmobiliaria", systemImage: "building.2.crop.circle.fill")
                                    .font(.caption2).bold()
                                    .foregroundStyle(Color(red: 0.4, green: 0.1, blue: 0.6))
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
                    }
                    .padding(.vertical, 4)
                } else {
                    VStack(alignment: .leading, spacing: 10) {
                        Text("HogaresRD")
                            .font(.headline)
                        Text("Inicia sesión para acceder a todas las funciones")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        HStack(spacing: 10) {
                            Button {
                                authSheet = .login
                            } label: {
                                Text("Iniciar sesión")
                                    .font(.caption).bold()
                                    .padding(.horizontal, 16).padding(.vertical, 8)
                                    .background(Color.rdBlue)
                                    .foregroundStyle(.white)
                                    .clipShape(Capsule())
                            }
                            Button {
                                authSheet = .pickRole
                            } label: {
                                Text("Crear cuenta")
                                    .font(.caption).bold()
                                    .padding(.horizontal, 16).padding(.vertical, 8)
                                    .background(Color.rdRed.opacity(0.1))
                                    .foregroundStyle(Color.rdRed)
                                    .clipShape(Capsule())
                                    .overlay(Capsule().stroke(Color.rdRed.opacity(0.3), lineWidth: 1))
                            }
                        }
                    }
                    .padding(.vertical, 4)
                }
            }

            // ── Account / Notifications / App ──
            Section {
                NavigationLink {
                    ProfileView()
                } label: {
                    Label("Account", systemImage: "person.fill")
                }
                NavigationLink {
                    NotificationSettingsView()
                } label: {
                    Label("Notifications", systemImage: "bell.fill")
                }
                NavigationLink {
                    AppSettingsView()
                } label: {
                    Label("App", systemImage: "gearshape.fill")
                }
                // Saved Homes — only for clients (not brokers/inmobiliarias)
                if !(api.currentUser?.isAgency ?? false) {
                    NavigationLink {
                        SavedListingsView()
                    } label: {
                        HStack {
                            Label("Saved Homes", systemImage: "heart.fill")
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
            if let user = api.currentUser, user.isAgency {
                // Broker / Inmobiliaria tools
                Section("Herramientas de Agente") {
                    NavigationLink {
                        if user.isTeamLead {
                            InmobiliariaDashboardView().environmentObject(api)
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
                    NavigationLink {
                        ConversationsView().environmentObject(api)
                    } label: {
                        Label("Mensajes", systemImage: "bubble.left.and.bubble.right.fill")
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
                }

                // Inmobiliaria-only team management
                if user.isInmobiliaria {
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
            } else {
                // Client / Renter tools
                Section("Herramientas de Cliente") {
                    NavigationLink {
                        ApplicationsView()
                    } label: {
                        Label("Mis aplicaciones", systemImage: "doc.text.fill")
                    }
                    NavigationLink {
                        ConnectorsView()
                    } label: {
                        Label("Conectores", systemImage: "link")
                    }
                }
            }

            // ── Support ──
            Section("Support") {
                Link(destination: URL(string: "https://hogaresrd.com/contacto")!) {
                    HStack {
                        Label("Help", systemImage: "questionmark.circle.fill")
                        Spacer()
                        Image(systemName: "arrow.up.right")
                            .font(.caption2)
                            .foregroundStyle(.tertiary)
                    }
                }
                Link(destination: URL(string: "https://hogaresrd.com/terminos")!) {
                    HStack {
                        Label("Terms of Use", systemImage: "doc.text.fill")
                        Spacer()
                        Image(systemName: "arrow.up.right")
                            .font(.caption2)
                            .foregroundStyle(.tertiary)
                    }
                }
                Link(destination: URL(string: "https://hogaresrd.com/privacidad")!) {
                    HStack {
                        Label("Privacy Notice", systemImage: "lock.shield.fill")
                        Spacer()
                        Image(systemName: "arrow.up.right")
                            .font(.caption2)
                            .foregroundStyle(.tertiary)
                    }
                }
            }

            // ── Logout ──
            if api.currentUser != nil {
                Section {
                    Button(role: .destructive) {
                        api.logout()
                    } label: {
                        Label("Cerrar sesión", systemImage: "rectangle.portrait.and.arrow.right")
                            .foregroundStyle(Color.rdRed)
                    }
                }
            }
        }
        .navigationTitle("Profile")
        .navigationBarTitleDisplayMode(.inline)
        .sheet(item: $authSheet) { mode in
            AuthView(initialMode: mode).environmentObject(api)
        }
    }
}

// MARK: - Settings Views

struct NotificationSettingsView: View {
    @EnvironmentObject var api: APIService
    @StateObject private var pushService = PushNotificationService.shared

    @State private var pushEnabled = false
    @State private var loading = false
    @State private var errorMsg: String?
    // Guard to ignore `.onChange` fired by our own programmatic reverts.
    @State private var suppressToggleChange = false

    // In-app notification preferences — explicit UserDefaults read/write.
    // We had issues where @AppStorage toggles wouldn't persist across app
    // launches; manual handling guarantees writes commit.
    private static let defaults: [String: Bool] = [
        "notif_newListings": true,
        "notif_priceDrops": true,
        "notif_similar": false,
        "notif_agentMessages": true,
        "notif_appUpdates": false,
    ]
    private static func loadBool(_ key: String) -> Bool {
        if UserDefaults.standard.object(forKey: key) == nil {
            return defaults[key] ?? false
        }
        return UserDefaults.standard.bool(forKey: key)
    }
    @State private var newListings: Bool   = Self.loadBool("notif_newListings")
    @State private var priceDrops: Bool    = Self.loadBool("notif_priceDrops")
    @State private var similar: Bool       = Self.loadBool("notif_similar")
    @State private var agentMessages: Bool = Self.loadBool("notif_agentMessages")
    @State private var appUpdates: Bool    = Self.loadBool("notif_appUpdates")

    var body: some View {
        listContent
            .navigationTitle("Notificaciones")
            .navigationBarTitleDisplayMode(.inline)
            .task { await initialLoad() }
            .onChange(of: pushEnabled, handlePushEnabledChange)
            .onChange(of: pushService.isAuthorized, handleAuthChange)
            .onChange(of: newListings)   { _, v in UserDefaults.standard.set(v, forKey: "notif_newListings") }
            .onChange(of: priceDrops)    { _, v in UserDefaults.standard.set(v, forKey: "notif_priceDrops") }
            .onChange(of: similar)       { _, v in UserDefaults.standard.set(v, forKey: "notif_similar") }
            .onChange(of: agentMessages) { _, v in UserDefaults.standard.set(v, forKey: "notif_agentMessages") }
            .onChange(of: appUpdates)    { _, v in UserDefaults.standard.set(v, forKey: "notif_appUpdates") }
    }

    private var listContent: some View {
        List {
            pushSection
            propertyAlertsSection
            generalSection
        }
    }

    private func handlePushEnabledChange(_ oldVal: Bool, _ newVal: Bool) {
        guard !suppressToggleChange else { return }
        Task { await togglePush(newVal) }
    }

    private func handleAuthChange(_ oldVal: Bool, _ newVal: Bool) {
        // Only force the toggle OFF when system auth goes away — when
        // system auth comes back, leave the toggle where the user left it
        // (their in-app intent). Otherwise we'd keep flipping it back on.
        if !newVal && pushEnabled {
            suppressToggleChange = true
            pushEnabled = false
            DispatchQueue.main.async { suppressToggleChange = false }
        }
    }

    // MARK: - Sections (split to help the Swift type-checker)

    @ViewBuilder
    private var pushSection: some View {
        Section {
            HStack(spacing: 14) {
                ZStack {
                    Circle().fill(Color.rdBlue.opacity(0.1)).frame(width: 44, height: 44)
                    Image(systemName: "bell.badge.fill").foregroundStyle(Color.rdBlue)
                }
                VStack(alignment: .leading, spacing: 3) {
                    Text("Notificaciones push").font(.subheadline).bold()
                    Text("Recibe alertas en tiempo real sobre propiedades, mensajes y actualizaciones.")
                        .font(.caption).foregroundStyle(.secondary)
                }
            }
            .padding(.vertical, 4)

            HStack {
                Label(pushEnabled ? "Activadas" : "Desactivadas",
                      systemImage: pushEnabled ? "bell.fill" : "bell.slash.fill")
                Spacer()
                if loading {
                    ProgressView()
                } else {
                    Toggle("", isOn: $pushEnabled).labelsHidden().disabled(loading)
                }
            }

            if !pushService.isAuthorized && pushEnabled == false {
                pushDeniedHint
            }

            if let err = errorMsg {
                Label(err, systemImage: "exclamationmark.triangle.fill")
                    .font(.caption).foregroundStyle(.red)
            }
        }
    }

    @ViewBuilder
    private var pushDeniedHint: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                Image(systemName: "info.circle.fill").foregroundStyle(.orange).font(.caption)
                Text("Las notificaciones push no estan habilitadas en los ajustes del sistema.")
                    .font(.caption).foregroundStyle(.secondary)
            }
            Button {
                if let url = URL(string: UIApplication.openSettingsURLString) {
                    UIApplication.shared.open(url)
                }
            } label: {
                Label("Abrir Ajustes", systemImage: "arrow.up.forward.app")
                    .font(.caption.bold()).foregroundStyle(Color.rdBlue)
            }
        }
    }

    @ViewBuilder
    private var propertyAlertsSection: some View {
        Section("Alertas de propiedades") {
            Toggle(isOn: $newListings) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Nuevas propiedades")
                    Text("Notificaciones de nuevos listados que coinciden con tus criterios")
                        .font(.caption).foregroundStyle(.secondary)
                }
            }
            Toggle(isOn: $priceDrops) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Bajas de precio")
                    Text("Alertas cuando bajan los precios de propiedades guardadas")
                        .font(.caption).foregroundStyle(.secondary)
                }
            }
            Toggle(isOn: $similar) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Propiedades similares")
                    Text("Sugerencias basadas en tus búsquedas recientes")
                        .font(.caption).foregroundStyle(.secondary)
                }
            }
        }
    }

    @ViewBuilder
    private var generalSection: some View {
        Section("General") {
            Toggle(isOn: $agentMessages) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Mensajes de agentes")
                    Text("Notificaciones cuando un agente te envía un mensaje")
                        .font(.caption).foregroundStyle(.secondary)
                }
            }
            Toggle(isOn: $appUpdates) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Actualizaciones de aplicación")
                    Text("Novedades y mejoras de HogaresRD")
                        .font(.caption).foregroundStyle(.secondary)
                }
            }
        }
    }

    // User's in-app intent for push (persisted). Default true — user wants
    // notifications unless they explicitly opt out. Toggle state is the AND
    // of (systemAuth.authorized, userIntent).
    private static let USER_INTENT_KEY = "push_user_enabled"
    private static func loadUserIntent() -> Bool {
        if UserDefaults.standard.object(forKey: USER_INTENT_KEY) == nil { return true }
        return UserDefaults.standard.bool(forKey: USER_INTENT_KEY)
    }
    private static func saveUserIntent(_ v: Bool) {
        UserDefaults.standard.set(v, forKey: USER_INTENT_KEY)
    }

    @MainActor
    private func initialLoad() async {
        let status = await pushService.refreshAuthorizationStatus()
        let userIntent = Self.loadUserIntent()
        // Toggle ON only when BOTH the system grants permission AND the
        // user hasn't opted out in-app. Otherwise it's OFF.
        suppressToggleChange = true
        pushEnabled = (status == .authorized) && userIntent
        DispatchQueue.main.async { self.suppressToggleChange = false }
        newListings   = Self.loadBool("notif_newListings")
        priceDrops    = Self.loadBool("notif_priceDrops")
        similar       = Self.loadBool("notif_similar")
        agentMessages = Self.loadBool("notif_agentMessages")
        appUpdates    = Self.loadBool("notif_appUpdates")
    }

    @MainActor
    private func togglePush(_ enable: Bool) async {
        loading = true
        errorMsg = nil

        // Always persist the user's in-app intent — this survives app
        // restarts even when the system permission remains granted.
        Self.saveUserIntent(enable)

        if enable {
            if pushService.authStatus == .denied {
                errorMsg = "Activa las notificaciones en Ajustes > HogaresRD."
                suppressToggleChange = true
                pushEnabled = false
                DispatchQueue.main.async { self.suppressToggleChange = false }
                loading = false
                return
            }
            let granted = await pushService.requestPermission()
            if !granted {
                errorMsg = "Permiso denegado. Habilita las notificaciones en Ajustes > HogaresRD."
                suppressToggleChange = true
                pushEnabled = false
                DispatchQueue.main.async { self.suppressToggleChange = false }
            }
            loading = false
        } else {
            do {
                try await api.unregisterPushToken()
            } catch {
                errorMsg = "Error al desactivar notificaciones."
            }
            loading = false
        }
    }
}

struct AppSettingsView: View {
    @AppStorage("appColorScheme") private var schemePref: String = "system"

    var body: some View {
        List {
            Section("Apariencia") {
                Picker(selection: $schemePref) {
                    Label("Sistema", systemImage: "circle.lefthalf.filled").tag("system")
                    Label("Claro",   systemImage: "sun.max.fill").tag("light")
                    Label("Oscuro",  systemImage: "moon.fill").tag("dark")
                } label: {
                    Label("Tema", systemImage: "paintbrush.fill")
                }
                .pickerStyle(.menu)
            }
            Section("Sobre") {
                HStack {
                    Text("Versión")
                    Spacer()
                    Text("1.0.0").foregroundStyle(.secondary)
                }
            }
        }
        .navigationTitle("App")
    }
}

struct ConnectorsView: View {
    var body: some View {
        List {
            Section {
                HStack(spacing: 14) {
                    ZStack {
                        Circle().fill(Color.rdGreen.opacity(0.1)).frame(width: 44, height: 44)
                        Image(systemName: "link.badge.plus")
                            .foregroundStyle(Color.rdGreen)
                    }
                    VStack(alignment: .leading, spacing: 3) {
                        Text("Conecta tus servicios")
                            .font(.subheadline).bold()
                        Text("Vincula cuentas bancarias, verificación de identidad y más para agilizar tus aplicaciones.")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
                .padding(.vertical, 4)
            }
        }
        .navigationTitle("Connectors")
    }
}
