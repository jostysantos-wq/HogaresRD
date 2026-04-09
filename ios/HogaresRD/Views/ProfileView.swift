import SwiftUI
import PhotosUI

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
                    AvatarView(user: user, size: 64, editable: true)
                        .environmentObject(api)
                    VStack(alignment: .leading, spacing: 3) {
                        Text(user.name)
                            .font(.title3).bold()
                        Text(user.email)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        if user.isConstructora {
                            Label("Constructora", systemImage: "hammer.fill")
                                .font(.caption2).bold()
                                .foregroundStyle(Color(red: 0.7, green: 0.35, blue: 0.04))
                        } else if user.isInmobiliaria {
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

            // ── Subscription ──
            Section("Plan") {
                NavigationLink {
                    SubscriptionView().environmentObject(api)
                } label: {
                    HStack {
                        Label("Suscripción", systemImage: "crown.fill")
                            .foregroundStyle(.primary)
                        Spacer()
                        if user.isAgency {
                            Text(subscriptionLabel(user))
                                .font(.caption).bold()
                                .foregroundStyle(.white)
                                .padding(.horizontal, 8).padding(.vertical, 3)
                                .background(subscriptionColor(user))
                                .clipShape(Capsule())
                        } else {
                            Text("Gratis")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                    }
                }
            }

            // ── Security & Account ──
            Section("Seguridad") {
                NavigationLink {
                    ChangePasswordView().environmentObject(api)
                } label: {
                    Label("Cambiar contraseña", systemImage: "lock.fill")
                }
                NavigationLink {
                    TwoFactorSettingsView().environmentObject(api)
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
        .sheet(item: $authSheet) { mode in
            AuthView(initialMode: mode)
                .environmentObject(api)
                .id(mode) // Force SwiftUI to recreate the view (not reuse stale @State)
        }
        .navigationTitle("Perfil")
    }

    private func subscriptionLabel(_ user: User) -> String {
        switch user.role {
        case "broker", "agency": return "Broker"
        case "inmobiliaria": return "Inmobiliaria"
        case "constructora": return "Constructora"
        default: return "Activo"
        }
    }

    private func subscriptionColor(_ user: User) -> Color {
        switch user.role {
        case "broker", "agency": return Color(red: 0.16, green: 0.65, blue: 0.45)
        case "inmobiliaria": return Color(red: 0.55, green: 0.27, blue: 0.68)
        case "constructora": return Color(red: 0.7, green: 0.35, blue: 0.04)
        default: return .blue
        }
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
    @EnvironmentObject var api: APIService
    @State private var twoFAEnabled = false
    @State private var loading = true
    @State private var showEnableSheet = false
    @State private var showDisableAlert = false
    @State private var enableSessionId = ""
    @State private var verifyCode = ""
    @State private var verifyLoading = false
    @State private var verifyError: String?
    @State private var disablePassword = ""
    @State private var disableLoading = false
    @State private var disableError: String?

    // Biometric
    @State private var biometricEnabled = false
    @State private var biometricLoading = false

    // Auto-lock
    @ObservedObject private var lockManager = AppLockManager.shared

    private let bio = BiometricService.shared
    private let timeoutOptions = [1, 2, 5, 10, 15]

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
                        Text("Añade una capa extra de seguridad. Se enviará un código a tu correo cada vez que inicies sesión.")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
                .padding(.vertical, 4)
            }

            if loading {
                Section { ProgressView() }
            } else {
                Section("Correo electrónico (OTP)") {
                    HStack {
                        Label(twoFAEnabled ? "Activado" : "Desactivado",
                              systemImage: twoFAEnabled ? "checkmark.shield.fill" : "shield.slash.fill")
                        Spacer()
                        Circle()
                            .fill(twoFAEnabled ? Color.green : Color.orange)
                            .frame(width: 10, height: 10)
                    }

                    Button {
                        if twoFAEnabled {
                            showDisableAlert = true
                        } else {
                            Task { await startEnable() }
                        }
                    } label: {
                        HStack {
                            Spacer()
                            Text(twoFAEnabled ? "Desactivar 2FA" : "Activar 2FA")
                                .bold()
                            Spacer()
                        }
                    }
                    .listRowBackground(twoFAEnabled ? Color.red : Color.rdBlue)
                    .foregroundStyle(.white)
                }

                if bio.isAvailable {
                    Section("\(bio.biometricLabel)") {
                        HStack {
                            Image(systemName: bio.biometricIcon)
                                .font(.title2)
                                .foregroundStyle(Color.rdBlue)
                            VStack(alignment: .leading, spacing: 2) {
                                Text("Iniciar sesion con \(bio.biometricLabel)")
                                    .font(.subheadline)
                                Text("Usa tu rostro o huella para acceder rapidamente")
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                            Spacer()
                            if biometricLoading {
                                ProgressView()
                            } else {
                                Toggle("", isOn: Binding(
                                    get: { biometricEnabled },
                                    set: { newVal in Task { await toggleBiometric(newVal) } }
                                ))
                                .labelsHidden()
                            }
                        }
                    }

                    Section("Bloqueo automatico") {
                        Toggle(isOn: $lockManager.lockEnabled) {
                            VStack(alignment: .leading, spacing: 2) {
                                Text("Bloquear al salir")
                                    .font(.subheadline)
                                Text("Requiere \(bio.biometricLabel) al volver a la app")
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                        }
                        .disabled(!biometricEnabled)

                        if lockManager.lockEnabled {
                            Picker("Tiempo de inactividad", selection: $lockManager.idleTimeoutMinutes) {
                                ForEach(timeoutOptions, id: \.self) { min in
                                    Text("\(min) min\(min > 1 ? "utos" : "uto")").tag(min)
                                }
                            }
                        }
                    }
                }
            }
        }
        .navigationTitle("Seguridad")
        .navigationBarTitleDisplayMode(.inline)
        .task { await loadStatus() }
        .sheet(isPresented: $showEnableSheet) {
            NavigationStack {
                VStack(spacing: 20) {
                    Image(systemName: "lock.shield.fill")
                        .font(.system(size: 44))
                        .foregroundStyle(Color.rdBlue)
                    Text("Ingresa el código enviado a tu correo")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)

                    TextField("000000", text: $verifyCode)
                        .keyboardType(.numberPad)
                        .multilineTextAlignment(.center)
                        .font(.system(size: 32, weight: .bold, design: .monospaced))
                        .frame(maxWidth: 200)
                        .padding()
                        .background(Color(.secondarySystemFill))
                        .clipShape(RoundedRectangle(cornerRadius: 14))
                        .onChange(of: verifyCode) { _, val in
                            verifyCode = String(val.filter(\.isNumber).prefix(6))
                        }

                    if let err = verifyError {
                        Text(err).font(.caption).foregroundStyle(.red)
                    }

                    Button {
                        Task { await confirmEnable() }
                    } label: {
                        if verifyLoading {
                            ProgressView().tint(.white)
                        } else {
                            Text("Confirmar")
                        }
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 12)
                    .background(verifyCode.count == 6 ? Color.rdBlue : Color.gray)
                    .foregroundStyle(.white)
                    .clipShape(RoundedRectangle(cornerRadius: 12))
                    .disabled(verifyCode.count != 6 || verifyLoading)

                    Spacer()
                }
                .padding()
                .navigationTitle("Verificar código")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .navigationBarLeading) {
                        Button("Cancelar") { showEnableSheet = false }
                    }
                }
            }
            .presentationDetents([.medium])
        }
        .alert("Desactivar 2FA", isPresented: $showDisableAlert) {
            SecureField("Contraseña", text: $disablePassword)
            Button("Cancelar", role: .cancel) { disablePassword = "" }
            Button("Desactivar", role: .destructive) {
                Task { await confirmDisable() }
            }
        } message: {
            Text("Ingresa tu contraseña para desactivar la verificación en dos pasos.")
        }
    }

    private func loadStatus() async {
        loading = true
        let user = api.currentUser
        twoFAEnabled = user?.twoFAEnabled ?? false
        if let email = user?.email {
            biometricEnabled = bio.hasBiometricToken(for: email)
        }
        loading = false
    }

    private func startEnable() async {
        do {
            enableSessionId = try await api.enable2FA()
            verifyCode = ""
            verifyError = nil
            showEnableSheet = true
        } catch {
            verifyError = error.localizedDescription
        }
    }

    private func confirmEnable() async {
        verifyLoading = true; verifyError = nil
        do {
            try await api.confirmEnable2FA(sessionId: enableSessionId, code: verifyCode)
            twoFAEnabled = true
            showEnableSheet = false
        } catch {
            verifyError = error.localizedDescription
            verifyCode = ""
        }
        verifyLoading = false
    }

    private func confirmDisable() async {
        do {
            try await api.disable2FA(password: disablePassword)
            twoFAEnabled = false
            disablePassword = ""
        } catch {
            disablePassword = ""
        }
    }

    private func toggleBiometric(_ enable: Bool) async {
        biometricLoading = true
        do {
            if enable {
                let authenticated = try await bio.authenticate(reason: "Habilitar \(bio.biometricLabel) para HogaresRD")
                guard authenticated else { biometricLoading = false; return }
                let bioToken = try await api.registerBiometric()
                if let email = api.currentUser?.email {
                    try bio.saveBiometricToken(bioToken, for: email)
                    bio.saveBiometricEmail(email)
                }
                biometricEnabled = true
            } else {
                try await api.revokeBiometric()
                if let email = api.currentUser?.email {
                    bio.deleteBiometricToken(for: email)
                }
                bio.clearBiometricEmail()
                biometricEnabled = false
            }
        } catch {
            print("Biometric toggle error: \(error)")
        }
        biometricLoading = false
    }
}

