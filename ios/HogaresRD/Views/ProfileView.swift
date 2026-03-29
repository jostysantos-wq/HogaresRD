import SwiftUI

struct ProfileView: View {
    @EnvironmentObject var api:   APIService
    @EnvironmentObject var saved: SavedStore
    @State private var authSheet: AuthView.Mode? = nil
    @AppStorage("appColorScheme") private var schemePref: String = "system"

    var body: some View {
        NavigationStack {
            if let user = api.currentUser {
                loggedInView(user)
            } else {
                guestView
            }
        }
    }

    // MARK: - Logged In
    private func loggedInView(_ user: User) -> some View {
        List {
            // Avatar header
            Section {
                HStack(spacing: 16) {
                    ZStack {
                        Circle()
                            .fill(LinearGradient(colors: [Color.rdBlue, Color.rdBlue.opacity(0.7)],
                                                 startPoint: .topLeading, endPoint: .bottomTrailing))
                            .frame(width: 64, height: 64)
                        Text(user.initials)
                            .font(.title2).bold()
                            .foregroundStyle(.white)
                    }
                    VStack(alignment: .leading, spacing: 3) {
                        Text(user.name)
                            .font(.title3).bold()
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
                .padding(.vertical, 6)
            }

            // Account
            Section("Cuenta") {
                NavigationLink {
                    SavedListingsView().environmentObject(saved)
                } label: {
                    HStack {
                        Label("Mis favoritos", systemImage: "heart.fill")
                        Spacer()
                        if !saved.savedIDs.isEmpty {
                            Text("\(saved.savedIDs.count)")
                                .font(.caption).bold()
                                .foregroundStyle(.white)
                                .padding(.horizontal, 7).padding(.vertical, 3)
                                .background(Color.rdRed)
                                .clipShape(Capsule())
                        }
                    }
                }
                if user.isAgency {
                    NavigationLink {
                        AgencyDashboardView()
                    } label: {
                        Label("Mi portafolio", systemImage: "briefcase.fill")
                    }
                }
            }

            // Support
            Section("Ayuda") {
                Link(destination: URL(string: "https://hogaresrd.com/contacto")!) {
                    Label("Contactar soporte", systemImage: "message.fill")
                }
                Link(destination: URL(string: "https://hogaresrd.com/terminos")!) {
                    Label("Términos de uso", systemImage: "doc.text.fill")
                }
                Link(destination: URL(string: "https://hogaresrd.com/blog")!) {
                    Label("Blog HogaresRD", systemImage: "newspaper.fill")
                }
            }

            // Appearance
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

            // Logout
            Section {
                Button(role: .destructive) {
                    api.logout()
                } label: {
                    Label("Cerrar sesión", systemImage: "rectangle.portrait.and.arrow.right")
                        .foregroundStyle(Color.rdRed)
                }
            }
        }
        .navigationTitle("Mi Perfil")
    }

    // MARK: - Guest
    private var guestView: some View {
        VStack(spacing: 28) {
            Spacer()

            ZStack {
                Circle().fill(Color.rdBlue.opacity(0.08)).frame(width: 120, height: 120)
                Image(systemName: "person.circle")
                    .font(.system(size: 56))
                    .foregroundStyle(Color.rdBlue)
            }

            VStack(spacing: 10) {
                Text("Bienvenido a HogaresRD")
                    .font(.title2).bold()
                Text("Inicia sesión para guardar propiedades,\nrecibir actualizaciones y más.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
            }

            VStack(spacing: 12) {
                Button {
                    authSheet = .login
                } label: {
                    Text("Iniciar sesión")
                        .font(.headline)
                        .frame(maxWidth: .infinity)
                        .padding()
                        .background(Color.rdBlue)
                        .foregroundStyle(.white)
                        .clipShape(RoundedRectangle(cornerRadius: 14))
                }

                Button {
                    authSheet = .register
                } label: {
                    Text("Crear cuenta gratis")
                        .font(.headline)
                        .frame(maxWidth: .infinity)
                        .padding()
                        .background(Color.rdRed.opacity(0.1))
                        .foregroundStyle(Color.rdRed)
                        .clipShape(RoundedRectangle(cornerRadius: 14))
                        .overlay(
                            RoundedRectangle(cornerRadius: 14)
                                .stroke(Color.rdRed.opacity(0.3), lineWidth: 1.5)
                        )
                }
            }
            .padding(.horizontal, 32)

            Spacer()
        }
        .sheet(item: $authSheet) { mode in AuthView(initialMode: mode).environmentObject(api) }
        .navigationTitle("Perfil")
    }
}

// MARK: - Agency Dashboard
struct AgencyDashboardView: View {
    @EnvironmentObject var api: APIService

    var body: some View {
        List {
            if let user = api.currentUser, let agencyName = user.agencyName {
                Section {
                    let slug = agencyName.lowercased()
                        .replacingOccurrences(of: " ", with: "-")
                        .filter { ($0 >= "a" && $0 <= "z") || ($0 >= "0" && $0 <= "9") || $0 == "-" }
                    NavigationLink {
                        AgencyPortfolioView(slug: String(slug))
                    } label: {
                        Label("Ver mis propiedades publicadas", systemImage: "house.fill")
                    }
                }
            }

            Section("Publicar") {
                NavigationLink {
                    // Reuse SubmitListingView from HomeView
                    Text("Submit") // placeholder — SubmitListingView is modal-only
                } label: {
                    Label("Publicar nueva propiedad", systemImage: "plus.circle.fill")
                }
                Link(destination: URL(string: "https://hogaresrd.com/submit")!) {
                    Label("Publicar en el sitio web", systemImage: "safari.fill")
                }
            }

            Section("Ayuda") {
                Link(destination: URL(string: "https://hogaresrd.com/contacto")!) {
                    Label("Contactar soporte", systemImage: "message.fill")
                }
            }
        }
        .navigationTitle("Mi Portafolio")
    }
}
