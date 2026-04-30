import SwiftUI
import AuthenticationServices

// MARK: - AuthView (root sheet)

struct AuthView: View {
    @EnvironmentObject var api: APIService
    @Environment(\.dismiss) var dismiss

    enum Mode: Identifiable, Hashable {
        case welcome, login, pickRole, registerUser, registerBroker, registerInmobiliaria, registerConstructora
        var id: String {
            switch self {
            case .welcome: return "welcome"
            case .login: return "login"
            case .pickRole: return "pickRole"
            case .registerUser: return "registerUser"
            case .registerBroker: return "registerBroker"
            case .registerInmobiliaria: return "registerInmobiliaria"
            case .registerConstructora: return "registerConstructora"
            }
        }
    }

    @State private var mode: Mode
    private let initialMode: Mode

    init(initialMode: Mode = .welcome) {
        self.initialMode = initialMode
        _mode = State(initialValue: initialMode)
    }

    @ViewBuilder
    private func modeTab(title: String, isActive: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(title)
                .font(.subheadline).bold()
                .foregroundStyle(isActive ? .white : .primary)
                .frame(maxWidth: .infinity)
                .padding(.vertical, 10)
                .background(isActive ? Color.rdBlue : Color.clear)
                .clipShape(RoundedRectangle(cornerRadius: 10))
        }
        .buttonStyle(.plain)
    }

    var body: some View {
        NavigationStack {
            Group {
                if mode == .welcome {
                    // Full-bleed welcome screen — design ported from
                    // Claude Design (ios-login.html). Replaces the old
                    // gradient header + tab picker for the entry view.
                    WelcomeLoginScreen(
                        onEmail:    { withAnimation(.easeInOut(duration: 0.22)) { mode = .login } },
                        onRegister: { withAnimation(.easeInOut(duration: 0.22)) { mode = .pickRole } },
                        onSuccess:  { dismiss() }
                    )
                } else {
                    // Existing chrome (header + tab picker + form) for
                    // login + register flows. Reachable from the
                    // welcome screen's "Iniciar sesión con Email" and
                    // "Regístrate" links.
                    ScrollView {
                        VStack(spacing: 0) {
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
                                    if mode == .pickRole {
                                        Text("Elige tu tipo de cuenta")
                                            .font(.subheadline)
                                            .foregroundStyle(.white.opacity(0.8))
                                    }
                                }
                                .padding(.vertical, 36)
                            }

                            if mode == .login || mode == .pickRole {
                                HStack(spacing: 0) {
                                    modeTab(title: "Iniciar sesión", isActive: mode == .login) {
                                        withAnimation(.easeInOut(duration: 0.18)) { mode = .login }
                                    }
                                    modeTab(title: "Crear cuenta", isActive: mode == .pickRole) {
                                        withAnimation(.easeInOut(duration: 0.18)) { mode = .pickRole }
                                    }
                                }
                                .background(Color(.systemGray6))
                                .clipShape(RoundedRectangle(cornerRadius: 10))
                                .padding()
                            }

                            switch mode {
                            case .welcome:
                                EmptyView() // handled above
                            case .login:
                                LoginForm(onSuccess: { dismiss() })
                            case .pickRole:
                                RolePickerView(
                                    onPickUser: { mode = .registerUser },
                                    onPickBroker: { mode = .registerBroker },
                                    onPickInmobiliaria: { mode = .registerInmobiliaria },
                                    onPickConstructora: { mode = .registerConstructora }
                                )
                            case .registerUser:
                                RegisterForm(
                                    onSuccess: { dismiss() },
                                    onBack: { mode = .pickRole }
                                )
                            case .registerBroker:
                                BrokerRegisterForm(
                                    onSuccess: { dismiss() },
                                    onBack: { mode = .pickRole }
                                )
                            case .registerInmobiliaria:
                                InmobiliariaRegisterForm(
                                    onSuccess: { dismiss() },
                                    onBack: { mode = .pickRole }
                                )
                            case .registerConstructora:
                                ConstructoraRegisterForm(
                                    onSuccess: { dismiss() },
                                    onBack: { mode = .pickRole }
                                )
                            }
                        }
                    }
                    .ignoresSafeArea(edges: .top)
                }
            }
            .onAppear { mode = initialMode }
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                if mode == .welcome {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("Cerrar") { dismiss() }
                            .foregroundStyle(.white)
                    }
                } else {
                    ToolbarItem(placement: .cancellationAction) {
                        Button(mode == .login ? "Cerrar" : "← Volver") {
                            if mode == .login {
                                // From login form go back to the welcome screen
                                withAnimation(.easeInOut(duration: 0.22)) { mode = .welcome }
                            } else {
                                dismiss()
                            }
                        }
                    }
                }
            }
            .toolbarBackground(mode == .welcome ? .hidden : .automatic, for: .navigationBar)
        }
    }
}

// MARK: - Welcome Login Screen
// Ported from Claude Design (hogaresrd/project/ios-login.html).
// Full-bleed architectural hero photo, dark gradient fade into a
// content panel with the brand mark, marquee headline, and three
// pill CTAs (Email / Apple / Google).

struct WelcomeLoginScreen: View {
    var onEmail: () -> Void
    var onRegister: () -> Void
    var onSuccess: () -> Void

    @EnvironmentObject var api: APIService
    @State private var error: String?
    @State private var loading = false
    @State private var showGoogleNotice = false

    // Same Unsplash hero used in the design mock. Falls back to a
    // dark blue gradient if the network request fails or the user is
    // offline — the rest of the layout doesn't depend on it.
    private static let heroURL = URL(string:
        "https://images.unsplash.com/photo-1600585154340-be6161a56a0c?w=1200&q=80"
    )!