// MARK: - Privacy Settings

struct PrivacySettingsView: View {
    @EnvironmentObject var api: APIService
    // Persisted across app launches via UserDefaults.
    private static let defaults: [String: Bool] = [
        "priv_profileVisible": true,
        "priv_showOnlineStatus": true,
        "priv_shareActivity": false,
        "priv_allowAnalytics": true,
    ]
    private static func loadBool(_ key: String) -> Bool {
        if UserDefaults.standard.object(forKey: key) == nil {
            return defaults[key] ?? false
        }
        return UserDefaults.standard.bool(forKey: key)
    }

    @State private var profileVisible    = Self.loadBool("priv_profileVisible")
    @State private var showOnlineStatus  = Self.loadBool("priv_showOnlineStatus")
    @State private var shareActivity     = Self.loadBool("priv_shareActivity")
    @State private var allowAnalytics    = Self.loadBool("priv_allowAnalytics")
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
        .onChange(of: profileVisible)   { _, v in UserDefaults.standard.set(v, forKey: "priv_profileVisible"); syncPrivacy("profileVisible", v) }
        .onChange(of: showOnlineStatus) { _, v in UserDefaults.standard.set(v, forKey: "priv_showOnlineStatus"); syncPrivacy("showOnlineStatus", v) }
        .onChange(of: shareActivity)    { _, v in UserDefaults.standard.set(v, forKey: "priv_shareActivity"); syncPrivacy("shareActivity", v) }
        .onChange(of: allowAnalytics)   { _, v in UserDefaults.standard.set(v, forKey: "priv_allowAnalytics"); syncPrivacy("allowAnalytics", v) }
        .alert("¿Eliminar tu cuenta?", isPresented: $showDeleteAlert) {
            Button("Cancelar", role: .cancel) {}
            Button("Eliminar permanentemente", role: .destructive) {
                Task {
                    do {
                        try await api.deleteAccount()
                        api.logout()
                    } catch {
                        // Silent fail — user will stay logged in
                    }
                }
            }
        } message: {
            Text("Esta accion es permanente e irreversible. Se eliminaran todos tus datos, propiedades guardadas, conversaciones y documentos.")
        }
    }

    /// Sync a single privacy toggle to the server so it persists across
    /// platforms. Fire-and-forget — local UserDefaults is the source of
    /// truth for instant UI; server is the cross-device backup.
    private func syncPrivacy(_ key: String, _ value: Bool) {
        Task.detached {
            guard let url = URL(string: "\(apiBase)/api/user/profile") else { return }
            var req = URLRequest(url: url)
            req.httpMethod = "PATCH"
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            if let t = APIService.shared.token {
                req.setValue("Bearer \(t)", forHTTPHeaderField: "Authorization")
            }
            req.httpBody = try? JSONSerialization.data(withJSONObject: [key: value])
            _ = try? await URLSession.shared.data(for: req)
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

// MARK: - Agency Dashboard (My Portfolio with analytics)
struct AgencyDashboardView: View {
    @EnvironmentObject var api: APIService
    @State private var listings: [ListingAnalyticsItem] = []
    @State private var summary: ListingAnalyticsSummary?
    @State private var loading = true
    @State private var selectedListing: ListingAnalyticsItem?
    @State private var inventoryListing: ListingAnalyticsItem?
    @State private var showSubmit = false

    var body: some View {
        ScrollView {
            VStack(spacing: 16) {
                // ── Summary stats ─────────────────────────────
                if let s = summary {
                    HStack(spacing: 10) {
                        PortfolioStatPill(icon: "house.fill", value: "\(s.totalListings)", label: "Publicadas", color: .rdBlue)
                        PortfolioStatPill(icon: "eye.fill", value: formatCompact(s.totalViews), label: "Vistas", color: .rdGreen)
                        PortfolioStatPill(icon: "heart.fill", value: "\(s.totalFavorites)", label: "Favoritos", color: .rdRed)
                    }
                    .padding(.horizontal)
                }

                // ── Actions ───────────────────────────────────
                HStack(spacing: 10) {
                    Button {
                        showSubmit = true
                    } label: {
                        HStack(spacing: 6) {
                            Image(systemName: "plus.circle.fill")
                                .font(.caption)
                            Text("Publicar propiedad")
                                .font(.caption).bold()
                        }
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 12)
                        .background(Color.rdBlue)
                        .foregroundStyle(.white)
                        .clipShape(RoundedRectangle(cornerRadius: 10))
                    }
                    .buttonStyle(.plain)

                    Link(destination: URL(string: "https://hogaresrd.com/submit")!) {
                        HStack(spacing: 6) {
                            Image(systemName: "safari.fill")
                                .font(.caption)
                            Text("Publicar en web")
                                .font(.caption).bold()
                        }
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 12)
                        .background(Color(.secondarySystemFill))
                        .foregroundStyle(.primary)
                        .clipShape(RoundedRectangle(cornerRadius: 10))
                    }
                }
                .padding(.horizontal)

                Divider().padding(.horizontal)

                // ── Listings grid ─────────────────────────────
                if loading {
                    VStack(spacing: 14) {
                        ProgressView()
                        Text("Cargando propiedades...")
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.top, 60)
                } else if listings.isEmpty {
                    VStack(spacing: 14) {
                        Image(systemName: "house.slash")
                            .font(.system(size: 44))
                            .foregroundStyle(Color(.tertiaryLabel))
                        Text("Sin propiedades publicadas")
                            .font(.headline)
                            .foregroundStyle(.secondary)
                        Text("Publica tu primera propiedad para verla aqui con sus estadisticas.")
                            .font(.caption)
                            .foregroundStyle(.tertiary)
                            .multilineTextAlignment(.center)
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.top, 40)
                    .padding(.horizontal, 32)
                } else {
                    LazyVStack(spacing: 12) {
                        ForEach(listings) { listing in
                            MyListingCard(
                                listing: listing,
                                refToken: api.currentUser?.refToken,
                                onShare: { url in shareURL(url, title: listing.title, price: listing.priceFormatted) },
                                onInventory: { inventoryListing = listing }
                            )
                            .onTapGesture { selectedListing = listing }
                        }
                    }
                    .padding(.horizontal)
                }
            }
            .padding(.vertical)
        }
        .navigationTitle("Mi Portafolio")
        .task { await load(initial: true) }
        .refreshable { await load(initial: false) }
        .sheet(item: $selectedListing) { listing in
            ListingAnalyticsDetailView(listingId: listing.id)
                .environmentObject(api)
        }
        .sheet(isPresented: $showSubmit) {
            SubmitListingView().environmentObject(api)
        }
        .sheet(item: $inventoryListing) { listing in
            NavigationStack {
                InventoryManagementView(listingId: listing.id, listingTitle: listing.title)
                    .environmentObject(api)
            }
        }
    }

    private func load(initial: Bool = true) async {
        if initial { loading = true }
        do {
            async let s = api.getListingAnalyticsSummary()
            async let l = api.getListingAnalyticsList(sort: "views")
            summary = try await s
            listings = try await l
        } catch {
            print("Portfolio load error: \(error)")
        }
        loading = false
    }

    private func formatCompact(_ n: Int) -> String {
        if n >= 1_000_000 { return String(format: "%.1fM", Double(n) / 1_000_000) }
        if n >= 1_000 { return String(format: "%.1fk", Double(n) / 1_000) }
        return "\(n)"
    }

    private func shareURL(_ url: String, title: String, price: String) {
        let text = "\(title) – \(price)\n\(url)"
        let av = UIActivityViewController(activityItems: [text], applicationActivities: nil)
        if let scene = UIApplication.shared.connectedScenes.first as? UIWindowScene,
           let root = scene.windows.first?.rootViewController {
            root.present(av, animated: true)
        }
    }
}

