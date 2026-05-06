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
        // The trailing avatar that opened the legacy ProfileMenuView
        // was removed — there's already a Profile tab in the bottom
        // bar, and the duplicate entry led to the old List-style
        // settings UI rather than the redesigned editorial flow.
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
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                pushHeroCard
                if let err = errorMsg {
                    errorBanner(err)
                }
                if !pushService.isAuthorized && pushEnabled == false {
                    pushDeniedCard
                }
                propertyAlertsSection
                generalSection
            }
            .padding(.horizontal, 20)
            .padding(.top, 12)
            .padding(.bottom, 24)
        }
        .background(ProfileBackdrop())
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

    /// Master "Notificaciones push" hero. Bigger than the row-level
    /// toggles below to signal that this gate is the prerequisite for
    /// every individual category — when it's off, none of the
    /// category-level preferences fire.
    @ViewBuilder
    private var pushHeroCard: some View {
        HStack(alignment: .top, spacing: 14) {
            ZStack {
                Circle()
                    .fill(Color.rdAccent.opacity(0.13))
                    .frame(width: 48, height: 48)
                Image(systemName: pushEnabled ? "bell.badge.fill" : "bell.slash.fill")
                    .font(.system(size: 19, weight: .semibold))
                    .foregroundStyle(Color.rdAccent)
            }
            VStack(alignment: .leading, spacing: 4) {
                Text("Notificaciones push")
                    .font(.system(size: 16, weight: .semibold))
                Text("Alertas en tiempo real sobre propiedades, mensajes y actualizaciones.")
                    .font(.system(size: 12.5))
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 8)
            if loading {
                ProgressView()
            } else {
                Toggle("", isOn: $pushEnabled)
                    .labelsHidden()
                    .tint(Color.rdAccent)
                    .disabled(loading)
            }
        }
        .padding(16)
        .background(
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .fill(Color(.secondarySystemGroupedBackground))
        )
        .overlay(
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .stroke(Color.black.opacity(0.08), lineWidth: 1)
        )
        .shadow(color: .black.opacity(0.03), radius: 8, y: 2)
    }

    private func errorBanner(_ msg: String) -> some View {
        HStack(spacing: 10) {
            Image(systemName: "exclamationmark.triangle.fill")
                .foregroundStyle(.red)
            Text(msg)
                .font(.caption)
                .foregroundStyle(.primary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.red.opacity(0.10), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
    }

    @ViewBuilder
    private var pushDeniedCard: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                Image(systemName: "info.circle.fill")
                    .foregroundStyle(.orange)
                Text("Permisos del sistema desactivados")
                    .font(.caption.bold())
                    .foregroundStyle(.primary)
            }
            Text("Las notificaciones push no están habilitadas en los ajustes del sistema, así que las preferencias de abajo no podrán enviar alertas hasta que se concedan.")
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            Button {
                if let url = URL(string: UIApplication.openSettingsURLString) {
                    UIApplication.shared.open(url)
                }
            } label: {
                HStack(spacing: 6) {
                    Image(systemName: "arrow.up.forward.app")
                    Text("Abrir Ajustes")
                }
                .font(.caption.bold())
                .foregroundStyle(.white)
                .padding(.horizontal, 12).padding(.vertical, 8)
                .background(Color.rdAccent, in: Capsule())
            }
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.orange.opacity(0.08), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .stroke(Color.orange.opacity(0.25), lineWidth: 1)
        )
    }

    @ViewBuilder
    private var propertyAlertsSection: some View {
        ProfileSectionCard(title: "Alertas de propiedades") {
            ProfileToggleRow(
                icon: "house.badge.exclamationmark.fill",
                iconAccent: Color.rdAccent,
                label: "Nuevas propiedades",
                sub: "Listados que coinciden con tus criterios",
                isOn: $newListings
            )
            Divider().padding(.leading, 64)
            ProfileToggleRow(
                icon: "tag.fill",
                iconAccent: Color.rdGold,
                label: "Bajas de precio",
                sub: "Cuando bajan precios de propiedades guardadas",
                isOn: $priceDrops
            )
            Divider().padding(.leading, 64)
            ProfileToggleRow(
                icon: "sparkles",
                iconAccent: Color.rdTeal,
                label: "Propiedades similares",
                sub: "Sugerencias basadas en tus búsquedas recientes",
                isOn: $similar
            )
        }
    }

    @ViewBuilder
    private var generalSection: some View {
        ProfileSectionCard(title: "General") {
            ProfileToggleRow(
                icon: "bubble.left.and.bubble.right.fill",
                iconAccent: Color.rdBlue,
                label: "Mensajes de agentes",
                sub: "Cuando un agente te envía un mensaje",
                isOn: $agentMessages
            )
            Divider().padding(.leading, 64)
            ProfileToggleRow(
                icon: "sparkle",
                iconAccent: Color.rdGreen,
                label: "Actualizaciones de aplicación",
                sub: "Novedades y mejoras de HogaresRD",
                isOn: $appUpdates
            )
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

    fileprivate struct ThemeOption: Identifiable {
        let tag: String
        let label: String
        let sub: String
        let icon: String
        let accent: Color
        var id: String { tag }
    }

    private let options: [ThemeOption] = [
        .init(tag: "system", label: "Sistema",
              sub: "Sigue el ajuste de tu iPhone",
              icon: "circle.lefthalf.filled", accent: Color.rdAccent),
        .init(tag: "light",  label: "Claro",
              sub: "Fondo cremoso y tipografía oscura",
              icon: "sun.max.fill",          accent: Color.rdGold),
        .init(tag: "dark",   label: "Oscuro",
              sub: "Fondo profundo, contraste reducido",
              icon: "moon.fill",             accent: Color.rdBlue),
    ]

    private var versionString: String {
        Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "1.0.0"
    }

    private var buildString: String {
        Bundle.main.infoDictionary?["CFBundleVersion"] as? String ?? "—"
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                ProfileSectionCard(title: "Apariencia") {
                    ForEach(Array(options.enumerated()), id: \.element.tag) { idx, opt in
                        ThemeOptionRow(
                            option: opt,
                            isSelected: schemePref == opt.tag
                        ) {
                            withAnimation(Motion.fade) {
                                schemePref = opt.tag
                            }
                        }
                        if idx < options.count - 1 {
                            Divider().padding(.leading, 64)
                        }
                    }
                }

                ProfileSectionCard(title: "Sobre") {
                    aboutRow(label: "Versión",    value: versionString)
                    Divider().padding(.leading, 64)
                    aboutRow(label: "Build",      value: buildString)
                }
            }
            .padding(.horizontal, 20)
            .padding(.top, 12)
            .padding(.bottom, 24)
        }
        .background(ProfileBackdrop())
        .navigationTitle("Apariencia")
        .navigationBarTitleDisplayMode(.inline)
    }

    private func aboutRow(label: String, value: String) -> some View {
        HStack(spacing: 14) {
            ZStack {
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .fill(Color(.tertiarySystemFill))
                    .frame(width: 36, height: 36)
                Image(systemName: label == "Versión" ? "app.badge.fill" : "hammer.fill")
                    .font(.system(size: 16, weight: .medium))
                    .foregroundStyle(.secondary)
            }
            Text(label)
                .font(.system(size: 14.5, weight: .semibold))
            Spacer()
            Text(value)
                .font(.system(size: 14, weight: .medium))
                .foregroundStyle(.secondary)
                .monospacedDigit()
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 13)
    }
}