    var body: some View {
        ZStack {
            Color(red: 14/255, green: 18/255, blue: 25/255)
                .ignoresSafeArea()

            // Hero photo — full bleed, occupies the top ~65% of the screen
            GeometryReader { geo in
                AsyncImage(url: Self.heroURL) { phase in
                    switch phase {
                    case .success(let image):
                        image
                            .resizable()
                            .aspectRatio(contentMode: .fill)
                    default:
                        LinearGradient(colors: [
                            Color(red: 0.08, green: 0.16, blue: 0.30),
                            Color(red: 0.04, green: 0.07, blue: 0.13)
                        ], startPoint: .top, endPoint: .bottom)
                    }
                }
                .frame(width: geo.size.width, height: geo.size.height * 0.65)
                .clipped()
            }
            .ignoresSafeArea(.all)

            // Gradient fade — transparent at the top of the panel,
            // solid #0E1219 by ~45% from the bottom of the screen
            LinearGradient(stops: [
                .init(color: .clear,                                                         location: 0.0),
                .init(color: Color(red: 14/255, green: 18/255, blue: 25/255).opacity(0.6),  location: 0.55),
                .init(color: Color(red: 14/255, green: 18/255, blue: 25/255),                location: 0.78)
            ], startPoint: .top, endPoint: .bottom)
            .ignoresSafeArea()

            // Bottom-anchored content panel
            VStack(alignment: .leading, spacing: 0) {
                Spacer(minLength: 0)

                // Brand mark — matches the small house glyph from the design
                ZStack {
                    Image(systemName: "house.fill")
                        .font(.system(size: 26, weight: .semibold))
                        .foregroundStyle(.white.opacity(0.95))
                }
                .padding(.bottom, 16)

                // Headline — three lines, middle line emphasised
                VStack(alignment: .leading, spacing: 0) {
                    Text("Encuentra tu")
                        .font(.system(size: 30, weight: .bold))
                    Text("Próximo Hogar")
                        .font(.system(size: 30, weight: .heavy))
                    Text("en República Dominicana")
                        .font(.system(size: 30, weight: .bold))
                }
                .foregroundStyle(.white)
                .lineSpacing(-2)
                .padding(.bottom, 32)

                // CTA stack
                VStack(spacing: 12) {
                    // Email — primary blue
                    Button(action: onEmail) {
                        HStack(spacing: 8) {
                            Image(systemName: "envelope.fill")
                                .font(.system(size: 15, weight: .semibold))
                            Text("Iniciar sesión con Email")
                                .font(.system(size: 16, weight: .semibold))
                        }
                        .foregroundStyle(.white)
                        .frame(maxWidth: .infinity)
                        .frame(height: 54)
                        .background(Color(red: 0/255, green: 106/255, blue: 255/255))
                        .clipShape(Capsule())
                    }
                    .buttonStyle(.plain)

                    // Apple — native button styled to match
                    SignInWithAppleButton(.continue) { request in
                        request.requestedScopes = [.fullName, .email]
                    } onCompletion: { result in
                        Task { await handleAppleSignIn(result) }
                    }
                    .signInWithAppleButtonStyle(.white)
                    .frame(height: 54)
                    .clipShape(Capsule())

                    // Google — visual placeholder; not yet wired to a real provider
                    Button {
                        showGoogleNotice = true
                    } label: {
                        HStack(spacing: 10) {
                            googleGlyph
                                .frame(width: 18, height: 18)
                            Text("Continuar con Google")
                                .font(.system(size: 16, weight: .semibold))
                        }
                        .foregroundStyle(.white)
                        .frame(maxWidth: .infinity)
                        .frame(height: 54)
                        .background(Color.white.opacity(0.10))
                        .overlay(
                            Capsule().strokeBorder(Color.white.opacity(0.18), lineWidth: 1.5)
                        )
                        .clipShape(Capsule())
                    }
                    .buttonStyle(.plain)
                }
                .padding(.bottom, 20)

                if let err = error {
                    Text(err)
                        .font(.footnote)
                        .foregroundStyle(.white)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 10)
                        .background(Color.red.opacity(0.20))
                        .clipShape(RoundedRectangle(cornerRadius: 12))
                        .padding(.bottom, 12)
                }

                // Sign-up
                HStack(spacing: 4) {
                    Text("¿No tienes cuenta?")
                        .foregroundStyle(.white.opacity(0.65))
                    Button(action: onRegister) {
                        Text("Regístrate")
                            .foregroundStyle(.white)
                            .underline()
                            .fontWeight(.semibold)
                    }
                    .buttonStyle(.plain)
                }
                .font(.system(size: 13.5))
                .frame(maxWidth: .infinity, alignment: .center)
                .padding(.bottom, 16)

                // Legal
                Text(legalText)
                    .font(.system(size: 11.5))
                    .foregroundStyle(.white.opacity(0.38))
                    .multilineTextAlignment(.center)
                    .lineSpacing(2)
                    .frame(maxWidth: .infinity, alignment: .center)
            }
            .padding(.horizontal, 26)
            .padding(.bottom, 32)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottom)
        }
        .alert("Próximamente", isPresented: $showGoogleNotice) {
            Button("Entendido", role: .cancel) {}
        } message: {
            Text("Iniciar sesión con Google estará disponible pronto. Por ahora puedes usar Email o Apple ID.")
        }
    }

    // Multi-color "G" — small inline glyph that matches the four-color
    // Google brand without bundling a full asset.
    private var googleGlyph: some View {
        ZStack {
            Image(systemName: "g.circle.fill")
                .resizable()
                .scaledToFit()
                .foregroundStyle(.white)
        }
    }

    private var legalText: AttributedString {
        var s = AttributedString("Al crear una cuenta aceptas nuestros Términos de Servicio y Política de Privacidad")
        if let r = s.range(of: "Términos de Servicio") {
            s[r].foregroundColor = .white.opacity(0.6)
            s[r].underlineStyle = .single
        }
        if let r = s.range(of: "Política de Privacidad") {
            s[r].foregroundColor = .white.opacity(0.6)
            s[r].underlineStyle = .single
        }
        return s
    }

    // ── Apple Sign-In wiring (mirrors LoginForm.handleAppleSignIn) ──
    private func handleAppleSignIn(_ result: Result<ASAuthorization, Error>) async {
        switch result {
        case .success(let auth):
            guard let credential = auth.credential as? ASAuthorizationAppleIDCredential,
                  let identityToken = credential.identityToken,
                  let tokenStr = String(data: identityToken, encoding: .utf8) else {
                self.error = "No se pudo obtener el token de Apple"
                return
            }
            loading = true; error = nil
            do {
                let fullName = [credential.fullName?.givenName, credential.fullName?.familyName]
                    .compactMap { $0 }.joined(separator: " ")
                try await api.loginWithApple(
                    identityToken: tokenStr,
                    name:  fullName.isEmpty ? nil : fullName,
                    email: credential.email
                )
                onSuccess()
            } catch {
                self.error = error.localizedDescription
            }
            loading = false
        case .failure(let err):
            if (err as NSError).code != ASAuthorizationError.canceled.rawValue {
                self.error = "Error de Apple Sign In: \(err.localizedDescription)"
            }
        }
    }
}

