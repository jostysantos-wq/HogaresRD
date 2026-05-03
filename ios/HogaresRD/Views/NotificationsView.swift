import SwiftUI

struct NotificationsView: View {
    @EnvironmentObject var api:   APIService
    @EnvironmentObject var saved: SavedStore

    @State private var items: [APIService.AppNotification] = []
    @State private var unreadCount: Int = 0
    @State private var loading = false
    @State private var loadedOnce = false
    @State private var errorMsg: String?
    @State private var markingAll = false

    var body: some View {
        NavigationStack {
            notificationsContent
                .navigationTitle("Alertas")
                .toolbar { toolbarContent }
                .task {
                    if api.currentUser != nil { await load() }
                }
                .refreshable {
                    if api.currentUser != nil { await load() }
                }
                .onReceive(NotificationCenter.default.publisher(for: .pushNotificationReceived)) { _ in
                    // A new push just arrived — pull the inbox so the new row
                    // appears without waiting for the next refresh.
                    Task { await load() }
                }
        }
    }

    @ToolbarContentBuilder
    private var toolbarContent: some ToolbarContent {
        if api.currentUser != nil && unreadCount > 0 {
            ToolbarItem(placement: .navigationBarLeading) {
                Button {
                    Task { await markAllRead() }
                } label: {
                    if markingAll {
                        ProgressView().controlSize(.small)
                    } else {
                        Text("Marcar todo")
                            .font(.caption.bold())
                    }
                }
                .disabled(markingAll)
            }
        }
        ToolbarItem(placement: .navigationBarTrailing) {
            NavigationLink {
                ProfileMenuView()
            } label: {
                if let user = api.currentUser {
                    ZStack {
                        Circle().fill(Color.rdBlue).frame(width: 32, height: 32)
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

    // MARK: - Content

    @ViewBuilder
    private var notificationsContent: some View {
        if api.currentUser == nil {
            loggedOutPlaceholder
        } else if !loadedOnce && loading {
            ProgressView()
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else if items.isEmpty {
            emptyInboxPlaceholder
        } else {
            notificationsList
        }
    }

    private var notificationsList: some View {
        List {
            if let err = errorMsg {
                Section {
                    Label(err, systemImage: "exclamationmark.triangle.fill")
                        .font(.caption)
                        .foregroundStyle(.red)
                }
            }
            ForEach(items) { item in
                Button {
                    Task { await tap(item) }
                } label: {
                    NotificationRow(notification: item)
                }
                .buttonStyle(.plain)
                .listRowInsets(EdgeInsets(top: 8, leading: 16, bottom: 8, trailing: 16))
                .swipeActions(edge: .trailing, allowsFullSwipe: true) {
                    Button(role: .destructive) {
                        Task { await deleteItem(item) }
                    } label: {
                        Label("Eliminar", systemImage: "trash")
                    }
                }
            }
        }
        .listStyle(.plain)
    }

    private var loggedOutPlaceholder: some View {
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

    private var emptyInboxPlaceholder: some View {
        VStack(spacing: 18) {
            Spacer()
            ZStack {
                Circle().fill(Color.rdBlue.opacity(0.08)).frame(width: 96, height: 96)
                Image(systemName: "bell.slash.fill")
                    .font(.system(size: 40))
                    .foregroundStyle(Color.rdBlue.opacity(0.6))
            }
            VStack(spacing: 6) {
                Text("Sin notificaciones")
                    .font(.headline)
                Text("Cuando recibas mensajes, asignaciones de leads u otras alertas, aparecerán aquí.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, 32)
            }
            Spacer()
        }
    }

    // MARK: - Actions

    private func load() async {
        loading = true
        defer {
            loading = false
            loadedOnce = true
        }
        do {
            let result = try await api.fetchNotifications(limit: 100)
            await MainActor.run {
                items = result.items
                unreadCount = result.unreadCount
                errorMsg = nil
            }
        } catch {
            await MainActor.run { errorMsg = "No se pudieron cargar las notificaciones." }
        }
    }

    private func tap(_ item: APIService.AppNotification) async {
        // Optimistic mark-read locally so the UI updates instantly.
        if !item.isRead {
            await MainActor.run {
                if let idx = items.firstIndex(where: { $0.id == item.id }) {
                    items[idx] = APIService.AppNotification(
                        id: item.id, type: item.type, title: item.title,
                        body: item.body, url: item.url,
                        read_at: ISO8601DateFormatter().string(from: Date()),
                        created_at: item.created_at
                    )
                }
                unreadCount = max(0, unreadCount - 1)
            }
            try? await api.markNotificationRead(id: item.id)
        }

        // Deep-link to the notification's URL via the universal-link path,
        // which the app's existing handleDeepLink picks up. Falls back to
        // opening in Safari for URLs the app doesn't claim.
        if let urlStr = item.url, !urlStr.isEmpty {
            let full = urlStr.hasPrefix("http")
                ? urlStr
                : "https://hogaresrd.com" + urlStr
            if let u = URL(string: full) {
                await UIApplication.shared.open(u)
            }
        }
    }

    private func markAllRead() async {
        markingAll = true
        defer { markingAll = false }
        do {
            try await api.markAllNotificationsRead()
            await load()
        } catch {
            await MainActor.run { errorMsg = "No se pudieron marcar las notificaciones." }
        }
    }

    private func deleteItem(_ item: APIService.AppNotification) async {
        await MainActor.run {
            items.removeAll { $0.id == item.id }
            if !item.isRead { unreadCount = max(0, unreadCount - 1) }
        }
        try? await api.deleteNotification(id: item.id)
    }
}

// MARK: - Row

private struct NotificationRow: View {
    let notification: APIService.AppNotification

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            ZStack {
                Circle().fill(iconColor.opacity(0.15)).frame(width: 40, height: 40)
                Image(systemName: iconName).foregroundStyle(iconColor)
            }

            VStack(alignment: .leading, spacing: 4) {
                if let title = notification.title, !title.isEmpty {
                    Text(title)
                        .font(.subheadline)
                        .fontWeight(notification.isRead ? .regular : .bold)
                        .lineLimit(2)
                }
                if let body = notification.body, !body.isEmpty {
                    Text(body)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(3)
                }
                Text(relativeTime)
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
            }
            Spacer(minLength: 4)

            if !notification.isRead {
                Circle().fill(Color.rdBlue).frame(width: 8, height: 8)
                    .padding(.top, 6)
            }
        }
    }

    private var iconName: String {
        switch notification.type {
        case "new_message":         return "bubble.left.fill"
        case "new_application":     return "doc.text.fill"
        case "status_changed":      return "arrow.triangle.swap"
        case "tour_update":         return "calendar.badge.clock"
        case "payment_approved":    return "checkmark.seal.fill"
        case "lead_cascade":        return "person.crop.circle.badge.exclamationmark"
        case "document_reviewed":   return "doc.badge.checkmark"
        case "secretary_action":    return "person.fill.badge.plus"
        case "saved_search_match":  return "magnifyingglass"
        case "new_listing":         return "house.fill"
        case "new_affiliation":     return "person.2.badge.gearshape"
        case "task_pending_review",
             "task_completed",
             "task_approved",
             "task_rejected",
             "task_not_applicable": return "checklist"
        default:                    return "bell.fill"
        }
    }

    private var iconColor: Color {
        switch notification.type {
        case "payment_approved", "task_approved":   return .rdGreen
        case "task_rejected", "lead_cascade":       return .rdRed
        case "task_pending_review":                 return .orange
        case "new_listing", "saved_search_match":   return .purple
        default:                                    return .rdBlue
        }
    }

    private var relativeTime: String {
        // Server timestamps come from `new Date().toISOString()` which always
        // includes fractional seconds (e.g. 2026-04-29T03:21:34.567Z). Try
        // both with and without fractional seconds so we don't silently
        // return "" if the format ever drifts.
        let withFrac = ISO8601DateFormatter()
        withFrac.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let plain = ISO8601DateFormatter()
        let date = withFrac.date(from: notification.created_at)
                  ?? plain.date(from: notification.created_at)
        guard let date else { return "" }
        let elapsed = Date().timeIntervalSince(date)
        if elapsed < 60          { return "ahora" }
        if elapsed < 3600        { return "hace \(Int(elapsed / 60)) min" }
        if elapsed < 86400       { return "hace \(Int(elapsed / 3600)) h" }
        if elapsed < 604800      { return "hace \(Int(elapsed / 86400)) d" }
        let fmt = DateFormatter()
        fmt.dateStyle = .medium
        fmt.timeStyle = .none
        return fmt.string(from: date)
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
                                authSheet = .welcome
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
            AuthView(initialMode: mode)
                .environmentObject(api)
                .id(mode)
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
            .onChange(of: newListings)   { _, v in UserDefaults.standard.set(v, forKey: "notif_newListings"); syncNotifPref("notif_newListings", v) }
            .onChange(of: priceDrops)    { _, v in UserDefaults.standard.set(v, forKey: "notif_priceDrops"); syncNotifPref("notif_priceDrops", v) }
            .onChange(of: similar)       { _, v in UserDefaults.standard.set(v, forKey: "notif_similar"); syncNotifPref("notif_similar", v) }
            .onChange(of: agentMessages) { _, v in UserDefaults.standard.set(v, forKey: "notif_agentMessages"); syncNotifPref("notif_agentMessages", v) }
            .onChange(of: appUpdates)    { _, v in UserDefaults.standard.set(v, forKey: "notif_appUpdates"); syncNotifPref("notif_appUpdates", v) }
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

    /// Sync a notification preference to the server so it persists across
    /// platforms. Fire-and-forget — UserDefaults is instant UI truth.
    /// Maps iOS toggle keys to server push preference keys
    // `nonisolated` so non-main-actor contexts (Task.detached below)
    // can read this constant table without an actor hop. Safe because
    // the value is immutable.
    nonisolated private static let prefKeyMap: [String: String] = [
        "notif_newListings":   "new_listing",
        "notif_priceDrops":    "saved_search_match",
        "notif_agentMessages": "new_message",
        "notif_appUpdates":    "status_changed",
        "notif_similar":       "saved_search_match",
    ]

    private func syncNotifPref(_ key: String, _ value: Bool) {
        Task.detached {
            // Reading APIService.shared.token requires hopping to the main
            // actor where the singleton lives.
            let t = await APIService.shared.token ?? ""
            // Sync to user profile
            if let url = URL(string: "\(apiBase)/api/user/profile") {
                var req = URLRequest(url: url)
                req.httpMethod = "PATCH"
                req.setValue("application/json", forHTTPHeaderField: "Content-Type")
                req.setValue("Bearer \(t)", forHTTPHeaderField: "Authorization")
                req.httpBody = try? JSONSerialization.data(withJSONObject: [key: value])
                _ = try? await URLSession.shared.data(for: req)
            }
            // Also sync to push preferences so backend notify() respects it
            if let pushKey = Self.prefKeyMap[key],
               let url = URL(string: "\(apiBase)/api/push/preferences") {
                var req = URLRequest(url: url)
                req.httpMethod = "PUT"
                req.setValue("application/json", forHTTPHeaderField: "Content-Type")
                req.setValue("Bearer \(t)", forHTTPHeaderField: "Authorization")
                req.httpBody = try? JSONSerialization.data(withJSONObject: [pushKey: value])
                _ = try? await URLSession.shared.data(for: req)
            }
        }
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
                    Text(Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "1.0.0").foregroundStyle(.secondary)
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
