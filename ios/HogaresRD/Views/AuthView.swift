import SwiftUI

// MARK: - AuthView (root sheet)

struct AuthView: View {
    @EnvironmentObject var api: APIService
    @Environment(\.dismiss) var dismiss

    enum Mode: Identifiable {
        case login, register, registerAgency
        var id: String {
            switch self { case .login: return "login"; case .register: return "register"; case .registerAgency: return "agency" }
        }
    }

    var initialMode: Mode = .login
    @State private var mode: Mode = .login

    init(initialMode: Mode = .login) {
        self.initialMode = initialMode
        _mode = State(initialValue: initialMode)
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 0) {
                    // Header
                    ZStack {
                        LinearGradient(colors: [
                            Color(red: 0, green: 0.07, blue: 0.19), Color.rdBlue
                        ], startPoint: .topLeading, endPoint: .bottomTrailing)

                        VStack(spacing: 8) {
                            Image(systemName: "house.fill")
                                .font(.largeTitle)
                                .foregroundStyle(.white)
                            Text("HogaresRD")
                                .font(.title2).bold()
                                .foregroundStyle(.white)
                        }
                        .padding(.vertical, 36)
                    }

                    // Mode picker (only login / register at top level)
                    if mode != .registerAgency {
                        Picker("Modo", selection: Binding(
                            get: { mode == .login ? 0 : 1 },
                            set: { mode = $0 == 0 ? .login : .register }
                        )) {
                            Text("Iniciar sesión").tag(0)
                            Text("Crear cuenta").tag(1)
                        }
                        .pickerStyle(.segmented)
                        .padding()
                    }

                    switch mode {
                    case .login:
                        LoginForm(onSuccess: { dismiss() })
                    case .register:
                        RegisterForm(
                            onSuccess: { dismiss() },
                            onAgencyTap: { mode = .registerAgency }
                        )
                    case .registerAgency:
                        AgencyRegisterForm(
                            onSuccess: { dismiss() },
                            onBack: { mode = .register }
                        )
                    }
                }
            }
            .ignoresSafeArea(edges: .top)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cerrar") { dismiss() }
                }
            }
        }
    }
}

// MARK: - Login Form

struct LoginForm: View {
    var onSuccess: () -> Void
    @EnvironmentObject var api: APIService
    @State private var email = ""
    @State private var password = ""
    @State private var loading = false
    @State private var error: String?

    var body: some View {
        VStack(spacing: 16) {
            FloatingField(label: "Correo electrónico", text: $email)
                .keyboardType(.emailAddress)
                .autocorrectionDisabled()
                .textInputAutocapitalization(.never)
            FloatingField(label: "Contraseña", text: $password, isSecure: true)

            if let err = error { ErrorBanner(message: err) }

            ActionButton(label: "Iniciar sesión", color: Color.rdBlue, loading: loading,
                         disabled: email.isEmpty || password.isEmpty) {
                Task { await login() }
            }
        }
        .padding(.horizontal)
        .padding(.bottom, 32)
    }

    private func login() async {
        loading = true; error = nil
        do {
            _ = try await api.login(email: email, password: password)
            onSuccess()
        } catch { self.error = error.localizedDescription }
        loading = false
    }
}

// MARK: - Regular Register Form

struct RegisterForm: View {
    var onSuccess: () -> Void
    var onAgencyTap: () -> Void
    @EnvironmentObject var api: APIService
    @State private var name = ""
    @State private var email = ""
    @State private var password = ""
    @State private var confirm = ""
    @State private var termsAccepted = false
    @State private var marketing = true
    @State private var loading = false
    @State private var error: String?

    var canSubmit: Bool {
        !name.isEmpty && !email.isEmpty && !password.isEmpty && termsAccepted
    }