// MARK: - Role Picker

struct RolePickerView: View {
    var onPickUser: () -> Void
    var onPickBroker: () -> Void
    var onPickInmobiliaria: () -> Void
    var onPickConstructora: () -> Void = {}

    var body: some View {
        VStack(spacing: 14) {
            Text("¿Cómo usarás HogaresRD?")
                .font(.headline)
                .padding(.top, 8)

            // Cliente card
            RoleCard(
                icon: "person.fill",
                title: "Cliente",
                subtitle: "Busca propiedades, guarda favoritos y aplica a hogares en venta o alquiler.",
                badge: "Gratis",
                color: Color.rdBlue,
                action: onPickUser
            )

            // Agente / Broker card
            RoleCard(
                icon: "person.text.rectangle.fill",
                title: "Agente / Broker",
                subtitle: "Gestiona clientes, publica propiedades y haz seguimiento de tu pipeline de ventas.",
                badge: "Plan mensual",
                color: Color(red: 0.16, green: 0.65, blue: 0.45),
                action: onPickBroker
            )

            // Inmobiliaria card
            RoleCard(
                icon: "building.2.fill",
                title: "Inmobiliaria",
                subtitle: "Administra tu empresa, vincula agentes a tu equipo y supervisa todas las operaciones.",
                badge: "Plan mensual",
                color: Color(red: 0.55, green: 0.27, blue: 0.68),
                action: onPickInmobiliaria
            )

            // Constructora card
            RoleCard(
                icon: "hammer.fill",
                title: "Constructora",
                subtitle: "Publica proyectos, gestiona inventario de unidades, vincula agentes y controla entregas.",
                badge: "Plan mensual",
                color: Color(red: 0.7, green: 0.35, blue: 0.04),
                action: onPickConstructora
            )

            Text("Podrás cambiar tu tipo de cuenta más adelante desde ajustes.")
                .font(.caption2)
                .foregroundStyle(.tertiary)
                .multilineTextAlignment(.center)
                .padding(.top, 4)
        }
        .padding(.horizontal)
        .padding(.bottom, 32)
    }
}

