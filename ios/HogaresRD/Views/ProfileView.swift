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
                .padding(.vertical, 6)
            }

            // ── Security & Account ──
            Section("Seguridad") {
                NavigationLink {
                    ChangePasswordView().environmentObject(api)
                } label: {
                    Label("Cambiar contraseña", systemImage: "lock.fill")
                }
                NavigationLink {
                    TwoFactorSettingsView()
                } label: {
                    HStack {
                        Label("Verificación en dos pasos", systemImage: "shield.lefthalf.filled.badge.checkmark")
                        Spacer()
                        Text("Desactivado")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
            }

            Section("Privacidad") {
                NavigationLink {
                    PrivacySettingsView()
                } label: {
                    Label("Privacidad y datos", systemImage: "hand.raised.fill")
                }
                NavigationLink {
                    ConnectedAppsView()
                } label: {
                    Label("Aplicaciones conectadas", systemImage: "app.badge.checkmark.fill")
                }
                NavigationLink {
                    ActiveSessionsView()
                } label: {
                    Label("Sesiones activas", systemImage: "iphone.and.arrow.forward")
                }
            }

            // ── Client-only section ──
            if !user.isAgency {
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
                    NavigationLink {
                        ConversationsView().environmentObject(api)
                    } label: {
                        Label("Mis mensajes", systemImage: "bubble.left.and.bubble.right.fill")
                    }
                    NavigationLink {
                        ApplicationsView().environmentObject(api)
                    } label: {
                        Label("Mis aplicaciones", systemImage: "doc.text.fill")
                    }
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
                    authSheet = .pickRole
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

// MARK: - Change Password View

struct ChangePasswordView: View {
    @EnvironmentObject var api: APIService
    @State private var currentPw = ""
    @State private var newPw = ""
    @State private var confirmPw = ""
    @State private var loading = false
    @State private var successMsg: String?
    @State private var errorMsg: String?

    var body: some View {
        List {
            Section {
                HStack(spacing: 14) {
                    ZStack {
                        Circle().fill(Color.rdBlue.opacity(0.1)).frame(width: 44, height: 44)
                        Image(systemName: "lock.rotation")
                            .foregroundStyle(Color.rdBlue)
                    }
                    VStack(alignment: .leading, spacing: 3) {
                        Text("Actualizar contraseña")
                            .font(.subheadline).bold()
                        Text("Por seguridad, usa una contraseña única que no uses en otros sitios.")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
                .padding(.vertical, 4)
            }

            Section("Contraseña actual") {
                SecureField("Ingresa tu contraseña actual", text: $currentPw)
            }

            Section("Nueva contraseña") {
                SecureField("Nueva contraseña", text: $newPw)
                SecureField("Confirmar nueva contraseña", text: $confirmPw)

                if !newPw.isEmpty {
                    PasswordRequirementsView(password: newPw, confirm: confirmPw)
                }
            }

            Section {
                if let err = errorMsg {
                    Label(err, systemImage: "exclamationmark.circle.fill")
                        .font(.caption)
                        .foregroundStyle(.red)
                }
                if let msg = successMsg {
                    Label(msg, systemImage: "checkmark.circle.fill")
                        .font(.caption)
                        .foregroundStyle(.green)
                }

                Button {
                    Task { await changePassword() }
                } label: {
                    HStack {
                        Spacer()
                        if loading {
                            ProgressView()
                        } else {
                            Text("Actualizar Contraseña")
                                .bold()
                        }
                        Spacer()
                    }
                }
                .disabled(!canSubmit)
                .listRowBackground(canSubmit ? Color.rdBlue : Color(.tertiarySystemFill))
                .foregroundStyle(canSubmit ? .white : .secondary)
            }
        }
        .navigationTitle("Cambiar Contraseña")
        .navigationBarTitleDisplayMode(.inline)
    }

    private var canSubmit: Bool {
        !currentPw.isEmpty && newPw.count >= 8 && newPw == confirmPw && !loading
    }

    private func changePassword() async {
        guard newPw == confirmPw else { errorMsg = "Las contraseñas no coinciden."; return }
        guard newPw.count >= 8 else { errorMsg = "Mínimo 8 caracteres."; return }
        loading = true; errorMsg = nil; successMsg = nil
        do {
            try await api.changePassword(current: currentPw, newPassword: newPw)
            successMsg = "Contraseña actualizada correctamente."
            currentPw = ""; newPw = ""; confirmPw = ""
        } catch {
            errorMsg = error.localizedDescription
        }
        loading = false
    }
}

struct PasswordRequirementsView: View {
    let password: String
    let confirm: String

    private var hasMinLength: Bool  { password.count >= 8 }
    private var hasUppercase: Bool  { password.rangeOfCharacter(from: .uppercaseLetters) != nil }
    private var hasLowercase: Bool  { password.rangeOfCharacter(from: .lowercaseLetters) != nil }
    private var hasDigit: Bool      { password.rangeOfCharacter(from: .decimalDigits) != nil }
    private var hasSpecial: Bool    { password.rangeOfCharacter(from: CharacterSet(charactersIn: "!@#$%^&*()_+-=[]{}|;':\",./<>?")) != nil }
    private var passwordsMatch: Bool { !confirm.isEmpty && password == confirm }

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            requirement("Mínimo 8 caracteres", met: hasMinLength)
            requirement("Una letra mayúscula", met: hasUppercase)
            requirement("Una letra minúscula", met: hasLowercase)
            requirement("Un número", met: hasDigit)
            requirement("Un carácter especial", met: hasSpecial)
            if !confirm.isEmpty {
                requirement("Las contraseñas coinciden", met: passwordsMatch)
            }
        }
        .font(.caption)
        .padding(.vertical, 4)
    }

    private func requirement(_ text: String, met: Bool) -> some View {
        HStack(spacing: 6) {
            Image(systemName: met ? "checkmark.circle.fill" : "circle")
                .foregroundStyle(met ? .green : Color(.tertiaryLabel))
                .font(.caption2)
            Text(text)
                .foregroundStyle(met ? .primary : .secondary)
        }
    }
}

// MARK: - Two-Factor Authentication Settings

struct TwoFactorSettingsView: View {
    @State private var twoFAEnabled = false
    @State private var showSetupSheet = false
    @State private var selectedMethod = "app"

    var body: some View {
        List {
            Section {
                HStack(spacing: 14) {
                    ZStack {
                        Circle().fill(Color.rdGreen.opacity(0.1)).frame(width: 44, height: 44)
                        Image(systemName: "shield.lefthalf.filled.badge.checkmark")
                            .foregroundStyle(Color.rdGreen)
                    }
                    VStack(alignment: .leading, spacing: 3) {
                        Text("Verificación en dos pasos")
                            .font(.subheadline).bold()
                        Text("Añade una capa extra de seguridad a tu cuenta. Se te pedirá un código además de tu contraseña.")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
                .padding(.vertical, 4)
            }

            Section("Estado") {
                HStack {
                    Label(twoFAEnabled ? "Activado" : "Desactivado",
                          systemImage: twoFAEnabled ? "checkmark.shield.fill" : "shield.slash.fill")
                    Spacer()
                    Circle()
                        .fill(twoFAEnabled ? Color.green : Color.orange)
                        .frame(width: 10, height: 10)
                }
            }

            Section("Métodos disponibles") {
                twoFAMethodRow(
                    icon: "iphone.gen3",
                    title: "App de autenticación",
                    subtitle: "Google Authenticator, Authy, etc.",
                    method: "app"
                )
                twoFAMethodRow(
                    icon: "message.fill",
                    title: "SMS",
                    subtitle: "Recibe un código por mensaje de texto",
                    method: "sms"
                )
                twoFAMethodRow(
                    icon: "envelope.fill",
                    title: "Correo electrónico",
                    subtitle: "Recibe un código a tu email registrado",
                    method: "email"
                )
            }

            Section {
                Button {
                    showSetupSheet = true
                } label: {
                    HStack {
                        Spacer()
                        Text(twoFAEnabled ? "Reconfigurar 2FA" : "Activar Verificación")
                            .bold()
                        Spacer()
                    }
                }
                .listRowBackground(Color.rdBlue)
                .foregroundStyle(.white)
            }

            if twoFAEnabled {
                Section {
                    Button(role: .destructive) {
                        twoFAEnabled = false
                    } label: {
                        Label("Desactivar verificación en dos pasos", systemImage: "shield.slash")
                    }
                }
            }
        }
        .navigationTitle("Verificación 2FA")
        .navigationBarTitleDisplayMode(.inline)
        .alert("Próximamente", isPresented: $showSetupSheet) {
            Button("OK") {}
        } message: {
            Text("La configuración de verificación en dos pasos estará disponible pronto.")
        }
    }

    private func twoFAMethodRow(icon: String, title: String, subtitle: String, method: String) -> some View {
        HStack(spacing: 12) {
            ZStack {
                RoundedRectangle(cornerRadius: 8)
                    .fill(Color(.tertiarySystemFill))
                    .frame(width: 36, height: 36)
                Image(systemName: icon)
                    .font(.system(size: 16))
                    .foregroundStyle(Color.rdBlue)
            }
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(.subheadline)
                Text(subtitle).font(.caption).foregroundStyle(.secondary)
            }
            Spacer()
            Image(systemName: selectedMethod == method ? "checkmark.circle.fill" : "circle")
                .foregroundStyle(selectedMethod == method ? Color.rdBlue : Color(.tertiaryLabel))
        }
        .contentShape(Rectangle())
        .onTapGesture { selectedMethod = method }
    }
}

// MARK: - Privacy Settings

struct PrivacySettingsView: View {
    @State private var profileVisible = true
    @State private var showOnlineStatus = true
    @State private var shareActivity = false
    @State private var allowAnalytics = true
    @State private var showDeleteAlert = false

    var body: some View {
        List {
            Section {
                HStack(spacing: 14) {
                    ZStack {
                        Circle().fill(Color(red: 0.4, green: 0.1, blue: 0.6).opacity(0.1)).frame(width: 44, height: 44)
                        Image(systemName: "hand.raised.fill")
                            .foregroundStyle(Color(red: 0.4, green: 0.1, blue: 0.6))
                    }
                    VStack(alignment: .leading, spacing: 3) {
                        Text("Privacidad y datos")
                            .font(.subheadline).bold()
                        Text("Controla quién ve tu información y cómo se usan tus datos.")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
                .padding(.vertical, 4)
            }

            Section("Visibilidad del perfil") {
                Toggle(isOn: $profileVisible) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Perfil público")
                        Text("Permite que otros usuarios vean tu perfil")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                }
                Toggle(isOn: $showOnlineStatus) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Estado en línea")
                        Text("Muestra cuando estás activo en la app")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                }
            }

            Section("Datos y analíticas") {
                Toggle(isOn: $shareActivity) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Compartir actividad")
                        Text("Comparte datos de uso para mejorar recomendaciones")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                }
                Toggle(isOn: $allowAnalytics) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Analíticas de uso")
                        Text("Ayúdanos a mejorar la app con datos anónimos")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                }
            }

            Section("Tus datos") {
                NavigationLink {
                    // Placeholder
                    VStack(spacing: 16) {
                        Image(systemName: "arrow.down.doc.fill")
                            .font(.system(size: 48))
                            .foregroundStyle(Color.rdBlue)
                        Text("Solicitar descarga de datos")
                            .font(.headline)
                        Text("Recibirás un archivo con todos tus datos personales almacenados en HogaresRD.")
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                            .multilineTextAlignment(.center)
                            .padding(.horizontal, 32)
                        Button {
                        } label: {
                            Text("Solicitar descarga")
                                .bold()
                                .frame(maxWidth: .infinity)
                                .padding()
                                .background(Color.rdBlue)
                                .foregroundStyle(.white)
                                .clipShape(RoundedRectangle(cornerRadius: 12))
                        }
                        .padding(.horizontal, 32)
                    }
                    .navigationTitle("Descargar datos")
                    .navigationBarTitleDisplayMode(.inline)
                } label: {
                    Label("Descargar mis datos", systemImage: "arrow.down.doc.fill")
                }
            }

            Section {
                Button(role: .destructive) {
                    showDeleteAlert = true
                } label: {
                    Label("Eliminar mi cuenta", systemImage: "trash.fill")
                }
            }
        }
        .navigationTitle("Privacidad")
        .navigationBarTitleDisplayMode(.inline)
        .alert("¿Eliminar tu cuenta?", isPresented: $showDeleteAlert) {
            Button("Cancelar", role: .cancel) {}
            Button("Eliminar", role: .destructive) {}
        } message: {
            Text("Esta acción es permanente. Se eliminarán todos tus datos, propiedades guardadas y conversaciones. Contacta soporte para proceder.")
        }
    }
}

// MARK: - Connected Apps

struct ConnectedAppsView: View {
    @State private var connectedApps: [ConnectedApp] = ConnectedApp.samples

    var body: some View {
        List {
            Section {
                HStack(spacing: 14) {
                    ZStack {
                        Circle().fill(Color.rdBlue.opacity(0.1)).frame(width: 44, height: 44)
                        Image(systemName: "app.badge.checkmark.fill")
                            .foregroundStyle(Color.rdBlue)
                    }
                    VStack(alignment: .leading, spacing: 3) {
                        Text("Apps con acceso a tu cuenta")
                            .font(.subheadline).bold()
                        Text("Estas aplicaciones tienen permiso para acceder a ciertos datos de tu cuenta HogaresRD.")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
                .padding(.vertical, 4)
            }

            if connectedApps.filter(\.isConnected).isEmpty {
                Section {
                    VStack(spacing: 12) {
                        Image(systemName: "app.dashed")
                            .font(.system(size: 36))
                            .foregroundStyle(Color(.tertiaryLabel))
                        Text("Sin aplicaciones conectadas")
                            .font(.subheadline).foregroundStyle(.secondary)
                        Text("No has autorizado ninguna aplicación externa a acceder a tu cuenta.")
                            .font(.caption).foregroundStyle(.tertiary)
                            .multilineTextAlignment(.center)
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 20)
                }
            } else {
                Section("Conectadas") {
                    ForEach(connectedApps.filter(\.isConnected)) { app in
                        connectedAppRow(app)
                    }
                }
            }

            Section("Disponibles") {
                ForEach(connectedApps.filter { !$0.isConnected }) { app in
                    connectedAppRow(app)
                }
            }
        }
        .navigationTitle("Apps Conectadas")
        .navigationBarTitleDisplayMode(.inline)
    }

    private func connectedAppRow(_ app: ConnectedApp) -> some View {
        HStack(spacing: 12) {
            ZStack {
                RoundedRectangle(cornerRadius: 10)
                    .fill(app.color.opacity(0.1))
                    .frame(width: 40, height: 40)
                Image(systemName: app.icon)
                    .font(.system(size: 18))
                    .foregroundStyle(app.color)
            }
            VStack(alignment: .leading, spacing: 2) {
                Text(app.name).font(.subheadline).bold()
                Text(app.description).font(.caption).foregroundStyle(.secondary)
                if app.isConnected, let date = app.connectedDate {
                    Text("Conectado \(date, style: .relative) atrás")
                        .font(.system(size: 10))
                        .foregroundStyle(.tertiary)
                }
            }
            Spacer()
            if app.isConnected {
                Image(systemName: "checkmark.circle.fill")
                    .foregroundStyle(.green)
            } else {
                Text("Conectar")
                    .font(.caption).bold()
                    .padding(.horizontal, 10).padding(.vertical, 5)
                    .background(Color.rdBlue.opacity(0.1))
                    .foregroundStyle(Color.rdBlue)
                    .clipShape(Capsule())
            }
        }
        .padding(.vertical, 2)
    }
}

struct ConnectedApp: Identifiable {
    let id = UUID()
    let name: String
    let description: String
    let icon: String
    let color: Color
    var isConnected: Bool
    var connectedDate: Date?

    static let samples: [ConnectedApp] = [
        ConnectedApp(name: "WhatsApp Business", description: "Comunicación con clientes", icon: "message.fill", color: .green, isConnected: false),
        ConnectedApp(name: "Google Calendar", description: "Sincroniza citas y visitas", icon: "calendar", color: .blue, isConnected: false),
        ConnectedApp(name: "DocuSign", description: "Firma digital de contratos", icon: "signature", color: .orange, isConnected: false),
        ConnectedApp(name: "Stripe", description: "Pagos y facturación", icon: "creditcard.fill", color: Color(red: 0.4, green: 0.1, blue: 0.6), isConnected: false),
        ConnectedApp(name: "Google Drive", description: "Almacenamiento de documentos", icon: "externaldrive.fill", color: .yellow, isConnected: false)
    ]
}

// MARK: - Active Sessions

struct ActiveSessionsView: View {
    @State private var sessions: [DeviceSession] = DeviceSession.samples

    var body: some View {
        List {
            Section {
                HStack(spacing: 14) {
                    ZStack {
                        Circle().fill(Color.orange.opacity(0.1)).frame(width: 44, height: 44)
                        Image(systemName: "iphone.and.arrow.forward")
                            .foregroundStyle(.orange)
                    }
                    VStack(alignment: .leading, spacing: 3) {
                        Text("Sesiones activas")
                            .font(.subheadline).bold()
                        Text("Estos dispositivos tienen sesión abierta con tu cuenta. Cierra sesión en los que no reconozcas.")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
                .padding(.vertical, 4)
            }

            Section("Sesión actual") {
                if let current = sessions.first(where: \.isCurrent) {
                    sessionRow(current, isCurrent: true)
                }
            }

            Section("Otras sesiones") {
                ForEach(sessions.filter { !$0.isCurrent }) { session in
                    sessionRow(session, isCurrent: false)
                }
            }

            if sessions.filter({ !$0.isCurrent }).count > 0 {
                Section {
                    Button(role: .destructive) {
                        sessions.removeAll { !$0.isCurrent }
                    } label: {
                        HStack {
                            Spacer()
                            Label("Cerrar todas las otras sesiones", systemImage: "xmark.circle.fill")
                                .bold()
                            Spacer()
                        }
                    }
                }
            }
        }
        .navigationTitle("Sesiones Activas")
        .navigationBarTitleDisplayMode(.inline)
    }

    private func sessionRow(_ session: DeviceSession, isCurrent: Bool) -> some View {
        HStack(spacing: 12) {
            ZStack {
                RoundedRectangle(cornerRadius: 8)
                    .fill(Color(.tertiarySystemFill))
                    .frame(width: 40, height: 40)
                Image(systemName: session.icon)
                    .font(.system(size: 18))
                    .foregroundStyle(isCurrent ? Color.rdGreen : .secondary)
            }
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Text(session.deviceName).font(.subheadline).bold()
                    if isCurrent {
                        Text("Actual")
                            .font(.system(size: 9)).bold()
                            .padding(.horizontal, 6).padding(.vertical, 2)
                            .background(Color.rdGreen.opacity(0.15))
                            .foregroundStyle(Color.rdGreen)
                            .clipShape(Capsule())
                    }
                }
                Text(session.location).font(.caption).foregroundStyle(.secondary)
                Text(session.lastActive, style: .relative)
                    .font(.system(size: 10)).foregroundStyle(.tertiary)
                + Text(" atrás").font(.system(size: 10)).foregroundStyle(.tertiary)
            }
            Spacer()
            if !isCurrent {
                Button {
                    sessions.removeAll { $0.id == session.id }
                } label: {
                    Image(systemName: "xmark.circle.fill")
                        .foregroundStyle(Color(.tertiaryLabel))
                }
                .buttonStyle(.plain)
            }
        }
        .padding(.vertical, 2)
    }
}

struct DeviceSession: Identifiable {
    let id = UUID()
    let deviceName: String
    let icon: String
    let location: String
    let lastActive: Date
    let isCurrent: Bool

    static let samples: [DeviceSession] = [
        DeviceSession(deviceName: "iPhone 16 Pro", icon: "iphone.gen3", location: "Santo Domingo, RD", lastActive: Date(), isCurrent: true),
        DeviceSession(deviceName: "MacBook Pro", icon: "laptopcomputer", location: "Santo Domingo, RD", lastActive: Date().addingTimeInterval(-3600 * 2), isCurrent: false),
        DeviceSession(deviceName: "Safari — Web", icon: "safari.fill", location: "Santiago, RD", lastActive: Date().addingTimeInterval(-3600 * 24), isCurrent: false)
    ]
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
