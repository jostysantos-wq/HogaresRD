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
                        if user.isInmobiliaria {
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

    // In-app notification preferences (local)
    @AppStorage("notif_newListings")   private var newListings = true
    @AppStorage("notif_priceDrops")    private var priceDrops = true
    @AppStorage("notif_similar")       private var similar = false
    @AppStorage("notif_agentMessages") private var agentMessages = true
    @AppStorage("notif_appUpdates")    private var appUpdates = false

    var body: some View {
        List {
            // ── Push Notifications ──
            Section {
                HStack(spacing: 14) {
                    ZStack {
                        Circle().fill(Color.rdBlue.opacity(0.1)).frame(width: 44, height: 44)
                        Image(systemName: "bell.badge.fill")
                            .foregroundStyle(Color.rdBlue)
                    }
                    VStack(alignment: .leading, spacing: 3) {
                        Text("Notificaciones push")
                            .font(.subheadline).bold()
                        Text("Recibe alertas en tiempo real sobre propiedades, mensajes y actualizaciones.")
                            .font(.caption)
                            .foregroundStyle(.secondary)
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
                        Toggle("", isOn: Binding(
                            get: { pushEnabled },
                            set: { newVal in Task { await togglePush(newVal) } }
                        ))
                        .labelsHidden()
                    }
                }

                if !pushService.isAuthorized && pushEnabled == false {
                    HStack(spacing: 8) {
                        Image(systemName: "info.circle.fill")
                            .foregroundStyle(.orange)
                            .font(.caption)
                        Text("Las notificaciones push no están habilitadas en los ajustes del sistema.")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }

                if let err = errorMsg {
                    Label(err, systemImage: "exclamationmark.triangle.fill")
                        .font(.caption)
                        .foregroundStyle(.red)
                }
            }

            // ── Property alerts ──
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

            // ── General ──
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
        .navigationTitle("Notificaciones")
        .navigationBarTitleDisplayMode(.inline)
        .onAppear {
            pushService.checkAuthorizationStatus()
            pushEnabled = pushService.isAuthorized && pushService.deviceToken != nil
        }
    }

    private func togglePush(_ enable: Bool) async {
        loading = true
        errorMsg = nil

        if enable {
            let granted = await pushService.requestPermission()
            await MainActor.run {
                pushEnabled = granted
                if !granted {
                    errorMsg = "Permiso denegado. Habilita las notificaciones en Ajustes > HogaresRD."
                }
                loading = false
            }
        } else {
            do {
                try await api.unregisterPushToken()
                await MainActor.run {
                    pushEnabled = false
                    loading = false
                }
            } catch {
                await MainActor.run {
                    errorMsg = "Error al desactivar notificaciones."
                    loading = false
                }
            }
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