/// Single theme choice row inside the Apariencia section card.
/// Tapping anywhere on the row sets it as the active choice; the
/// trailing checkmark and the colored icon-tile signal the selection.
private struct ThemeOptionRow: View {
    let option: AppSettingsView.ThemeOption
    let isSelected: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 14) {
                ZStack {
                    RoundedRectangle(cornerRadius: 10, style: .continuous)
                        .fill(isSelected ? option.accent.opacity(0.18) : Color(.tertiarySystemFill))
                        .frame(width: 36, height: 36)
                    Image(systemName: option.icon)
                        .font(.system(size: 16, weight: .medium))
                        .foregroundStyle(isSelected ? option.accent : .secondary)
                }
                VStack(alignment: .leading, spacing: 2) {
                    Text(option.label)
                        .font(.system(size: 14.5, weight: .semibold))
                        .foregroundStyle(.primary)
                    Text(option.sub)
                        .font(.system(size: 11.5))
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                Spacer(minLength: 8)
                if isSelected {
                    Image(systemName: "checkmark.circle.fill")
                        .font(.system(size: 18))
                        .foregroundStyle(option.accent)
                } else {
                    Circle()
                        .strokeBorder(Color.black.opacity(0.12), lineWidth: 1.5)
                        .frame(width: 18, height: 18)
                }
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 13)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
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
