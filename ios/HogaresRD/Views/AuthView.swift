import SwiftUI
import AuthenticationServices

// MARK: - AuthView (root sheet)

struct AuthView: View {
    @EnvironmentObject var api: APIService
    @Environment(\.dismiss) var dismiss

    enum Mode: Identifiable, Hashable {
        case welcome, login, pickRole, registerBroker, registerInmobiliaria, registerConstructora
        var id: String {
            switch self {
            case .welcome: return "welcome"
            case .login: return "login"
            case .pickRole: return "pickRole"
            case .registerBroker: return "registerBroker"
            case .registerInmobiliaria: return "registerInmobiliaria"
            case .registerConstructora: return "registerConstructora"
            }
        }
    }

    @State private var mode: Mode
    @State private var prefill: RegisterPrefill?
    private let initialMode: Mode

    init(initialMode: Mode = .welcome) {
        self.initialMode = initialMode
        _mode = State(initialValue: initialMode)
    }

    private var isFullBleed: Bool {
        mode == .welcome || mode == .pickRole || mode == .login
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
                } else if mode == .pickRole {
                    // Full-bleed welcome register — design ported from
                    // Claude Design (ios-register.html). Replaces the old
                    // role-picker list with a single form: name / email /
                    // password / role dropdown / terms / CTA.
                    WelcomeRegisterScreen(
                        prefill: prefill,
                        onLogin:   { withAnimation(.easeInOut(duration: 0.22)) { mode = .login } },
                        onSuccess: { dismiss() },
                        onAdvancedRole: { newMode, p in
                            prefill = p
                            withAnimation(.easeInOut(duration: 0.22)) { mode = newMode }
                        }
                    )
                } else if mode == .login {
                    // Full-bleed login form — same hero / sheet layout as
                    // the register screen. Inline 2FA is handled by the
                    // screen itself (no separate mode).
                    WelcomeLoginFormScreen(
                        onRegister: { withAnimation(.easeInOut(duration: 0.22)) { mode = .pickRole } },
                        onSuccess:  { dismiss() }
                    )
                } else {
                    // Chrome shell — only the role-specific register
                    // flows (Broker / Inmobiliaria / Constructora) still
                    // use this layout because they need a long scrolling
                    // form with section dividers and a section header.
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
                                }
                                .padding(.vertical, 36)
                            }

                            switch mode {
                            case .welcome, .pickRole, .login:
                                EmptyView() // handled above
                            case .registerBroker:
                                BrokerRegisterForm(
                                    onSuccess: { dismiss() },
                                    onBack: { withAnimation(.easeInOut(duration: 0.22)) { mode = .pickRole } },
                                    prefill: prefill
                                )
                            case .registerInmobiliaria:
                                InmobiliariaRegisterForm(
                                    onSuccess: { dismiss() },
                                    onBack: { withAnimation(.easeInOut(duration: 0.22)) { mode = .pickRole } },
                                    prefill: prefill
                                )
                            case .registerConstructora:
                                ConstructoraRegisterForm(
                                    onSuccess: { dismiss() },
                                    onBack: { withAnimation(.easeInOut(duration: 0.22)) { mode = .pickRole } },
                                    prefill: prefill
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
                } else if mode == .pickRole || mode == .login {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("← Volver") {
                            withAnimation(.easeInOut(duration: 0.22)) { mode = .welcome }
                        }
                        .foregroundStyle(.white)
                        .accessibilityLabel("Volver")
                    }
                } else {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("← Volver") { dismiss() }
                            .accessibilityLabel("Volver")
                    }
                }
            }
            .toolbarBackground(isFullBleed ? .hidden : .automatic, for: .navigationBar)
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
                    .disabled(loading)

                    // Apple — native button styled to match
                    SignInWithAppleButton(.continue) { request in
                        request.requestedScopes = [.fullName, .email]
                    } onCompletion: { result in
                        Task { await handleAppleSignIn(result) }
                    }
                    .signInWithAppleButtonStyle(.white)
                    .frame(height: 54)
                    .clipShape(Capsule())
                    .disabled(loading)

                    // TODO: enable when Google OAuth is wired
                    // Hidden for App Store Review — a button that only
                    // shows "Próximamente" is flagged as broken / misleading
                    // functionality. Restore the block below (and the
                    // `showGoogleNotice` alert) once the provider is live.
                    /*
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
                    .disabled(loading)
                    */
                }
                .padding(.bottom, 20)

                if loading {
                    ProgressView()
                        .progressViewStyle(.circular)
                        .tint(.white)
                        .frame(maxWidth: .infinity, alignment: .center)
                        .padding(.bottom, 12)
                }

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
                // Persist the Apple userID so the app can later check the
                // credential state on launch and force-logout if revoked.
                UserDefaults.standard.set(credential.user, forKey: "apple_user_id")
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

