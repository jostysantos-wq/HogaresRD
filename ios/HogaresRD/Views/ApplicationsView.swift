import SwiftUI

// MARK: - Applications List

struct ApplicationsView: View {
    @EnvironmentObject var api: APIService
    @State private var applications: [Application] = []
    @State private var loading = true
    @State private var errorMsg: String?
    @State private var filter = 0  // 0=Activas, 1=Finalizadas, 2=Todas
    @State private var selectedAppId: String?

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
                VStack(spacing: 16) {
                    Image(systemName: "doc.text.magnifyingglass")
                        .font(.system(size: 60))
                        .foregroundStyle(Color.rdBlue.opacity(0.35))
                    Text("Sin aplicaciones")
                        .font(.title2).bold()
                    Text("Cuando apliques a una propiedad verás el estado de tu solicitud aquí.")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                        .padding(.horizontal, 32)
                }
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
                        VStack(spacing: 12) {
                            Spacer()
                            Image(systemName: filter == 0 ? "checkmark.circle" : "tray")
                                .font(.system(size: 36))
                                .foregroundStyle(.secondary.opacity(0.5))
                            Text(filter == 0 ? "No tienes aplicaciones activas" : "No hay aplicaciones finalizadas")
                                .font(.subheadline)
                                .foregroundStyle(.secondary)
                            Spacer()
                        }
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
                    ApplicationDetailView(id: appId).environmentObject(api)
                }
            }
        }
        .navigationTitle("Mis Aplicaciones")
        .task { await load() }
        .refreshable { await load() }
    }

    // ── Helpers ──

    private func summaryPill(count: Int, label: String, color: Color) -> some View {
        HStack(spacing: 6) {
            Text("\(count)")
                .font(.system(size: 20, weight: .bold, design: .rounded))
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
            withAnimation(.easeInOut(duration: 0.2)) { filter = tag }
        } label: {
            VStack(spacing: 6) {
                HStack(spacing: 4) {
                    Text(label).font(.caption.bold())
                    Text("\(badge)")
                        .font(.system(size: 10, weight: .bold, design: .rounded))
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
        }
        .frame(maxWidth: .infinity)
    }

    private func load() async {
        if applications.isEmpty { loading = true }
        errorMsg = nil
        do {
            applications = try await api.getApplications()
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
        let blue   = Color(red: 0.14, green: 0.39, blue: 0.92)
        let orange = Color(red: 0.85, green: 0.47, blue: 0.02)
        let green  = Color(red: 0.09, green: 0.64, blue: 0.29)
        let red    = Color(red: 0.86, green: 0.15, blue: 0.15)
        let purple = Color(red: 0.55, green: 0.24, blue: 0.78)
        let teal   = Color(red: 0.18, green: 0.60, blue: 0.60)

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
                        .font(.system(size: 11, weight: .bold))
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
                            .font(.system(size: 15, weight: .bold, design: .rounded))
                            .foregroundStyle(isTerminal ? .secondary : Color.rdBlue)

                        if let city = app.listingCity, !city.isEmpty {
                            HStack(spacing: 2) {
                                Image(systemName: "mappin")
                                    .font(.system(size: 9))
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