// MARK: - My Listing Card (portfolio item with stats)

struct MyListingCard: View {
    let listing: ListingAnalyticsItem
    var refToken: String?
    var onShare: ((String) -> Void)?
    var onInventory: (() -> Void)?

    @State private var copied = false

    var body: some View {
        VStack(spacing: 0) {
            // Image
            if let img = listing.image, let url = URL(string: img) {
                AsyncImage(url: url) { phase in
                    switch phase {
                    case .success(let image):
                        image.resizable().aspectRatio(contentMode: .fill)
                    default:
                        Rectangle().fill(Color(.tertiarySystemFill))
                            .overlay(Image(systemName: "photo")
                                .font(.title2)
                                .foregroundStyle(Color(.quaternaryLabel)))
                    }
                }
                .frame(height: 160)
                .clipped()
            }

            VStack(spacing: 10) {
                // Title & location
                VStack(alignment: .leading, spacing: 3) {
                    HStack {
                        Text(listing.title)
                            .font(.subheadline).bold()
                            .lineLimit(1)
                        Spacer()
                        Image(systemName: "chart.bar.xaxis")
                            .font(.caption)
                            .foregroundStyle(Color.rdBlue)
                            .padding(5)
                            .background(Color.rdBlue.opacity(0.1))
                            .clipShape(Circle())
                    }
                    HStack(spacing: 4) {
                        Image(systemName: "mappin.circle")
                            .font(.system(size: 10))
                        Text("\(listing.city), \(listing.province)")
                            .font(.caption)
                    }
                    .foregroundStyle(.secondary)
                }

                // Stats row
                HStack(spacing: 0) {
                    StatPill(value: "\(listing.views)", label: "Vistas", color: .rdBlue)
                    StatPill(value: "\(listing.tours)", label: "Tours", color: .green)
                    StatPill(value: "\(listing.favorites)", label: "Favs", color: .red)
                    StatPill(value: "\(listing.conversion)%", label: "Conv.", color: .purple)
                }

                // Footer
                HStack {
                    Text(listing.priceFormatted)
                        .font(.subheadline).bold()
                        .foregroundStyle(Color.rdGreen)
                    Spacer()
                    // Inventory button
                    if let onInventory {
                        Button {
                            onInventory()
                        } label: {
                            HStack(spacing: 3) {
                                Image(systemName: "building.2")
                                    .font(.system(size: 9))
                                Text("Inventario")
                                    .font(.system(size: 10, weight: .bold))
                            }
                            .foregroundStyle(Color.rdBlue)
                            .padding(.horizontal, 8).padding(.vertical, 4)
                            .background(Color.rdBlue.opacity(0.08))
                            .clipShape(Capsule())
                        }
                        .buttonStyle(.plain)
                    }
                    Text("\(listing.daysOnMarket)d")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }

                // Affiliate link buttons
                if let ref = refToken, !ref.isEmpty {
                    HStack(spacing: 8) {
                        // Copy link
                        Button {
                            let url = "https://hogaresrd.com/listing/\(listing.id)?ref=\(ref)"
                            UIPasteboard.general.string = url
                            let impact = UIImpactFeedbackGenerator(style: .light)
                            impact.impactOccurred()
                            copied = true
                            DispatchQueue.main.asyncAfter(deadline: .now() + 2) { copied = false }
                        } label: {
                            HStack(spacing: 4) {
                                Image(systemName: copied ? "checkmark" : "link")
                                    .font(.system(size: 10, weight: .bold))
                                Text(copied ? "Copiado" : "Copiar enlace")
                                    .font(.system(size: 11, weight: .bold))
                            }
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 8)
                            .background(copied ? Color.rdGreen.opacity(0.12) : Color.rdBlue.opacity(0.08))
                            .foregroundStyle(copied ? Color.rdGreen : Color.rdBlue)
                            .clipShape(RoundedRectangle(cornerRadius: 8))
                            .overlay(
                                RoundedRectangle(cornerRadius: 8)
                                    .stroke(copied ? Color.rdGreen.opacity(0.3) : Color.rdBlue.opacity(0.2), style: StrokeStyle(lineWidth: 1, dash: [4]))
                            )
                        }
                        .buttonStyle(.plain)

                        // Share
                        Button {
                            let url = "https://hogaresrd.com/listing/\(listing.id)?ref=\(ref)"
                            onShare?(url)
                        } label: {
                            HStack(spacing: 4) {
                                Image(systemName: "square.and.arrow.up")
                                    .font(.system(size: 10, weight: .bold))
                                Text("Compartir")
                                    .font(.system(size: 11, weight: .bold))
                            }
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 8)
                            .background(Color.rdBlue)
                            .foregroundStyle(.white)
                            .clipShape(RoundedRectangle(cornerRadius: 8))
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
            .padding(12)
        }
        .background(Color(.secondarySystemGroupedBackground))
        .clipShape(RoundedRectangle(cornerRadius: 14))
        .shadow(color: .black.opacity(0.06), radius: 6, y: 2)
    }
}
