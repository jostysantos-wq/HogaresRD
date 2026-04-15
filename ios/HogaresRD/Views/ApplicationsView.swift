import SwiftUI

// MARK: - Applications List

struct ApplicationsView: View {
    @EnvironmentObject var api: APIService
    @State private var applications: [Application] = []
    @State private var loading = true
    @State private var errorMsg: String?

    var body: some View {
        Group {
            if loading {
                ProgressView()
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if let err = errorMsg {
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
                List(applications) { app in
                    ApplicationCard(app: app)
                        .listRowSeparator(.hidden)
                        .listRowBackground(Color.clear)
                }
                .listStyle(.plain)
            }
        }
        .navigationTitle("Mis Aplicaciones")
        .task { await load() }
        .refreshable { await load() }
    }

    private func load() async {
        if applications.isEmpty { loading = true }
        errorMsg = nil
        do {
            applications = try await api.getApplications()
            applications.sort { $0.createdAt > $1.createdAt }
        } catch is CancellationError {
            // Ignore — task was cancelled (e.g. view disappeared during refresh)
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
            return .init(label: "Recibida",               icon: "clock.fill",            fg: blue,   bg: blue.opacity(0.10))
        case "en_revision":
            return .init(label: "En revisión",            icon: "magnifyingglass",       fg: orange, bg: orange.opacity(0.10))
        case "documentos_requeridos":
            return .init(label: "Docs. requeridos",       icon: "doc.badge.arrow.up",    fg: orange, bg: orange.opacity(0.10))
        case "documentos_enviados":
            return .init(label: "Docs. enviados",         icon: "doc.badge.checkmark",   fg: blue,   bg: blue.opacity(0.10))
        case "documentos_insuficientes":
            return .init(label: "Docs. insuficientes",    icon: "doc.badge.xmark",       fg: red,    bg: red.opacity(0.10))
        case "en_aprobacion":
            return .init(label: "En aprobación",          icon: "hourglass",             fg: purple, bg: purple.opacity(0.10))
        case "reservado":
            return .init(label: "Reservada",              icon: "bookmark.fill",         fg: teal,   bg: teal.opacity(0.10))
        case "aprobado":
            return .init(label: "Aprobada",               icon: "checkmark.seal.fill",   fg: green,  bg: green.opacity(0.10))
        case "pendiente_pago":
            return .init(label: "Pendiente de pago",      icon: "creditcard",            fg: orange, bg: orange.opacity(0.10))
        case "pago_enviado":
            return .init(label: "Pago enviado",           icon: "paperplane.fill",       fg: blue,   bg: blue.opacity(0.10))
        case "pago_aprobado":
            return .init(label: "Pago aprobado",          icon: "checkmark.circle.fill", fg: green,  bg: green.opacity(0.10))
        case "completado":
            return .init(label: "Completada",             icon: "flag.checkered",        fg: green,  bg: green.opacity(0.12))
        case "rechazado":
            return .init(label: "Rechazada",              icon: "xmark.circle.fill",     fg: red,    bg: red.opacity(0.10))
        default:
            return .init(label: app.status,               icon: "circle",                fg: .secondary, bg: Color(.systemGray6))
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            // Status pill
            Label(style.label, systemImage: style.icon)
                .font(.caption).bold()
                .foregroundStyle(style.fg)
                .padding(.horizontal, 10).padding(.vertical, 5)
                .background(style.bg)
                .clipShape(Capsule())

            // Title
            Text(app.listingTitle)
                .font(.subheadline).bold()
                .lineLimit(2)

            // Price
            Text(app.priceFormatted)
                .font(.headline).bold()
                .foregroundStyle(Color.rdBlue)

            // Meta row
            HStack(spacing: 16) {
                Label(app.timeAgo, systemImage: "calendar")
                Label(intentLabel, systemImage: "flag.fill")
                Label(typeLabel, systemImage: "house.fill")
            }
            .font(.caption)
            .foregroundStyle(.secondary)
        }
        .padding(14)
        .background(Color(.systemBackground))
        .clipShape(RoundedRectangle(cornerRadius: 14))
        .overlay(
            RoundedRectangle(cornerRadius: 14)
                .stroke(Color(.systemGray4), lineWidth: 1)
        )
        .shadow(color: .black.opacity(0.04), radius: 4, x: 0, y: 2)
        .padding(.vertical, 4)
    }

    private var intentLabel: String {
        switch app.intent {
        case "comprar":  return "Comprar"
        case "alquilar": return "Alquilar"
        default:         return app.intent.capitalized
        }
    }

    private var typeLabel: String {
        switch app.listingType {
        case "venta":    return "Venta"
        case "alquiler": return "Alquiler"
        case "proyecto": return "Proyecto"
        default:         return app.listingType.capitalized
        }
    }
}
