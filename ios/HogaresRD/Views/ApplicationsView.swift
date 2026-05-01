import SwiftUI

// MARK: - Applications List
//
// Wave 8-C refactor: linear, thin-row pattern against the editorial
// design system. Filters are a `ChipRow` with counts; rows use a leading
// `StatusDot` + title + caption + optional `DSStatusBadge` when the row
// requires action. Empty states use `EmptyStateView` factories.

struct ApplicationsView: View {
    @EnvironmentObject var api: APIService
    @State private var applications: [Application] = []
    @State private var loading = true
    @State private var initialLoadStarted = Date()
    @State private var showSkeleton = false
    @State private var errorMsg: String?
    @State private var filter: AppFilter = .activas
    @State private var selectedAppId: String?

    // Deep-link target. When a push notification arrives carrying an
    // application_id, ContentView posts .deepLinkApplication and we
    // pre-populate the NavigationStack path so the relevant detail view
    // pushes onto the existing stack on next render.
    @State private var deepLinkAppId: String? = nil

    enum AppFilter: String, Hashable {
        case todas, activas, completadas
    }

    private static let terminalStatuses: Set<String> = ["rechazado", "completado"]

    private var activeApps: [Application] {
        applications.filter { !Self.terminalStatuses.contains($0.status) }
    }
    private var finishedApps: [Application] {
        applications.filter { Self.terminalStatuses.contains($0.status) }
    }
    private var displayedApps: [Application] {
        switch filter {
        case .activas:     return activeApps
        case .completadas: return finishedApps
        case .todas:       return applications
        }
    }

    var body: some View {
        Group {
            if loading && applications.isEmpty {
                if showSkeleton {
                    VStack(spacing: 0) {
                        ForEach(0..<5, id: \.self) { _ in
                            SkeletonRow()
                                .padding(.horizontal, Spacing.s16)
                            Divider().opacity(0.4)
                        }
                        Spacer()
                    }
                } else {
                    Color.clear
                }
            } else if let err = errorMsg, applications.isEmpty {
                EmptyStateView.calm(
                    systemImage: "exclamationmark.triangle",
                    title: "No pudimos cargar tus aplicaciones",
                    description: err,
                    actionTitle: "Reintentar",
                    action: { Task { await load() } }
                )
            } else if applications.isEmpty {
                EmptyStateView.calm(
                    systemImage: "doc.text.magnifyingglass",
                    title: "Sin aplicaciones",
                    description: "Cuando apliques a una propiedad verás el estado de tu solicitud aquí."
                )
            } else {
                VStack(spacing: 0) {
                    ChipRow(
                        items: [
                            .init(id: AppFilter.todas,       label: "Todas",       count: applications.count),
                            .init(id: AppFilter.activas,     label: "Activas",     count: activeApps.count),
                            .init(id: AppFilter.completadas, label: "Completadas", count: finishedApps.count)
                        ],
                        selection: $filter
                    )
                    .padding(.top, Spacing.s8)

                    Divider().opacity(0.4)

                    if displayedApps.isEmpty {
                        EmptyStateView.filterCleared(
                            title: filter == .activas ? "No tienes aplicaciones activas" : "Sin aplicaciones en esta vista",
                            description: "Ajusta el filtro para ver más resultados.",
                            onClear: { filter = .todas }
                        )
                    } else {
                        ScrollView {
                            LazyVStack(spacing: 0) {
                                ForEach(displayedApps) { app in
                                    NavigationLink(value: app.id) {
                                        ApplicationListRow(app: app)
                                            .padding(.horizontal, Spacing.s16)
                                    }
                                    .buttonStyle(.plain)
                                    Divider().opacity(0.4)
                                        .padding(.leading, Spacing.s16 + 16)
                                }
                            }
                        }
                    }
                }
                .navigationDestination(for: String.self) { appId in
                    // B2: buyers (user / comprador) get the read-only detail
                    // view; everyone else (broker, agency, inmobiliaria,
                    // constructora, secretary, admin) keeps the broker UI.
                    if isBuyerRole(api.currentUser?.role) {
                        BuyerApplicationDetailView(id: appId).environmentObject(api)
                    } else {
                        ApplicationDetailView(id: appId).environmentObject(api)
                    }
                }
            }
        }
        .navigationTitle("Mis Aplicaciones")
        .task { await load() }
        .refreshable { await load() }
        // #34: Push deep-link → fullscreen cover with the detail view.
        // We use a fullscreen cover (instead of pushing onto the parent
        // NavigationStack) because we don't own its path binding from
        // here; the cover lets us reliably surface the detail no matter
        // how the user reached this screen.
        .fullScreenCover(item: Binding(
            get: { deepLinkAppId.map { DeepLinkID(id: $0) } },
            set: { deepLinkAppId = $0?.id }
        )) { item in
            NavigationStack {
                Group {
                    if isBuyerRole(api.currentUser?.role) {
                        BuyerApplicationDetailView(id: item.id).environmentObject(api)
                    } else {
                        ApplicationDetailView(id: item.id).environmentObject(api)
                    }
                }
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("Cerrar") { deepLinkAppId = nil }
                            .accessibilityLabel("Cerrar detalle")
                    }
                }
            }
            .presentationDragIndicator(.visible)
            .environmentObject(api)
        }
        .onReceive(NotificationCenter.default.publisher(for: .deepLinkApplication)) { notif in
            if let id = notif.userInfo?["applicationId"] as? String, !id.isEmpty {
                deepLinkAppId = id
            }
        }
    }

    // ── Helpers ──

    /// B2: Treat unauthenticated / role==nil sessions as buyers as well —
    /// only an explicitly broker-side role should land on the broker UI.
    private func isBuyerRole(_ role: String?) -> Bool {
        guard let r = role?.lowercased() else { return true }
        if r == "user" || r == "comprador" { return true }
        let pro: Set<String> = ["broker", "agency", "inmobiliaria", "constructora", "secretary", "admin"]
        return !pro.contains(r)
    }

    private func load() async {
        if applications.isEmpty {
            loading = true
            initialLoadStarted = Date()
            // Only show the skeleton if the load is taking >300ms — a
            // brief flash on a cached response looks worse than nothing.
            Task { @MainActor in
                try? await Task.sleep(for: .milliseconds(300))
                if loading && applications.isEmpty {
                    showSkeleton = true
                }
            }
        }
        errorMsg = nil
        do {
            applications = try await api.getMyApplications()
            applications.sort { $0.createdAt > $1.createdAt }
        } catch is CancellationError {
        } catch {
            errorMsg = error.localizedDescription
        }
        loading = false
        showSkeleton = false
    }
}