struct RoleCard: View {
    let icon: String
    let title: String
    let subtitle: String
    var badge: String? = nil
    let color: Color
    var action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 14) {
                ZStack {
                    RoundedRectangle(cornerRadius: 12)
                        .fill(color)
                        .frame(width: 48, height: 48)
                    Image(systemName: icon)
                        .font(.system(size: 20))
                        .foregroundStyle(.white)
                }

                VStack(alignment: .leading, spacing: 3) {
                    HStack(spacing: 6) {
                        Text(title)
                            .font(.subheadline).bold()
                            .foregroundStyle(.primary)
                        if let badge {
                            Text(badge)
                                .font(.system(size: 9, weight: .bold))
                                .foregroundStyle(color)
                                .padding(.horizontal, 6)
                                .padding(.vertical, 2)
                                .background(color.opacity(0.12), in: Capsule())
                        }
                    }
                    Text(subtitle)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.leading)
                        .fixedSize(horizontal: false, vertical: true)
                }

                Spacer()

                Image(systemName: "chevron.right")
                    .font(.caption.bold())
                    .foregroundStyle(color)
            }
            .padding(14)
            .background(color.opacity(0.06))
            .clipShape(RoundedRectangle(cornerRadius: 14))
            .overlay(RoundedRectangle(cornerRadius: 14).stroke(color.opacity(0.2), lineWidth: 1))
        }
        .buttonStyle(.plain)
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
    @State private var show2FA = false
    @State private var twoFASessionId = ""
    @State private var twoFACode = ""
    @State private var twoFALoading = false
    @State private var twoFAError: String?
    @State private var showForgot = false

    private let bio = BiometricService.shared

    var body: some View {
        VStack(spacing: 16) {
            if !show2FA {
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

                // Forgot password link
                Button {
                    showForgot = true
                } label: {
                    Text("¿Olvidaste tu contraseña?")
                        .font(.caption).bold()
                        .foregroundStyle(Color.rdBlue)
                }
                .buttonStyle(.plain)
                .padding(.top, 2)

                // Biometric login button
                if bio.isAvailable, let savedEmail = bio.savedBiometricEmail(),
                   bio.hasBiometricToken(for: savedEmail) {
                    Button {
                        Task { await loginWithBiometric(savedEmail) }
                    } label: {
                        HStack(spacing: 8) {
                            Image(systemName: bio.biometricIcon)
                                .font(.title3)
                            Text("Iniciar con \(bio.biometricLabel)")
                                .font(.subheadline).bold()
                        }
                        .foregroundStyle(Color.rdBlue)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 12)
                        .background(Color.rdBlue.opacity(0.08))
                        .clipShape(RoundedRectangle(cornerRadius: 12))
                    }
                    .buttonStyle(.plain)
                }
                // Sign in with Apple — divider + button
                HStack {
                    Rectangle().fill(Color(.separator)).frame(height: 0.5)
                    Text("o").font(.caption).foregroundStyle(.secondary)
                    Rectangle().fill(Color(.separator)).frame(height: 0.5)
                }
                .padding(.vertical, 4)

                SignInWithAppleButton(.signIn) { request in
                    request.requestedScopes = [.fullName, .email]
                } onCompletion: { result in
                    Task { await handleAppleSignIn(result) }
                }
                .signInWithAppleButtonStyle(.black)
                .frame(height: 48)
                .clipShape(RoundedRectangle(cornerRadius: 12))

            } else {
                // 2FA Code Entry
                VStack(spacing: 16) {
                    Image(systemName: "lock.shield.fill")
                        .font(.system(size: 40))
                        .foregroundStyle(Color.rdBlue)

                    Text("Verificación en dos pasos")
                        .font(.headline)
                    Text("Ingresa el código de 6 dígitos enviado a tu correo")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)

                    TextField("000000", text: $twoFACode)
                        .keyboardType(.numberPad)
                        .multilineTextAlignment(.center)
                        .font(.system(size: 32, weight: .bold, design: .monospaced))
                        .frame(maxWidth: 200)
                        .padding()
                        .background(Color(.secondarySystemFill))
                        .clipShape(RoundedRectangle(cornerRadius: 14))
                        .onChange(of: twoFACode) { _, val in
                            twoFACode = String(val.filter(\.isNumber).prefix(6))
                        }

                    if let err = twoFAError { ErrorBanner(message: err) }

                    ActionButton(label: "Verificar", color: Color.rdBlue, loading: twoFALoading,
                                 disabled: twoFACode.count != 6) {
                        Task { await verify2FA() }
                    }

                    Button("Reenviar código") {
                        Task { await resend2FA() }
                    }
                    .font(.subheadline).bold()
                    .foregroundStyle(Color.rdBlue)

                    Button("← Volver") {
                        show2FA = false
                        twoFACode = ""
                        twoFAError = nil
                    }
                    .font(.caption)
                    .foregroundStyle(.secondary)
                }
            }
        }
        .padding(.horizontal)
        .padding(.bottom, 32)
        .sheet(isPresented: $showForgot) {
            ForgotPasswordSheet(prefillEmail: email).environmentObject(api)
        }
    }

    private func login() async {
        loading = true; error = nil
        do {
            let result = try await api.login(email: email, password: password)
            switch result {
            case .success:
                onSuccess()
            case .requires2FA(let sid, _):
                twoFASessionId = sid
                show2FA = true
            }
        } catch { self.error = error.localizedDescription }
        loading = false
    }

    private func handleAppleSignIn(_ result: Result<ASAuthorization, Error>) async {
        switch result {
        case .success(let auth):
            guard let credential = auth.credential as? ASAuthorizationAppleIDCredential,
                  let identityToken = credential.identityToken,
                  let tokenStr = String(data: identityToken, encoding: .utf8) else {
                self.error = "No se pudo obtener el token de Apple"
                return
            }
            loading = true; error = nil
            do {
                let fullName = [credential.fullName?.givenName, credential.fullName?.familyName]
                    .compactMap { $0 }.joined(separator: " ")
                try await api.loginWithApple(
                    identityToken: tokenStr,
                    name: fullName.isEmpty ? nil : fullName,
                    email: credential.email
                )
                onSuccess()
            } catch {
                self.error = error.localizedDescription
            }
            loading = false
        case .failure(let err):
            if (err as NSError).code != ASAuthorizationError.canceled.rawValue {
                self.error = "Error de Apple Sign In: \(err.localizedDescription)"
            }
        }
    }

    private func loginWithBiometric(_ savedEmail: String) async {
        loading = true; error = nil
        do {
            let authenticated = try await bio.authenticate(reason: "Inicia sesión en HogaresRD")
            guard authenticated else { loading = false; return }
            guard let bioToken = bio.getBiometricToken(for: savedEmail) else {
                error = "Token biométrico no encontrado"
                loading = false
                return
            }
            let result = try await api.loginWithBiometric(email: savedEmail, biometricToken: bioToken)
            switch result {
            case .success:
                onSuccess()
            case .requires2FA(let sid, _):
                email = savedEmail
                twoFASessionId = sid
                show2FA = true
            }
        } catch {
            self.error = error.localizedDescription
        }
        loading = false
    }

    private func verify2FA() async {
        twoFALoading = true; twoFAError = nil
        do {
            _ = try await api.verify2FA(sessionId: twoFASessionId, code: twoFACode)
            onSuccess()
        } catch {
            twoFAError = error.localizedDescription
            twoFACode = ""
        }
        twoFALoading = false
    }

    private func resend2FA() async {
        do {
            try await api.resend2FA(sessionId: twoFASessionId)
        } catch {
            twoFAError = error.localizedDescription
        }
    }
}

// MARK: - Forgot Password Sheet

struct ForgotPasswordSheet: View {
    let prefillEmail: String
    @EnvironmentObject var api: APIService
    @Environment(\.dismiss) var dismiss
    @State private var email: String = ""
    @State private var loading = false
    @State private var sent = false
    @State private var errorMsg: String?

    init(prefillEmail: String) {
        self.prefillEmail = prefillEmail
        _email = State(initialValue: prefillEmail)
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 20) {
                    ZStack {
                        Circle().fill(Color.rdBlue.opacity(0.1))
                            .frame(width: 72, height: 72)
                        Image(systemName: sent ? "envelope.badge.fill" : "key.fill")
                            .font(.system(size: 28))
                            .foregroundStyle(Color.rdBlue)
                    }
                    .padding(.top, 24)

                    if sent {
                        Text("Revisa tu correo")
                            .font(.title2).bold()
                        Text("Si ese correo está registrado, te enviamos un enlace para restablecer tu contraseña. El enlace expira en 1 hora.")
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                            .multilineTextAlignment(.center)
                            .padding(.horizontal, 8)
                        Button {
                            dismiss()
                        } label: {
                            Text("Entendido")
                                .font(.subheadline).bold()
                                .foregroundStyle(.white)
                                .frame(maxWidth: .infinity)
                                .padding(.vertical, 14)
                                .background(Color.rdBlue)
                                .clipShape(RoundedRectangle(cornerRadius: 12))
                        }
                        .buttonStyle(.plain)
                        .padding(.top, 8)
                    } else {
                        Text("Restablecer contraseña")
                            .font(.title2).bold()
                        Text("Ingresa tu correo y te enviaremos un enlace para crear una nueva contraseña.")
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                            .multilineTextAlignment(.center)
                            .padding(.horizontal, 8)

                        FloatingField(label: "Correo electrónico", text: $email)
                            .keyboardType(.emailAddress)
                            .autocorrectionDisabled()
                            .textInputAutocapitalization(.never)

                        if let err = errorMsg {
                            HStack {
                                Image(systemName: "exclamationmark.circle.fill")
                                    .foregroundStyle(Color.rdRed)
                                Text(err).font(.caption).foregroundStyle(Color.rdRed)
                            }
                        }

                        Button {
                            Task { await submit() }
                        } label: {
                            HStack {
                                if loading { ProgressView().tint(.white) }
                                Text(loading ? "Enviando…" : "Enviar enlace")
                                    .font(.subheadline).bold()
                                    .foregroundStyle(.white)
                            }
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 14)
                            .background(email.isEmpty || loading ? Color(.systemGray4) : Color.rdBlue)
                            .clipShape(RoundedRectangle(cornerRadius: 12))
                        }
                        .buttonStyle(.plain)
                        .disabled(email.isEmpty || loading)
                        .padding(.top, 8)
                    }

