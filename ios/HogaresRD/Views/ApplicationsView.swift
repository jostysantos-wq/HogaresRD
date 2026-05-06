import SwiftUI

// MARK: - Applications List

struct ApplicationsView: View {
    @EnvironmentObject var api: APIService
    @State private var applications: [Application] = []
    @State private var loading = true
    @State private var errorMsg: String?
    @State private var filter = 0  // 0=Activas, 1=Finalizadas, 2=Todas
    @State private var selectedAppId: String?

    // Deep-link target. When a push notification arrives carrying an
    // application_id, ContentView posts .deepLinkApplication and we
    // pre-populate the NavigationStack path so the relevant detail view
    // pushes onto the existing stack on next render.
    @State private var deepLinkAppId: String? = nil

    private static let terminalStatuses: Set<String> = ["rechazado", "completado"]

    private var activeApps: [Application] {
        applications.filter { !Self.terminalStatuses.contains($0.status) }
    }
    private var finishedApps: [Application] {
        applications.filter { Self.terminalStatuses.contains($0.status) }
    }
    private var displayedApps: [Application] {
        switch filter {
        case 0:  return activeApps
        case 1:  return finishedApps
        default: return applications
        }
    }

    var body: some View {
        Group {
            if loading {
                ProgressView()
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if let err = errorMsg, applications.isEmpty {
                VStack(spacing: 16) {
                    Image(systemName: "exclamationmark.triangle")
                        .font(.system(size: 48))
                        .foregroundStyle(.secondary)
                    Text(err)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                    Button("Reintentar") { Task { await load() } }
                        .buttonStyle(.borderedProminent)
                        .tint(Color.rdBlue)
                }
                .padding()
            } else if applications.isEmpty {
                EmptyState.plain(
                    title: "Sin aplicaciones",
                    systemImage: "doc.text.magnifyingglass",
                    description: "Cuando apliques a una propiedad verás el estado de tu solicitud aquí."
                )
            } else {
                VStack(spacing: 0) {
                    // ── Summary bar ──
                    HStack(spacing: 12) {
                        summaryPill(count: activeApps.count, label: "Activas", color: .rdBlue)
                        summaryPill(count: finishedApps.count, label: "Finalizadas", color: .secondary)
                    }
                    .padding(.horizontal).padding(.top, 8).padding(.bottom, 4)

                    // ── Filter tabs ──
                    HStack(spacing: 0) {
                        filterTab("Activas", tag: 0, badge: activeApps.count)
                        filterTab("Finalizadas", tag: 1, badge: finishedApps.count)
                        filterTab("Todas", tag: 2, badge: applications.count)
                    }
                    .padding(.horizontal)
                    .padding(.bottom, 6)

                    Divider()

                    // ── Card list ──
                    if displayedApps.isEmpty {
                        EmptyState.plain(
                            title: filter == 0 ? "Sin aplicaciones activas" : "Sin aplicaciones finalizadas",
                            systemImage: filter == 0 ? "checkmark.circle" : "tray",
                            description: filter == 0
                                ? "Tus solicitudes en curso aparecerán aquí."
                                : "Las aplicaciones cerradas se archivan en esta vista."
                        )
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                    } else {
                        ScrollView {
                            LazyVStack(spacing: 12) {
                                ForEach(displayedApps) { app in
                                    NavigationLink(value: app.id) {
                                        ApplicationCard(app: app)
                                    }
                                    .buttonStyle(.plain)
                                }
                            }
                            .padding(.horizontal)
                            .padding(.vertical, 12)
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
                    }
                }
            }
            .environmentObject(api)
        }
        .onReceive(NotificationCenter.default.publisher(for: .deepLinkApplication)) { notif in
            if let id = notif.userInfo?["applicationId"] as? String, !id.isEmpty {
                deepLinkAppId = id
            }
        }
    }

    // ── Helpers ──

    private func summaryPill(count: Int, label: String, color: Color) -> some View {
        HStack(spacing: 6) {
            Text("\(count)")
                .font(.title3.bold())
                .foregroundStyle(color)
            Text(label)
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .padding(.horizontal, 14).padding(.vertical, 8)
        .background(color.opacity(0.08))
        .clipShape(RoundedRectangle(cornerRadius: 10))
    }

    private func filterTab(_ label: String, tag: Int, badge: Int) -> some View {
        Button {
            withAnimation(Motion.layout) { filter = tag }
        } label: {
            VStack(spacing: 6) {
                HStack(spacing: 4) {
                    Text(label).font(.caption.bold())
                    Text("\(badge)")
                        .font(.caption2.bold())
                        .padding(.horizontal, 5).padding(.vertical, 1)
                        .background(filter == tag ? Color.rdBlue : Color(.systemGray5))
                        .foregroundStyle(filter == tag ? .white : .secondary)
                        .clipShape(Capsule())
                }
                .foregroundStyle(filter == tag ? Color.rdBlue : .secondary)

                Rectangle()
                    .fill(filter == tag ? Color.rdBlue : .clear)
                    .frame(height: 2)
            }
            .frame(maxWidth: .infinity, minHeight: 44)
            .contentShape(Rectangle())
        }
        .frame(maxWidth: .infinity)
    }

    /// B2: Treat unauthenticated / role==nil sessions as buyers as well —
    /// only an explicitly broker-side role should land on the broker UI.
    private func isBuyerRole(_ role: String?) -> Bool {
        guard let r = role?.lowercased() else { return true }
        if r == "user" || r == "comprador" { return true }
        let pro: Set<String> = ["broker", "agency", "inmobiliaria", "constructora", "secretary", "admin"]
        return !pro.contains(r)
    }

    private func load() async {
        if applications.isEmpty { loading = true }
        errorMsg = nil
        do {
            applications = try await api.getMyApplications()
            applications.sort { $0.createdAt > $1.createdAt }
        } catch is CancellationError {
        } catch {
            errorMsg = error.localizedDescription
        }
        loading = false
    }
}

// MARK: - Card

private struct ApplicationCard: View {
    let app: Application

    private struct StatusStyle {
        let label: String
        let icon:  String
        let fg:    Color
        let bg:    Color
        let accent: Color  // left border color
    }

    private var style: StatusStyle {
        // #51: use adaptive Color tokens so badges remain legible in
        // Dark Mode. The literal RGB values these used to hold rendered
        // as washed-out smudges on a dark background.
        let blue   = Color.rdBlue
        let orange = Color.rdOrange
        let green  = Color.rdGreen
        let red    = Color.rdRed
        let purple = Color.rdPurple
        let teal   = Color.rdTeal

        switch app.status {
        case "aplicado":
            return .init(label: "Recibida",               icon: "clock.fill",            fg: blue,   bg: blue.opacity(0.10),   accent: blue)
        case "en_revision":
            return .init(label: "En revisión",            icon: "magnifyingglass",       fg: orange, bg: orange.opacity(0.10), accent: orange)
        case "documentos_requeridos":
            return .init(label: "Docs. requeridos",       icon: "doc.badge.arrow.up",    fg: orange, bg: orange.opacity(0.10), accent: orange)
        case "documentos_enviados":
            return .init(label: "Docs. enviados",         icon: "doc.badge.checkmark",   fg: blue,   bg: blue.opacity(0.10),   accent: blue)
        case "documentos_insuficientes":
            return .init(label: "Docs. insuficientes",    icon: "doc.badge.xmark",       fg: red,    bg: red.opacity(0.10),    accent: red)
        case "en_aprobacion":
            return .init(label: "En aprobación",          icon: "hourglass",             fg: purple, bg: purple.opacity(0.10), accent: purple)
        case "reservado":
            return .init(label: "Reservada",              icon: "bookmark.fill",         fg: teal,   bg: teal.opacity(0.10),   accent: teal)
        case "aprobado":
            return .init(label: "Aprobada",               icon: "checkmark.seal.fill",   fg: green,  bg: green.opacity(0.10),  accent: green)
        case "pendiente_pago":
            return .init(label: "Pendiente de pago",      icon: "creditcard",            fg: orange, bg: orange.opacity(0.10), accent: orange)
        case "pago_enviado":
            return .init(label: "Pago enviado",           icon: "paperplane.fill",       fg: blue,   bg: blue.opacity(0.10),   accent: blue)
        case "pago_aprobado":
            return .init(label: "Pago aprobado",          icon: "checkmark.circle.fill", fg: green,  bg: green.opacity(0.10),  accent: green)
        case "completado":
            return .init(label: "Completada",             icon: "flag.checkered",        fg: green,  bg: green.opacity(0.12),  accent: green)
        case "rechazado":
            return .init(label: "Rechazada",              icon: "xmark.circle.fill",     fg: red,    bg: red.opacity(0.10),    accent: red)
        default:
            return .init(label: app.status,               icon: "circle",                fg: .secondary, bg: Color(.systemGray6), accent: .secondary)
        }
    }

    private var imageURL: URL? {
        guard let img = app.listingImage, !img.isEmpty else { return nil }
        if img.hasPrefix("http") { return URL(string: img) }
        return URL(string: APIService.baseURL + img)
    }

    private var isTerminal: Bool {
        ["rechazado", "completado"].contains(app.status)
    }

    var body: some View {
        HStack(spacing: 0) {
            // ── Color accent bar ──
            RoundedRectangle(cornerRadius: 2)
                .fill(style.accent)
                .frame(width: 4)
                .padding(.vertical, 8)

            HStack(spacing: 12) {
                // ── Thumbnail ──
                Group {
                    if let url = imageURL {
                        AsyncImage(url: url) { phase in
                            switch phase {
                            case .success(let img):
                                img.resizable().aspectRatio(contentMode: .fill)
                            default:
                                Rectangle().fill(Color(.systemGray5))
                                    .overlay(Image(systemName: "photo").foregroundStyle(.secondary))
                            }
                        }
                    } else {
                        Rectangle().fill(Color(.systemGray5))
                            .overlay(
                                Image(systemName: "building.2")
                                    .font(.title3)
                                    .foregroundStyle(.secondary.opacity(0.5))
                            )
                    }
                }
                .frame(width: 80, height: 80)
                .clipShape(RoundedRectangle(cornerRadius: 10))
                .opacity(isTerminal ? 0.6 : 1.0)

                // ── Content ──
                VStack(alignment: .leading, spacing: 6) {
                    // Status pill
                    Label(style.label, systemImage: style.icon)
                        .font(.caption2.bold())
                        .foregroundStyle(style.fg)
                        .padding(.horizontal, 8).padding(.vertical, 3)
                        .background(style.bg)
                        .clipShape(Capsule())

                    // Title
                    Text(app.listingTitle)
                        .font(.subheadline).bold()
                        .lineLimit(2)
                        .foregroundStyle(isTerminal ? .secondary : .primary)

                    // Price + location
                    HStack(spacing: 8) {
                        Text(app.priceFormatted)
                            .font(.subheadline.bold())
                            .foregroundStyle(isTerminal ? .secondary : Color.rdBlue)

                        if let city = app.listingCity, !city.isEmpty {
                            HStack(spacing: 2) {
                                Image(systemName: "mappin")
                                    .font(.caption2)
                                Text(city)
                                    .font(.caption2)
                            }
                            .foregroundStyle(.secondary)
                        }
                    }

                    // Date
                    Text(app.timeAgo)
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                }

                Spacer(minLength: 0)

                // ── Chevron ──
                Image(systemName: "chevron.right")
                    .font(.caption2.bold())
                    .foregroundStyle(.quaternary)
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 12)
        }
        .background(Color(.systemBackground))
        .clipShape(RoundedRectangle(cornerRadius: 14))
        .overlay(
            RoundedRectangle(cornerRadius: 14)
                .stroke(Color(.separator).opacity(0.3), lineWidth: 1)
        )
        .shadow(color: .black.opacity(isTerminal ? 0.02 : 0.06), radius: 6, x: 0, y: 3)
    }
}
