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
                            if user.isAgency {
                                Label("Agente Inmobiliario", systemImage: "building.2.fill")
                                    .font(.caption2).bold()
                                    .foregroundStyle(Color.rdBlue)
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
                                authSheet = .register
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

            // ── Account / Notifications / App / Saved Homes ──
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

            // ── Renters Tools ──
            Section("Renters Tools") {
                NavigationLink {
                    ApplicationsView()
                } label: {
                    Label("Application", systemImage: "doc.text.fill")
                }
                NavigationLink {
                    ConnectorsView()
                } label: {
                    Label("Connectors", systemImage: "link")
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
    var body: some View {
        List {
            Section("Alertas de propiedades") {
                Toggle("Nuevas propiedades", isOn: .constant(true))
                Toggle("Bajas de precio", isOn: .constant(true))
                Toggle("Propiedades similares", isOn: .constant(false))
            }
            Section("General") {
                Toggle("Mensajes de agentes", isOn: .constant(true))
                Toggle("Actualizaciones de aplicación", isOn: .constant(false))
            }
        }
        .navigationTitle("Notifications")
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