                    Spacer(minLength: 16)
                }
                .padding(.horizontal, 24)
            }
            .navigationTitle("")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancelar") { dismiss() }
                }
            }
        }
        .presentationDetents([.medium, .large])
    }

    @MainActor
    private func submit() async {
        loading = true
        errorMsg = nil
        do {
            try await api.forgotPassword(email: email.trimmingCharacters(in: .whitespaces))
            sent = true
        } catch {
            errorMsg = error.localizedDescription
        }
        loading = false
    }
}

// MARK: - User Register Form

struct RegisterForm: View {
    var onSuccess: () -> Void
    var onBack: () -> Void
    @EnvironmentObject var api: APIService
    @State private var name = ""
    @State private var email = ""
    @State private var phone = ""
    @State private var password = ""
    @State private var confirm = ""
    @State private var termsAccepted = false
    @State private var marketing = true
    @State private var loading = false
    @State private var error: String?

    var canSubmit: Bool {
        !name.isEmpty && !email.isEmpty && !password.isEmpty &&
        PasswordStrength.isValid(password) && password == confirm && termsAccepted
    }

    var body: some View {
        VStack(spacing: 16) {

            // Back button
            BackToRoleButton(action: onBack)

            // Role badge
            RoleBadge(icon: "person.fill", title: "Cuenta de Cliente", color: Color.rdBlue)

            Text("Gratis. Recibe recomendaciones personalizadas y guarda tus favoritas.")
                .font(.caption.bold())
                .foregroundStyle(.secondary)
                .frame(maxWidth: .infinity, alignment: .leading)

            // Quick register with Apple
            SignInWithAppleButton(.signUp) { request in
                request.requestedScopes = [.fullName, .email]
            } onCompletion: { result in
                Task { await handleAppleRegister(result) }
            }
            .signInWithAppleButtonStyle(.black)
            .frame(height: 48)
            .clipShape(RoundedRectangle(cornerRadius: 12))

            // Divider
            HStack {
                Rectangle().fill(Color.secondary.opacity(0.3)).frame(height: 1)
                Text("o completa el formulario")
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
                    .fixedSize()
                Rectangle().fill(Color.secondary.opacity(0.3)).frame(height: 1)
            }
            .padding(.vertical, 4)

            // Fields
            FloatingField(label: "Nombre completo", text: $name)
            FloatingField(label: "Correo electrónico", text: $email)
                .keyboardType(.emailAddress)
                .autocorrectionDisabled()
                .textInputAutocapitalization(.never)
            FloatingField(label: "Teléfono (opcional — para notificaciones SMS)", text: $phone)
                .keyboardType(.phonePad)

            SectionDivider(title: "Seguridad")

            FloatingField(label: "Contraseña", text: $password, isSecure: true)
            PasswordStrengthView(password: password)
            FloatingField(label: "Confirmar contraseña", text: $confirm, isSecure: true)

            // Terms
            Toggle(isOn: $termsAccepted) {
                Text("He leido y acepto los ")
                    .font(.caption.bold())
                    .foregroundStyle(.secondary)
                + Text("Terminos y Condiciones de Uso")
                    .font(.caption.bold())
                    .foregroundStyle(Color.rdBlue)
                    .underline()
                + Text(" de HogaresRD.")
                    .font(.caption.bold())
                    .foregroundStyle(.secondary)
            }
            .tint(Color.rdBlue)
            .padding(.horizontal, 4)

            // Marketing
            Toggle(isOn: $marketing) {
                Text("Quiero recibir ofertas, novedades y propiedades destacadas de HogaresRD por correo electronico. Puedo cancelar en cualquier momento.")
                    .font(.caption.bold())
                    .foregroundStyle(.secondary)
            }
            .tint(Color.rdBlue)
            .padding(.horizontal, 4)

            if let err = error { ErrorBanner(message: err) }

            ActionButton(label: "Crear Cuenta", color: Color.rdBlue, loading: loading,
                         disabled: !canSubmit) {
                Task { await register() }
            }
        }
        .padding(.horizontal)
        .padding(.bottom, 32)
    }

    private func register() async {
        guard password == confirm else { error = "Las contraseñas no coinciden."; return }
        guard PasswordStrength.isValid(password) else { error = "La contraseña no cumple los requisitos."; return }
        loading = true; error = nil
        do {
            _ = try await api.register(name: name, email: email, password: password, marketingOptIn: marketing)
            onSuccess()
        } catch { self.error = error.localizedDescription }
        loading = false
    }

    private func handleAppleRegister(_ result: Result<ASAuthorization, Error>) async {
        switch result {
        case .success(let auth):
            guard let credential = auth.credential as? ASAuthorizationAppleIDCredential,
                  let identityToken = credential.identityToken,
                  let tokenStr = String(data: identityToken, encoding: .utf8) else {
                self.error = "No se pudo obtener el token de Apple"
                return
            }
            loading = true; error = nil
            do {
                let fullName = [credential.fullName?.givenName, credential.fullName?.familyName]
                    .compactMap { $0 }.joined(separator: " ")
                try await api.loginWithApple(
                    identityToken: tokenStr,
                    name: fullName.isEmpty ? nil : fullName,
                    email: credential.email
                )
                onSuccess()
            } catch {
                self.error = error.localizedDescription
            }
            loading = false
        case .failure(let err):
            if (err as NSError).code != ASAuthorizationError.canceled.rawValue {
                self.error = "Error: \(err.localizedDescription)"
            }
        }
    }
}