// MARK: - Welcome Register Screen
// Ported from Claude Design (hogaresrd/project/ios-register.html).
// Full-bleed architectural hero photo with a deep-blue tint, brand
// mark + headline anchored above a white sheet that holds the form
// (name / email / password / role dropdown / terms / CTA).
//
// On submit:
// - Comprador (cliente) registers inline via api.register(...).
// - Broker / Inmobiliaria / Constructora route to the existing
//   detailed form so role-specific fields (license, job title,
//   company name, etc.) can be collected. Basic fields are passed
//   through as a prefill so the user doesn't retype them.

enum RegisterRole: String, CaseIterable, Identifiable {
    case comprador, broker, inmobiliaria, constructora
    var id: String { rawValue }
    var label: String {
        switch self {
        case .comprador:    return "🏠 Comprador / Inquilino"
        case .broker:       return "🤝 Agente Broker"
        case .inmobiliaria: return "🏢 Inmobiliaria"
        case .constructora: return "🔨 Constructora"
        }
    }
}

struct RegisterPrefill: Equatable {
    var name: String = ""
    var email: String = ""
    var password: String = ""
}

struct WelcomeRegisterScreen: View {
    var prefill: RegisterPrefill?
    var onLogin: () -> Void
    var onSuccess: () -> Void
    var onAdvancedRole: (AuthView.Mode, RegisterPrefill) -> Void

    @EnvironmentObject var api: APIService
    @State private var name: String
    @State private var email: String
    @State private var password: String
    @State private var showPassword = false
    @State private var role: RegisterRole?
    @State private var termsAccepted = false
    @State private var loading = false
    @State private var error: String?

    init(
        prefill: RegisterPrefill? = nil,
        onLogin: @escaping () -> Void,
        onSuccess: @escaping () -> Void,
        onAdvancedRole: @escaping (AuthView.Mode, RegisterPrefill) -> Void
    ) {
        self.prefill = prefill
        self.onLogin = onLogin
        self.onSuccess = onSuccess
        self.onAdvancedRole = onAdvancedRole
        _name     = State(initialValue: prefill?.name ?? "")
        _email    = State(initialValue: prefill?.email ?? "")
        _password = State(initialValue: prefill?.password ?? "")
    }

    // Same Unsplash hero used in the design mock. Falls back to a
    // dark blue gradient if the network request fails or the user is
    // offline — the rest of the layout doesn't depend on it.
    private static let heroURL = URL(string:
        "https://images.unsplash.com/photo-1512917774080-9991f1c4c750?w=1200&q=80"
    )!

    private let blue      = Color(red:   0/255, green: 106/255, blue: 255/255)
    private let panelBg   = Color(red: 244/255, green: 245/255, blue: 247/255)
    private let textInk   = Color(red:  26/255, green:  26/255, blue:  46/255)
    private let textMuted = Color(red: 138/255, green: 143/255, blue: 168/255)
    private let textBody  = Color(red:  74/255, green:  79/255, blue: 104/255)
    private let darkBg    = Color(red:  13/255, green:  27/255, blue:  42/255)