    var body: some View {
        VStack(spacing: 16) {

            // Agency callout
            Button(action: onAgencyTap) {
                HStack(spacing: 12) {
                    ZStack {
                        RoundedRectangle(cornerRadius: 10)
                            .fill(Color.rdBlue)
                            .frame(width: 40, height: 40)
                        Image(systemName: "building.2.fill")
                            .font(.system(size: 16))
                            .foregroundStyle(.white)
                    }
                    VStack(alignment: .leading, spacing: 2) {
                        Text("¿Eres agente o inmobiliaria?")
                            .font(.subheadline).bold()
                            .foregroundStyle(Color.rdBlue)
                        Text("Usa el registro especializado para acceder a herramientas de agente")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .multilineTextAlignment(.leading)
                    }
                    Spacer()
                    Image(systemName: "chevron.right")
                        .font(.caption)
                        .foregroundStyle(Color.rdBlue)
                }
                .padding()
                .background(Color.rdBlue.opacity(0.08))
                .clipShape(RoundedRectangle(cornerRadius: 12))
                .overlay(RoundedRectangle(cornerRadius: 12).stroke(Color.rdBlue.opacity(0.25), lineWidth: 1))
            }
            .buttonStyle(.plain)

            // Fields
            FloatingField(label: "Nombre completo", text: $name)
            FloatingField(label: "Correo electrónico", text: $email)
                .keyboardType(.emailAddress)
                .autocorrectionDisabled()
                .textInputAutocapitalization(.never)
            FloatingField(label: "Contraseña (mín. 8 caracteres)", text: $password, isSecure: true)
            FloatingField(label: "Confirmar contraseña", text: $confirm, isSecure: true)

            // Terms
            Toggle(isOn: $termsAccepted) {
                Text("He leído y acepto los ")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                + Text("Términos y Condiciones de Uso")
                    .font(.caption)
                    .foregroundStyle(Color.rdBlue)
                    .underline()
                + Text(" de HogaresRD.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            .tint(Color.rdBlue)
            .padding(.horizontal, 4)

            // Marketing
            Toggle(isOn: $marketing) {
                Text("Quiero recibir ofertas y novedades por correo. Puedo cancelar en cualquier momento.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            .tint(Color.rdBlue)
            .padding(.horizontal, 4)

            if let err = error { ErrorBanner(message: err) }

            ActionButton(label: "Crear cuenta", color: Color.rdRed, loading: loading,
                         disabled: !canSubmit) {
                Task { await register() }
            }
        }
        .padding(.horizontal)
        .padding(.bottom, 32)
    }

    private func register() async {
        guard password == confirm else { error = "Las contraseñas no coinciden."; return }
        guard password.count >= 8 else { error = "La contraseña debe tener al menos 8 caracteres."; return }
        loading = true; error = nil
        do {
            _ = try await api.register(name: name, email: email, password: password, marketingOptIn: marketing)
            onSuccess()
        } catch { self.error = error.localizedDescription }
        loading = false
    }
}

// MARK: - Agency Register Form

struct AgencyRegisterForm: View {
    var onSuccess: () -> Void
    var onBack: () -> Void
    @EnvironmentObject var api: APIService

    @State private var name = ""
    @State private var email = ""
    @State private var phone = ""
    @State private var agencyName = ""
    @State private var licenseNumber = ""
    @State private var password = ""
    @State private var confirm = ""
    @State private var termsAccepted = false
    @State private var loading = false
    @State private var error: String?

    var canSubmit: Bool {
        !name.isEmpty && !email.isEmpty && !phone.isEmpty &&
        !agencyName.isEmpty && !licenseNumber.isEmpty &&
        !password.isEmpty && termsAccepted
    }

    var body: some View {
        VStack(spacing: 16) {

            // Back banner
            Button(action: onBack) {
                HStack(spacing: 8) {
                    Image(systemName: "chevron.left")
                        .font(.caption.bold())
                    Text("Volver al registro normal")
                        .font(.subheadline)
                }
                .foregroundStyle(Color.rdBlue)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .buttonStyle(.plain)

            // Section: Personal info
            SectionDivider(title: "Información Personal")

            FloatingField(label: "Nombre completo *", text: $name)
            FloatingField(label: "Correo electrónico *", text: $email)
                .keyboardType(.emailAddress)
                .autocorrectionDisabled()
                .textInputAutocapitalization(.never)
            FloatingField(label: "Teléfono *", text: $phone)
                .keyboardType(.phonePad)

            // Section: Agency info
            SectionDivider(title: "Información de la Inmobiliaria")

            FloatingField(label: "Nombre de la inmobiliaria *", text: $agencyName)
            FloatingField(label: "Número de licencia MIREX *", text: $licenseNumber)
                .autocorrectionDisabled()
                .textInputAutocapitalization(.never)

            // Section: Security
            SectionDivider(title: "Seguridad")

            FloatingField(label: "Contraseña (mín. 8 caracteres) *", text: $password, isSecure: true)
            FloatingField(label: "Confirmar contraseña *", text: $confirm, isSecure: true)

            // Affiliate info banner
            HStack(alignment: .top, spacing: 10) {
                Image(systemName: "link.badge.plus")
                    .foregroundStyle(Color.rdBlue)
                    .font(.callout)
                    .padding(.top, 1)
                Text("Al registrarte recibirás un **código de agente único** que te permite generar enlaces afiliados. Cuando un cliente use tu enlace y envíe una consulta, el mensaje llegará **directamente a ti**.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            .padding()
            .background(Color.rdBlue.opacity(0.07))
            .clipShape(RoundedRectangle(cornerRadius: 10))

            // Terms
            Toggle(isOn: $termsAccepted) {
                Text("He leído y acepto los ")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                + Text("Términos y Condiciones de Agente")
                    .font(.caption)
                    .foregroundStyle(Color.rdBlue)
                    .underline()
                + Text(" de HogaresRD, incluyendo las responsabilidades sobre la veracidad de los anuncios y el uso del sistema de afiliados.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            .tint(Color.rdBlue)
            .padding(.horizontal, 4)

            if let err = error { ErrorBanner(message: err) }

            ActionButton(label: "Crear cuenta de agente", color: Color.rdBlue, loading: loading,
                         disabled: !canSubmit) {
                Task { await registerAgency() }
            }
        }
        .padding(.horizontal)
        .padding(.bottom, 32)
    }

    private func registerAgency() async {
        guard password == confirm else { error = "Las contraseñas no coinciden."; return }
        guard password.count >= 8 else { error = "La contraseña debe tener al menos 8 caracteres."; return }
        loading = true; error = nil
        do {
            _ = try await api.registerAgency(
                name: name, email: email, password: password,
                phone: phone, agencyName: agencyName, licenseNumber: licenseNumber
            )
            onSuccess()
        } catch { self.error = error.localizedDescription }
        loading = false
    }
}

// MARK: - Shared Components

struct FloatingField: View {
    let label: String
    @Binding var text: String
    var isSecure = false

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(label.uppercased())
                .font(.system(size: 10, weight: .bold))
                .foregroundStyle(Color(.tertiaryLabel))
                .kerning(0.5)
            Group {
                if isSecure {
                    SecureField("", text: $text)
                } else {
                    TextField("", text: $text)
                }
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 12)
            .background(Color(.secondarySystemBackground))
            .clipShape(RoundedRectangle(cornerRadius: 10))
        }
    }
}

struct SectionDivider: View {
    let title: String
    var body: some View {
        HStack {
            Rectangle().fill(Color(.separator)).frame(height: 1)
            Text(title)
                .font(.system(size: 11, weight: .bold))
                .foregroundStyle(.secondary)
                .fixedSize()
            Rectangle().fill(Color(.separator)).frame(height: 1)
        }
        .padding(.vertical, 4)
    }
}

struct ErrorBanner: View {
    let message: String
    var body: some View {
        HStack {
            Image(systemName: "exclamationmark.circle.fill").foregroundStyle(Color.rdRed)
            Text(message).font(.caption).foregroundStyle(Color.rdRed)
        }
        .padding(.horizontal)
    }
}

struct ActionButton: View {
    let label: String
    let color: Color
    let loading: Bool
    let disabled: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Group {
                if loading { ProgressView().tint(.white) }
                else { Text(label).fontWeight(.bold) }
            }
            .frame(maxWidth: .infinity)
            .padding()
            .background(disabled ? Color(.systemGray4) : color)
            .foregroundStyle(.white)
            .clipShape(RoundedRectangle(cornerRadius: 14))
        }
        .disabled(loading || disabled)
        .padding(.top, 4)
    }
}