// MARK: - Broker Register Form

struct BrokerRegisterForm: View {
    var onSuccess: () -> Void
    var onBack: () -> Void
    @EnvironmentObject var api: APIService

    @State private var name = ""
    @State private var email = ""
    @State private var phone = ""
    @State private var licenseNumber = ""
    @State private var jobTitle = ""
    @State private var customJobTitle = ""
    @State private var password = ""
    @State private var confirm = ""
    @State private var termsAccepted = false
    @State private var loading = false
    @State private var error: String?

    private static let jobTitles: [(category: String, titles: [String])] = [
        ("Ventas", ["Agente Inmobiliario", "Agente Senior", "Asesor de Ventas", "Ejecutivo de Ventas", "Director de Ventas"]),
        ("Gerencia", ["Gerente Comercial", "Gerente de Sucursal", "Coordinador de Operaciones", "Supervisor de Agentes"]),
        ("Dirección", ["Director General", "Socio / Propietario"]),
        ("Otro", ["Otro (especificar)"])
    ]

    var canSubmit: Bool {
        !name.isEmpty && !email.isEmpty && !phone.isEmpty &&
        !licenseNumber.isEmpty && !password.isEmpty &&
        PasswordStrength.isValid(password) && password == confirm && termsAccepted
    }

    var body: some View {
        VStack(spacing: 16) {

            BackToRoleButton(action: onBack)

            RoleBadge(icon: "person.text.rectangle.fill", title: "Agente Broker", color: Color(red: 0.16, green: 0.65, blue: 0.45))

            Text("Crea tu cuenta individual de agente. Puedes operar de forma independiente o afiliarte a una inmobiliaria desde tu dashboard.")
                .font(.caption.bold())
                .foregroundStyle(.secondary)
                .frame(maxWidth: .infinity, alignment: .leading)

            // Section: Personal info
            SectionDivider(title: "Información Personal")

            FloatingField(label: "Nombre completo *", text: $name)
            FloatingField(label: "Correo electrónico *", text: $email)
                .keyboardType(.emailAddress)
                .autocorrectionDisabled()
                .textInputAutocapitalization(.never)
            FloatingField(label: "Teléfono *", text: $phone)
                .keyboardType(.phonePad)
            FloatingField(label: "Número de licencia MIREX *", text: $licenseNumber)
                .autocorrectionDisabled()
                .textInputAutocapitalization(.never)
            Text("Licencia emitida por el Ministerio de Relaciones Exteriores")
                .font(.system(size: 10))
                .foregroundStyle(.tertiary)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.top, -10)

            // Job title picker
            VStack(alignment: .leading, spacing: 4) {
                Text("CARGO / TÍTULO")
                    .font(.system(size: 10, weight: .bold))
                    .foregroundStyle(Color(.tertiaryLabel))
                    .kerning(0.5)
                Menu {
                    Button("— Selecciona un cargo —") { jobTitle = "" }
                    ForEach(Self.jobTitles, id: \.category) { group in
                        Section(group.category) {
                            ForEach(group.titles, id: \.self) { title in
                                Button(title) { jobTitle = title }
                            }
                        }
                    }
                } label: {
                    HStack {
                        Text(jobTitle.isEmpty ? "— Selecciona un cargo —" : jobTitle)
                            .foregroundStyle(jobTitle.isEmpty ? Color(.placeholderText) : .primary)
                        Spacer()
                        Image(systemName: "chevron.up.chevron.down")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    .padding(.horizontal, 14)
                    .padding(.vertical, 12)
                    .background(Color(.secondarySystemBackground))
                    .clipShape(RoundedRectangle(cornerRadius: 10))
                }
            }

            if jobTitle == "Otro (especificar)" {
                FloatingField(label: "Especifica tu cargo", text: $customJobTitle)
            }

            // Section: Security
            SectionDivider(title: "Contraseña")

            FloatingField(label: "Contraseña *", text: $password, isSecure: true)
            PasswordStrengthView(password: password)
            FloatingField(label: "Confirmar contraseña *", text: $confirm, isSecure: true)

            // Info banner
            HStack(alignment: .top, spacing: 10) {
                Image(systemName: "person.badge.plus")
                    .foregroundStyle(Color(red: 0.16, green: 0.65, blue: 0.45))
                    .font(.callout)
                    .padding(.top, 1)
                Text("Como agente broker puedes gestionar tus propias aplicaciones. Si estas afiliado a una inmobiliaria, ellos tendran visibilidad total sobre tus aplicaciones y gestionaran los planes de pago.")
                    .font(.caption.bold())
                    .foregroundStyle(.secondary)
            }
            .padding()
            .background(Color(red: 0.16, green: 0.65, blue: 0.45).opacity(0.07))
            .clipShape(RoundedRectangle(cornerRadius: 10))

            // Terms
            Toggle(isOn: $termsAccepted) {
                Text("He leido y acepto los ")
                    .font(.caption.bold())
                    .foregroundStyle(.secondary)
                + Text("Terminos y Condiciones de Agente")
                    .font(.caption.bold())
                    .foregroundStyle(Color.rdBlue)
                    .underline()
                + Text(" de HogaresRD.")
                    .font(.caption.bold())
                    .foregroundStyle(.secondary)
            }
            .tint(Color.rdBlue)
            .padding(.horizontal, 4)

            if let err = error { ErrorBanner(message: err) }

            ActionButton(label: "Crear Cuenta de Agente Broker", color: Color(red: 0.16, green: 0.65, blue: 0.45),
                         loading: loading, disabled: !canSubmit) {
                Task { await registerBroker() }
            }
        }
        .padding(.horizontal)
        .padding(.bottom, 32)
    }

    private func registerBroker() async {
        guard password == confirm else { error = "Las contraseñas no coinciden."; return }
        guard PasswordStrength.isValid(password) else { error = "La contraseña no cumple los requisitos."; return }
        loading = true; error = nil
        let finalJobTitle = jobTitle == "Otro (especificar)" ? customJobTitle : jobTitle
        do {
            _ = try await api.registerBroker(
                name: name, email: email, password: password,
                phone: phone, licenseNumber: licenseNumber,
                jobTitle: finalJobTitle.isEmpty ? nil : finalJobTitle
            )
            onSuccess()
        } catch { self.error = error.localizedDescription }
        loading = false
    }
}