// MARK: - Linear list row
//
// One slim row per application: leading 8pt status dot, two-line text
// stack (title + listing-name with relative date), optional
// action-required `DSStatusBadge` on the trailing edge. Tap area is the
// full row (`contentShape(Rectangle())`).

private struct ApplicationListRow: View {
    let app: Application

    private struct StatusStyle {
        let label: String
        let tint: Color
        /// Whether this status requires action from the buyer (drives
        /// the trailing `DSStatusBadge`).
        let actionRequired: Bool
    }

    private var style: StatusStyle {
        switch app.status {
        case "aplicado":
            return .init(label: "Recibida", tint: .rdBlue, actionRequired: false)
        case "en_revision":
            return .init(label: "En revisión", tint: .rdOrange, actionRequired: false)
        case "documentos_requeridos", "documentos_solicitados":
            return .init(label: "Docs. solicitados", tint: .rdOrange, actionRequired: true)
        case "documentos_enviados":
            return .init(label: "Docs. enviados", tint: .rdBlue, actionRequired: false)
        case "documentos_insuficientes":
            return .init(label: "Docs. insuficientes", tint: .rdRed, actionRequired: true)
        case "en_aprobacion":
            return .init(label: "En aprobación", tint: .rdPurple, actionRequired: false)
        case "reservado":
            return .init(label: "Reservada", tint: .rdTeal, actionRequired: false)
        case "aprobado":
            return .init(label: "Aprobada", tint: .rdGreen, actionRequired: false)
        case "pendiente_pago":
            return .init(label: "Pendiente de pago", tint: .rdOrange, actionRequired: true)
        case "pago_enviado":
            return .init(label: "Pago enviado", tint: .rdBlue, actionRequired: false)
        case "pago_aprobado":
            return .init(label: "Pago aprobado", tint: .rdGreen, actionRequired: false)
        case "completado":
            return .init(label: "Completada", tint: .rdGreen, actionRequired: false)
        case "rechazado":
            return .init(label: "Rechazada", tint: .rdRed, actionRequired: false)
        default:
            return .init(label: app.status, tint: .rdMuted, actionRequired: false)
        }
    }

    private var isTerminal: Bool {
        ["rechazado", "completado"].contains(app.status)
    }

    var body: some View {
        HStack(spacing: Spacing.s12) {
            StatusDot(tint: style.tint)
                .padding(.top, 6)

            VStack(alignment: .leading, spacing: 2) {
                Text(app.listingTitle)
                    .font(.body)
                    .foregroundStyle(isTerminal ? Color.rdInkSoft : Color.rdInk)
                    .lineLimit(1)

                Text("\(style.label) · \(app.timeAgo)")
                    .font(.caption)
                    .foregroundStyle(Color.rdInkSoft)
                    .lineLimit(1)
            }

            Spacer(minLength: Spacing.s8)

            if style.actionRequired {
                DSStatusBadge(label: "Acción", tint: .rdOrange)
            }

            Image(systemName: "chevron.right")
                .font(.caption.weight(.semibold))
                .foregroundStyle(Color.rdInkSoft)
                .accessibilityHidden(true)
        }
        .padding(.vertical, Spacing.s12)
        .frame(minHeight: 56)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(app.listingTitle), \(style.label), \(app.timeAgo)")
    }
}