    var body: some View {
        GeometryReader { geo in
            let heroHeight = geo.size.height * 0.48
            let panelTop   = geo.size.height * 0.43

            ZStack(alignment: .topLeading) {
                darkBg.ignoresSafeArea()

                // ── Hero (top 48%) ──
                ZStack {
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

                    LinearGradient(stops: [
                        .init(color: Color(red:  0/255, green:  40/255, blue: 100/255).opacity(0.55), location: 0),
                        .init(color: darkBg.opacity(0.92),                                            location: 1)
                    ], startPoint: .top, endPoint: .bottom)

                    // Logo + headline + sub
                    VStack(spacing: 0) {
                        ZStack {
                            RoundedRectangle(cornerRadius: 12, style: .continuous)
                                .fill(blue)
                                .frame(width: 44, height: 44)
                            Image(systemName: "house.fill")
                                .font(.system(size: 22, weight: .bold))
                                .foregroundStyle(.white)
                        }
                        .shadow(color: blue.opacity(0.4), radius: 12, x: 0, y: 8)
                        .padding(.bottom, 18)

                        Text("Crea tu cuenta en\nHogaresRD")
                            .font(.system(size: 24, weight: .heavy))
                            .foregroundStyle(.white)
                            .multilineTextAlignment(.center)
                            .lineSpacing(2)
                            .padding(.bottom, 10)

                        Text("Accede a miles de propiedades en República Dominicana y gestiona todo desde un solo lugar.")
                            .font(.system(size: 13.5))
                            .foregroundStyle(.white.opacity(0.65))
                            .multilineTextAlignment(.center)
                            .lineSpacing(3)
                            .frame(maxWidth: 260)
                    }
                    .padding(.horizontal, 28)
                }
                .frame(width: geo.size.width, height: heroHeight)
                .clipped()
                .ignoresSafeArea(edges: .top)

                // ── Bottom white sheet ──
                ScrollView {
                    VStack(spacing: 12) {
                        textField("Nombre completo", text: $name, autocaps: .words)

                        textField(
                            "Correo electrónico",
                            text: $email,
                            keyboardType: .emailAddress,
                            autocaps: .never,
                            autocorrect: false
                        )

                        passwordField()

                        roleDropdown()

                        termsRow()

                        if let err = error {
                            HStack(spacing: 6) {
                                Image(systemName: "exclamationmark.circle.fill")
                                    .foregroundStyle(.red)
                                Text(err)
                                    .font(.caption)
                                    .foregroundStyle(.red)
                                Spacer(minLength: 0)
                            }
                            .padding(.vertical, 2)
                        }

                        Button(action: { Task { await submit() } }) {
                            ZStack {
                                if loading {
                                    ProgressView().tint(.white)
                                } else {
                                    Text("Crear cuenta")
                                        .font(.system(size: 16, weight: .bold))
                                        .foregroundStyle(.white)
                                }
                            }
                            .frame(maxWidth: .infinity)
                            .frame(height: 54)
                            .background(blue, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
                            .shadow(color: blue.opacity(0.35), radius: 12, x: 0, y: 8)
                        }
                        .buttonStyle(.plain)
                        .disabled(loading)
                        .padding(.top, 4)

                        HStack(spacing: 4) {
                            Text("¿Ya tienes cuenta?")
                                .foregroundStyle(textMuted)
                            Button(action: onLogin) {
                                Text("Iniciar sesión")
                                    .foregroundStyle(blue)
                                    .fontWeight(.bold)
                            }
                            .buttonStyle(.plain)
                        }
                        .font(.system(size: 13.5))
                        .frame(maxWidth: .infinity)
                        .padding(.top, 2)
                    }
                    .padding(.horizontal, 22)
                    .padding(.top, 24)
                    .padding(.bottom, 28)
                }
                .scrollIndicators(.hidden)
                .frame(width: geo.size.width, height: geo.size.height - panelTop)
                .background(Color.white)
                .clipShape(
                    UnevenRoundedRectangle(
                        cornerRadii: .init(topLeading: 28, topTrailing: 28),
                        style: .continuous
                    )
                )
                .shadow(color: .black.opacity(0.12), radius: 16, x: 0, y: -4)
                .offset(y: panelTop)
                .ignoresSafeArea(edges: .bottom)
            }
        }
    }

    // MARK: - Sub-views

    @ViewBuilder
    private func textField(
        _ placeholder: String,
        text: Binding<String>,
        keyboardType: UIKeyboardType = .default,
        autocaps: TextInputAutocapitalization = .sentences,
        autocorrect: Bool = true
    ) -> some View {
        TextField(placeholder, text: text)
            .keyboardType(keyboardType)
            .textInputAutocapitalization(autocaps)
            .autocorrectionDisabled(!autocorrect)
            .font(.system(size: 15))
            .foregroundStyle(textInk)
            .padding(.horizontal, 16)
            .frame(height: 52)
            .background(panelBg, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
    }

    @ViewBuilder
    private func passwordField() -> some View {
        HStack(spacing: 10) {
            Group {
                if showPassword {
                    TextField("Contraseña", text: $password)
                        .autocorrectionDisabled()
                        .textInputAutocapitalization(.never)
                } else {
                    SecureField("Contraseña", text: $password)
                }
            }
            .font(.system(size: 15))
            .foregroundStyle(textInk)

            Button(action: { showPassword.toggle() }) {
                Image(systemName: showPassword ? "eye.fill" : "eye.slash.fill")
                    .font(.system(size: 16))
                    .foregroundStyle(textMuted)
            }
            .buttonStyle(.plain)
            .accessibilityLabel(showPassword ? "Ocultar contraseña" : "Mostrar contraseña")
            .accessibilityValue(showPassword ? "Visible" : "Oculta")
        }
        .padding(.horizontal, 16)
        .frame(height: 52)
        .background(panelBg, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
    }

    @ViewBuilder
    private func roleDropdown() -> some View {
        Menu {
            ForEach(RegisterRole.allCases) { r in
                Button(r.label) { role = r }
            }
        } label: {
            HStack(spacing: 10) {
                Text(role?.label ?? "Tipo de usuario")
                    .font(.system(size: 15))
                    .foregroundStyle(role == nil ? textMuted : textInk)
                    .frame(maxWidth: .infinity, alignment: .leading)
                Image(systemName: "chevron.down")
                    .font(.system(size: 13, weight: .heavy))
                    .foregroundStyle(textMuted)
            }
            .padding(.horizontal, 16)
            .frame(height: 52)
            .background(panelBg, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        }
    }

    @ViewBuilder
    private func termsRow() -> some View {
        HStack(alignment: .top, spacing: 10) {
            Button(action: { termsAccepted.toggle() }) {
                ZStack {
                    if termsAccepted {
                        RoundedRectangle(cornerRadius: 5, style: .continuous)
                            .fill(blue)
                            .frame(width: 20, height: 20)
                        Image(systemName: "checkmark")
                            .font(.system(size: 12, weight: .heavy))
                            .foregroundStyle(.white)
                    } else {
                        RoundedRectangle(cornerRadius: 5, style: .continuous)
                            .stroke(Color(red: 200/255, green: 203/255, blue: 216/255), lineWidth: 2)
                            .frame(width: 20, height: 20)
                    }
                }
                .padding(.top, 1)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Aceptar términos")
            .accessibilityValue(termsAccepted ? "Aceptado" : "No aceptado")

            (
                Text("Acepto los ")
                    .foregroundStyle(textBody)
                + Text("Términos de Servicio")
                    .foregroundStyle(blue).fontWeight(.semibold).underline()
                + Text(" y la ")
                    .foregroundStyle(textBody)
                + Text("Política de Privacidad")
                    .foregroundStyle(blue).fontWeight(.semibold).underline()
                + Text(" de HogaresRD.")
                    .foregroundStyle(textBody)
            )
            .font(.system(size: 13))
            .lineSpacing(3)
        }
        .padding(.top, 4)
    }

    // MARK: - Submit

    @MainActor
    private func submit() async {
        let trimmedName  = name.trimmingCharacters(in: .whitespaces)
        let trimmedEmail = email.trimmingCharacters(in: .whitespaces).lowercased()

        guard !trimmedName.isEmpty else  { error = "Ingresa tu nombre completo."; return }
        guard !trimmedEmail.isEmpty else { error = "Ingresa tu correo electrónico."; return }
        guard !password.isEmpty else     { error = "Ingresa una contraseña."; return }
        guard let role else              { error = "Selecciona el tipo de cuenta."; return }
        guard termsAccepted else         { error = "Debes aceptar los términos para continuar."; return }

        let pf = RegisterPrefill(name: trimmedName, email: trimmedEmail, password: password)
        switch role {
        case .comprador:
            loading = true; error = nil
            do {
                _ = try await api.register(
                    name: trimmedName, email: trimmedEmail,
                    password: password, marketingOptIn: true
                )
                onSuccess()
            } catch {
                self.error = error.localizedDescription
            }
            loading = false
        case .broker:
            onAdvancedRole(.registerBroker, pf)
        case .inmobiliaria:
            onAdvancedRole(.registerInmobiliaria, pf)
        case .constructora:
            onAdvancedRole(.registerConstructora, pf)
        }
    }
}

// MARK: - Welcome Login Form Screen
// Companion to WelcomeRegisterScreen — same hero / blue tint / logo /
// white sheet, but with the email-login form (and the 2FA code-entry
// step inline). Both states swap headline, sub, and panel content
// without changing the layout shell.
//
// Reached from WelcomeLoginScreen → "Iniciar sesión con Email".
// Apple Sign-In stays on the welcome screen so we don't duplicate it.

struct WelcomeLoginFormScreen: View {
    var onRegister: () -> Void
    var onSuccess: () -> Void

    @EnvironmentObject var api: APIService

    @State private var email = ""
    @State private var password = ""
    @State private var showPassword = false
    @State private var loading = false
    @State private var error: String?

    // 2FA
    @State private var show2FA = false
    @State private var twoFASessionId = ""
    @State private var twoFACode = ""
    @State private var twoFALoading = false
    @State private var twoFAError: String?
    @State private var resendCooldown: Int = 0
    @FocusState private var twoFAFocus: Bool

    @State private var showForgot = false

    // 1-second tick used to drive the resend cooldown countdown.
    private let resendTimer = Timer.publish(every: 1.0, on: .main, in: .common).autoconnect()

    private let bio = BiometricService.shared

    private static let heroURL = URL(string:
        "https://images.unsplash.com/photo-1512917774080-9991f1c4c750?w=1200&q=80"
    )!

    private let blue      = Color(red:   0/255, green: 106/255, blue: 255/255)
    private let panelBg   = Color(red: 244/255, green: 245/255, blue: 247/255)
    private let textInk   = Color(red:  26/255, green:  26/255, blue:  46/255)
    private let textMuted = Color(red: 138/255, green: 143/255, blue: 168/255)
    private let textBody  = Color(red:  74/255, green:  79/255, blue: 104/255)
    private let darkBg    = Color(red:  13/255, green:  27/255, blue:  42/255)

    var body: some View {
        GeometryReader { geo in
            let heroHeight = geo.size.height * 0.48
            let panelTop   = geo.size.height * 0.43

            ZStack(alignment: .topLeading) {
                darkBg.ignoresSafeArea()

                // ── Hero (top 48%) ──
                ZStack {
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

                    LinearGradient(stops: [
                        .init(color: Color(red:  0/255, green:  40/255, blue: 100/255).opacity(0.55), location: 0),
                        .init(color: darkBg.opacity(0.92),                                            location: 1)
                    ], startPoint: .top, endPoint: .bottom)

                    // Logo + headline + sub — swaps when 2FA is active
                    VStack(spacing: 0) {
                        ZStack {
                            RoundedRectangle(cornerRadius: 12, style: .continuous)
                                .fill(blue)
                                .frame(width: 44, height: 44)
                            Image(systemName: show2FA ? "lock.shield.fill" : "house.fill")
                                .font(.system(size: 22, weight: .bold))
                                .foregroundStyle(.white)
                        }
                        .shadow(color: blue.opacity(0.4), radius: 12, x: 0, y: 8)
                        .padding(.bottom, 18)

                        Text(show2FA ? "Verifica tu\nidentidad" : "Inicia sesión en\nHogaresRD")
                            .font(.system(size: 24, weight: .heavy))
                            .foregroundStyle(.white)
                            .multilineTextAlignment(.center)
                            .lineSpacing(2)
                            .padding(.bottom, 10)

                        Text(show2FA
                             ? "Ingresa el código de 6 dígitos que enviamos a tu correo."
                             : "Accede a tus propiedades, aplicaciones y conversaciones desde un solo lugar.")
                            .font(.system(size: 13.5))
                            .foregroundStyle(.white.opacity(0.65))
                            .multilineTextAlignment(.center)
                            .lineSpacing(3)
                            .frame(maxWidth: 280)
                    }
                    .padding(.horizontal, 28)
                }
                .frame(width: geo.size.width, height: heroHeight)
                .clipped()
                .ignoresSafeArea(edges: .top)

                // ── Bottom white sheet ──
                ScrollView {
                    if show2FA { twoFAPanel } else { loginPanel }
                }
                .scrollIndicators(.hidden)
                .frame(width: geo.size.width, height: geo.size.height - panelTop)
                .background(Color.white)
                .clipShape(
                    UnevenRoundedRectangle(
                        cornerRadii: .init(topLeading: 28, topTrailing: 28),
                        style: .continuous
                    )
                )
                .shadow(color: .black.opacity(0.12), radius: 16, x: 0, y: -4)
                .offset(y: panelTop)
                .ignoresSafeArea(edges: .bottom)
            }
        }
        .sheet(isPresented: $showForgot) {
            ForgotPasswordSheet(prefillEmail: email).environmentObject(api)
        }
    }

    // MARK: - Panels

    @ViewBuilder
    private var loginPanel: some View {
        VStack(spacing: 12) {
            textField(
                "Correo electrónico",
                text: $email,
                keyboardType: .emailAddress,
                autocaps: .never,
                autocorrect: false
            )

            passwordField()

            // Forgot password — right-aligned link
            HStack(spacing: 0) {
                Spacer()
                Button(action: { showForgot = true }) {
                    Text("¿Olvidaste tu contraseña?")
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundStyle(blue)
                }
                .buttonStyle(.plain)
            }
            .padding(.top, -2)

            if let err = error {
                HStack(spacing: 6) {
                    Image(systemName: "exclamationmark.circle.fill")
                        .foregroundStyle(.red)
                    Text(err)
                        .font(.caption)
                        .foregroundStyle(.red)
                    Spacer(minLength: 0)
                }
                .padding(.vertical, 2)
            }

            primaryCTA(
                "Iniciar sesión",
                loading: loading,
                disabled: email.isEmpty || password.isEmpty
            ) {
                Task { await login() }
            }

            // Biometric — only shown when previously enrolled
            if bio.isAvailable,
               let savedEmail = bio.savedBiometricEmail(),
               bio.hasBiometricToken(for: savedEmail) {
                Button(action: { Task { await loginWithBiometric(savedEmail) } }) {
                    HStack(spacing: 8) {
                        Image(systemName: bio.biometricIcon)
                            .font(.system(size: 16, weight: .semibold))
                        Text("Iniciar con \(bio.biometricLabel)")
                            .font(.system(size: 14, weight: .bold))
                    }
                    .foregroundStyle(blue)
                    .frame(maxWidth: .infinity)
                    .frame(height: 48)
                    .background(blue.opacity(0.08), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                }
                .buttonStyle(.plain)
            }

            // Register link
            HStack(spacing: 4) {
                Text("¿No tienes cuenta?")
                    .foregroundStyle(textMuted)
                Button(action: onRegister) {
                    Text("Regístrate")
                        .foregroundStyle(blue)
                        .fontWeight(.bold)
                }
                .buttonStyle(.plain)
            }
            .font(.system(size: 13.5))
            .frame(maxWidth: .infinity)
            .padding(.top, 4)
        }
        .padding(.horizontal, 22)
        .padding(.top, 24)
        .padding(.bottom, 28)
    }

    @ViewBuilder
    private var twoFAPanel: some View {
        VStack(spacing: 14) {
            ZStack {
                Circle()
                    .fill(blue.opacity(0.10))
                    .frame(width: 64, height: 64)
                Image(systemName: "envelope.badge.fill")
                    .font(.system(size: 26, weight: .semibold))
                    .foregroundStyle(blue)
            }
            .padding(.top, 4)

            Text("Verificación en dos pasos")
                .font(.system(size: 17, weight: .heavy))
                .foregroundStyle(textInk)

            Text("Por seguridad, te enviamos un código de 6 dígitos. Ingrésalo aquí para continuar.")
                .font(.system(size: 13))
                .foregroundStyle(textBody)
                .multilineTextAlignment(.center)
                .lineSpacing(2)
                .padding(.horizontal, 8)

            TextField("000000", text: $twoFACode)
                .keyboardType(.numberPad)
                .multilineTextAlignment(.center)
                .font(.system(size: 28, weight: .bold, design: .monospaced))
                .foregroundStyle(textInk)
                .padding(.horizontal, 24)
                .frame(height: 64)
                .background(panelBg, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                .focused($twoFAFocus)
                .onChange(of: twoFACode) { _, val in
                    twoFACode = String(val.filter(\.isNumber).prefix(6))
                }
                .padding(.top, 4)

            if let err = twoFAError {
                HStack(spacing: 6) {
                    Image(systemName: "exclamationmark.circle.fill")
                        .foregroundStyle(.red)
                    Text(err)
                        .font(.caption)
                        .foregroundStyle(.red)
                    Spacer(minLength: 0)
                }
                .padding(.vertical, 2)
            }

            primaryCTA("Verificar", loading: twoFALoading, disabled: twoFACode.count != 6) {
                Task { await verify2FA() }
            }

            Button(action: { Task { await resend2FA() } }) {
                Text(resendCooldown > 0 ? "Reenviar código (\(resendCooldown)s)" : "Reenviar código")
                    .font(.system(size: 14, weight: .bold))
                    .foregroundStyle(resendCooldown > 0 ? textMuted : blue)
            }
            .buttonStyle(.plain)
            .disabled(resendCooldown > 0)
            .padding(.top, 2)
            .onReceive(resendTimer) { _ in
                if resendCooldown > 0 { resendCooldown -= 1 }
            }

            Button(action: {
                show2FA = false
                twoFACode = ""
                twoFAError = nil
            }) {
                Text("← Volver al inicio de sesión")
                    .font(.system(size: 13))
                    .foregroundStyle(textMuted)
            }
            .buttonStyle(.plain)
            .padding(.top, 2)
        }
        .padding(.horizontal, 22)
        .padding(.top, 28)
        .padding(.bottom, 28)
    }

    // MARK: - Sub-views

    @ViewBuilder
    private func textField(
        _ placeholder: String,
        text: Binding<String>,
        keyboardType: UIKeyboardType = .default,
        autocaps: TextInputAutocapitalization = .sentences,
        autocorrect: Bool = true
    ) -> some View {
        TextField(placeholder, text: text)
            .keyboardType(keyboardType)
            .textInputAutocapitalization(autocaps)
            .autocorrectionDisabled(!autocorrect)
            .font(.system(size: 15))
            .foregroundStyle(textInk)
            .padding(.horizontal, 16)
            .frame(height: 52)
            .background(panelBg, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
    }

    @ViewBuilder
    private func passwordField() -> some View {
        HStack(spacing: 10) {
            Group {
                if showPassword {
                    TextField("Contraseña", text: $password)
                        .autocorrectionDisabled()
                        .textInputAutocapitalization(.never)
                } else {
                    SecureField("Contraseña", text: $password)
                }
            }
            .font(.system(size: 15))
            .foregroundStyle(textInk)
            .submitLabel(.go)
            .onSubmit { Task { await login() } }

            Button(action: { showPassword.toggle() }) {
                Image(systemName: showPassword ? "eye.fill" : "eye.slash.fill")
                    .font(.system(size: 16))
                    .foregroundStyle(textMuted)
            }
            .buttonStyle(.plain)
            .accessibilityLabel(showPassword ? "Ocultar contraseña" : "Mostrar contraseña")
            .accessibilityValue(showPassword ? "Visible" : "Oculta")
        }
        .padding(.horizontal, 16)
        .frame(height: 52)
        .background(panelBg, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
    }

    @ViewBuilder
    private func primaryCTA(
        _ label: String,
        loading: Bool,
        disabled: Bool = false,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            ZStack {
                if loading {
                    ProgressView().tint(.white)
                } else {
                    Text(label)
                        .font(.system(size: 16, weight: .bold))
                        .foregroundStyle(.white)
                }
            }
            .frame(maxWidth: .infinity)
            .frame(height: 54)
            .background(
                disabled
                ? Color(red: 200/255, green: 203/255, blue: 216/255)
                : blue,
                in: RoundedRectangle(cornerRadius: 16, style: .continuous)
            )
            .shadow(color: disabled ? .clear : blue.opacity(0.35), radius: 12, x: 0, y: 8)
        }
        .buttonStyle(.plain)
        .disabled(loading || disabled)
        .padding(.top, 4)
    }

    // MARK: - Actions

    private func login() async {
        let trimmed = email.trimmingCharacters(in: .whitespaces)
        guard !trimmed.isEmpty, !password.isEmpty else { return }
        loading = true; error = nil
        do {
            let result = try await api.login(email: trimmed, password: password)
            switch result {
            case .success:
                onSuccess()
            case .requires2FA(let sid, _):
                twoFASessionId = sid
                withAnimation(.easeInOut(duration: 0.22)) { show2FA = true }
            }
        } catch {
            self.error = error.localizedDescription
        }
        loading = false
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
                withAnimation(.easeInOut(duration: 0.22)) { show2FA = true }
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
            // Re-focus the 6-digit field so the user can retry without
            // tapping it again. A brief delay lets the field redraw first.
            Task {
                try? await Task.sleep(nanoseconds: 100_000_000)
                twoFAFocus = true
            }
        }
        twoFALoading = false
    }

    private func resend2FA() async {
        guard resendCooldown == 0 else { return }
        do {
            try await api.resend2FA(sessionId: twoFASessionId)
            resendCooldown = 60
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

// MARK: - Broker Register Form

struct BrokerRegisterForm: View {
    var onSuccess: () -> Void
    var onBack: () -> Void
    @EnvironmentObject var api: APIService

    @State private var name: String
    @State private var email: String
    @State private var phone = ""
    @State private var licenseNumber = ""
    @State private var jobTitle = ""
    @State private var customJobTitle = ""
    @State private var password: String
    @State private var confirm = ""
    @State private var termsAccepted = false
    @State private var loading = false
    @State private var error: String?

    init(
        onSuccess: @escaping () -> Void,
        onBack: @escaping () -> Void,
        prefill: RegisterPrefill? = nil
    ) {
        self.onSuccess = onSuccess
        self.onBack    = onBack
        _name     = State(initialValue: prefill?.name ?? "")
        _email    = State(initialValue: prefill?.email ?? "")
        _password = State(initialValue: prefill?.password ?? "")
    }

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

    @State private var name: String
    @State private var email: String
    @State private var phone = ""
    @State private var companyName = ""
    @State private var licenseNumber = ""
    @State private var password: String
    @State private var confirm = ""
    @State private var termsAccepted = false
    @State private var loading = false
    @State private var error: String?

    private let purpleColor = Color(red: 0.55, green: 0.27, blue: 0.68)

    init(
        onSuccess: @escaping () -> Void,
        onBack: @escaping () -> Void,
        prefill: RegisterPrefill? = nil
    ) {
        self.onSuccess = onSuccess
        self.onBack    = onBack
        _name     = State(initialValue: prefill?.name ?? "")
        _email    = State(initialValue: prefill?.email ?? "")
        _password = State(initialValue: prefill?.password ?? "")
    }

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

    @State private var name: String
    @State private var email: String
    @State private var phone = ""
    @State private var companyName = ""
    @State private var yearsExperience = ""
    @State private var password: String
    @State private var confirm = ""
    @State private var termsAccepted = false
    @State private var loading = false
    @State private var error: String?

    private let orangeColor = Color(red: 0.7, green: 0.35, blue: 0.04)

    init(
        onSuccess: @escaping () -> Void,
        onBack: @escaping () -> Void,
        prefill: RegisterPrefill? = nil
    ) {
        self.onSuccess = onSuccess
        self.onBack    = onBack
        _name     = State(initialValue: prefill?.name ?? "")
        _email    = State(initialValue: prefill?.email ?? "")
        _password = State(initialValue: prefill?.password ?? "")
    }

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