// MARK: - Inmobiliaria Register Form

struct InmobiliariaRegisterForm: View {
    var onSuccess: () -> Void
    var onBack: () -> Void
    @EnvironmentObject var api: APIService

    @State private var name = ""
    @State private var email = ""
    @State private var phone = ""
    @State private var companyName = ""
    @State private var licenseNumber = ""
    @State private var password = ""
    @State private var confirm = ""
    @State private var termsAccepted = false
    @State private var loading = false
    @State private var error: String?

    private let purpleColor = Color(red: 0.55, green: 0.27, blue: 0.68)

    var canSubmit: Bool {
        !name.isEmpty && !email.isEmpty && !phone.isEmpty &&
        !companyName.isEmpty && !licenseNumber.isEmpty &&
        !password.isEmpty && PasswordStrength.isValid(password) &&
        password == confirm && termsAccepted
    }

    var body: some View {
        VStack(spacing: 16) {

            BackToRoleButton(action: onBack)

            RoleBadge(icon: "building.2.fill", title: "Inmobiliaria", color: purpleColor)

            Text("Registra tu empresa inmobiliaria para supervisar a tu equipo de agentes brokers y gestionar todas las aplicaciones desde un solo lugar.")
                .font(.caption.bold())
                .foregroundStyle(.secondary)
                .frame(maxWidth: .infinity, alignment: .leading)

            // Feature list info box
            VStack(alignment: .leading, spacing: 10) {
                Text("Con una cuenta de Inmobiliaria puedes:")
                    .font(.caption).bold()
                    .foregroundStyle(purpleColor)
                featureRow("Aprobar o rechazar solicitudes de afiliación de agentes")
                featureRow("Ver todas las aplicaciones de tu equipo en tiempo real")
                featureRow("Gestionar planes de pagos y revisar comprobantes")
                featureRow("Acceder a analíticas consolidadas de todo tu equipo")
            }
            .padding()
            .background(purpleColor.opacity(0.07))
            .clipShape(RoundedRectangle(cornerRadius: 10))

            // Section: Contact person
            SectionDivider(title: "Contacto Responsable")

            FloatingField(label: "Nombre completo del responsable *", text: $name)
            FloatingField(label: "Correo electrónico *", text: $email)
                .keyboardType(.emailAddress)
                .autocorrectionDisabled()
                .textInputAutocapitalization(.never)
            FloatingField(label: "Teléfono *", text: $phone)
                .keyboardType(.phonePad)

            // Section: Company info
            SectionDivider(title: "Datos de la Empresa")

            FloatingField(label: "Nombre de la empresa *", text: $companyName)
            FloatingField(label: "Número de licencia MIREX *", text: $licenseNumber)
                .autocorrectionDisabled()
                .textInputAutocapitalization(.never)
            Text("Licencia emitida por el Ministerio de Relaciones Exteriores")
                .font(.system(size: 10))
                .foregroundStyle(.tertiary)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.top, -10)

            // Section: Security
            SectionDivider(title: "Contraseña")

            FloatingField(label: "Contraseña *", text: $password, isSecure: true)
            PasswordStrengthView(password: password)
            FloatingField(label: "Confirmar contraseña *", text: $confirm, isSecure: true)

            // Terms
            Toggle(isOn: $termsAccepted) {
                Text("He leido y acepto los ")
                    .font(.caption.bold())
                    .foregroundStyle(.secondary)
                + Text("Terminos y Condiciones")
                    .font(.caption.bold())
                    .foregroundStyle(Color.rdBlue)
                    .underline()
                + Text(" de HogaresRD para empresas inmobiliarias.")
                    .font(.caption.bold())
                    .foregroundStyle(.secondary)
            }
            .tint(Color.rdBlue)
            .padding(.horizontal, 4)

            if let err = error { ErrorBanner(message: err) }

            ActionButton(label: "Registrar Inmobiliaria",
                         color: purpleColor,
                         loading: loading, disabled: !canSubmit) {
                Task { await registerInmobiliaria() }
            }
        }
        .padding(.horizontal)
        .padding(.bottom, 32)
    }

    private func featureRow(_ text: String) -> some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: "checkmark.circle.fill")
                .font(.system(size: 13))
                .foregroundStyle(purpleColor)
                .padding(.top, 1)
            Text(text)
                .font(.caption)
                .foregroundStyle(.secondary)
        }
    }

    private func registerInmobiliaria() async {
        guard password == confirm else { error = "Las contraseñas no coinciden."; return }
        guard PasswordStrength.isValid(password) else { error = "La contraseña no cumple los requisitos."; return }
        loading = true; error = nil
        do {
            _ = try await api.registerInmobiliaria(
                name: name, email: email, password: password,
                phone: phone, companyName: companyName, licenseNumber: licenseNumber
            )
            onSuccess()
        } catch { self.error = error.localizedDescription }
        loading = false
    }
}

// MARK: - Constructora Register Form

struct ConstructoraRegisterForm: View {
    var onSuccess: () -> Void
    var onBack: () -> Void
    @EnvironmentObject var api: APIService

    @State private var name = ""
    @State private var email = ""
    @State private var phone = ""
    @State private var companyName = ""
    @State private var yearsExperience = ""
    @State private var password = ""
    @State private var confirm = ""
    @State private var termsAccepted = false
    @State private var loading = false
    @State private var error: String?

    private let orangeColor = Color(red: 0.7, green: 0.35, blue: 0.04)

    var canSubmit: Bool {
        !name.isEmpty && !email.isEmpty && !phone.isEmpty &&
        !companyName.isEmpty && !password.isEmpty &&
        PasswordStrength.isValid(password) && password == confirm && termsAccepted
    }

    var body: some View {
        VStack(spacing: 16) {
            BackToRoleButton(action: onBack)

            RoleBadge(icon: "hammer.fill", title: "Constructora", color: orangeColor)

            Text("Registra tu empresa constructora para publicar proyectos, gestionar inventario de unidades y vincular agentes de venta.")
                .font(.caption.bold())
                .foregroundStyle(.secondary)
                .frame(maxWidth: .infinity, alignment: .leading)

            SectionDivider(title: "Datos de la Empresa")

            FloatingField(label: "Nombre de la constructora *", text: $companyName)
            FloatingField(label: "Nombre del responsable *", text: $name)
            FloatingField(label: "Correo electronico *", text: $email)
                .keyboardType(.emailAddress)
                .autocorrectionDisabled()
                .textInputAutocapitalization(.never)
            FloatingField(label: "Telefono *", text: $phone)
                .keyboardType(.phonePad)
            FloatingField(label: "Anos de experiencia", text: $yearsExperience)
                .keyboardType(.numberPad)

            SectionDivider(title: "Contrasena")

            FloatingField(label: "Contrasena *", text: $password, isSecure: true)
            PasswordStrengthView(password: password)
            FloatingField(label: "Confirmar contrasena *", text: $confirm, isSecure: true)

            Toggle(isOn: $termsAccepted) {
                Text("He leido y acepto los ")
                    .font(.caption.bold())
                    .foregroundStyle(.secondary)
                + Text("Terminos y Condiciones")
                    .font(.caption.bold())
                    .foregroundStyle(Color.rdBlue)
                    .underline()
                + Text(" de HogaresRD para constructoras.")
                    .font(.caption.bold())
                    .foregroundStyle(.secondary)
            }
            .tint(Color.rdBlue)
            .padding(.horizontal, 4)

            if let err = error { ErrorBanner(message: err) }

            ActionButton(label: "Registrar Constructora", color: orangeColor,
                         loading: loading, disabled: !canSubmit) {
                Task { await registerConstructora() }
            }
        }
        .padding(.horizontal)
        .padding(.bottom, 32)
    }

    private func registerConstructora() async {
        guard password == confirm else { error = "Las contrasenas no coinciden."; return }
        guard PasswordStrength.isValid(password) else { error = "La contrasena no cumple los requisitos."; return }
        loading = true; error = nil
        do {
            _ = try await api.registerConstructora(
                name: name, email: email, password: password,
                phone: phone, companyName: companyName,
                yearsExperience: yearsExperience
            )
            onSuccess()
        } catch { self.error = error.localizedDescription }
        loading = false
    }
}

// MARK: - Password Strength

enum PasswordStrength {
    static func isValid(_ password: String) -> Bool {
        password.count >= 8 &&
        password.rangeOfCharacter(from: .uppercaseLetters) != nil &&
        password.rangeOfCharacter(from: .lowercaseLetters) != nil &&
        password.rangeOfCharacter(from: .decimalDigits) != nil &&
        password.rangeOfCharacter(from: CharacterSet(charactersIn: "!@#$%^&*()_+-=[]{}|;':\",./<>?")) != nil
    }

    static func score(_ password: String) -> Int {
        var s = 0
        if password.count >= 8 { s += 1 }
        if password.rangeOfCharacter(from: .uppercaseLetters) != nil { s += 1 }
        if password.rangeOfCharacter(from: .lowercaseLetters) != nil { s += 1 }
        if password.rangeOfCharacter(from: .decimalDigits) != nil { s += 1 }
        if password.rangeOfCharacter(from: CharacterSet(charactersIn: "!@#$%^&*()_+-=[]{}|;':\",./<>?")) != nil { s += 1 }
        return s
    }
}

struct PasswordStrengthView: View {
    let password: String

    private var score: Int { PasswordStrength.score(password) }

    private var barColor: Color {
        switch score {
        case 0...1: return .red
        case 2...3: return .orange
        case 4:     return .yellow
        default:    return .green
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            // Strength bars
            HStack(spacing: 4) {
                ForEach(0..<4, id: \.self) { i in
                    RoundedRectangle(cornerRadius: 2)
                        .fill(i < score ? barColor : Color(.systemGray5))
                        .frame(height: 4)
                }
            }

            // Requirements checklist
            VStack(alignment: .leading, spacing: 3) {
                requirementRow("8+ caracteres", met: password.count >= 8)
                requirementRow("Mayúscula", met: password.rangeOfCharacter(from: .uppercaseLetters) != nil)
                requirementRow("Minúscula", met: password.rangeOfCharacter(from: .lowercaseLetters) != nil)
                requirementRow("Número", met: password.rangeOfCharacter(from: .decimalDigits) != nil)
                requirementRow("Especial (!@#...)", met: password.rangeOfCharacter(from: CharacterSet(charactersIn: "!@#$%^&*()_+-=[]{}|;':\",./<>?")) != nil)
            }
        }
        .padding(.top, -6)
    }

    private func requirementRow(_ text: String, met: Bool) -> some View {
        HStack(spacing: 6) {
            Image(systemName: met ? "checkmark.circle.fill" : "xmark.circle")
                .font(.system(size: 11))
                .foregroundStyle(met ? .green : Color(.tertiaryLabel))
            Text(text)
                .font(.system(size: 11))
                .foregroundStyle(met ? .secondary : Color(.tertiaryLabel))
        }
    }
}

// MARK: - Shared Components

struct BackToRoleButton: View {
    var action: () -> Void
    var body: some View {
        Button(action: action) {
            HStack(spacing: 6) {
                Image(systemName: "chevron.left")
                    .font(.caption.bold())
                Text("Cambiar tipo de cuenta")
                    .font(.subheadline)
            }
            .foregroundStyle(Color.rdBlue)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .buttonStyle(.plain)
    }
}

struct RoleBadge: View {
    let icon: String
    let title: String
    let color: Color
    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: icon)
                .font(.system(size: 13))
                .foregroundStyle(.white)
                .frame(width: 26, height: 26)
                .background(color, in: RoundedRectangle(cornerRadius: 7))
            Text(title)
                .font(.subheadline).bold()
                .foregroundStyle(color)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 8)
        .background(color.opacity(0.08), in: Capsule())
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

struct FloatingField: View {
    let label: String
    @Binding var text: String
    var isSecure = false

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(label)
                .font(.system(size: 14, weight: .bold))
                .foregroundStyle(Color(.label))
            Group {
                if isSecure {
                    SecureField("", text: $text)
                } else {
                    TextField("", text: $text)
                }
            }
            .font(.system(size: 15))
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
