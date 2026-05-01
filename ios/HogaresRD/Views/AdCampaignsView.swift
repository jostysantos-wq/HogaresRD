import SwiftUI

// MARK: - Models

struct MetaAdAccount: Codable, Identifiable {
    let id: String
    let name: String?
    let currency: String?
}

struct MetaStatus: Codable {
    let connected: Bool
    let fb_user_name: String?
    let ad_accounts: [MetaAdAccount]?
    let selected_account: String?
}

struct AdCampaign: Codable, Identifiable {
    let campaign_id: String
    let name: String?
    let status: String?
    let listing_id: String?
    let listing_title: String?
    let daily_budget: Double?
    let impressions: Int?
    let clicks: Int?
    let spend_usd: String?
    let reach: Int?
    let ctr: String?
    let cpc: String?
    let created_at: String?

    var id: String { campaign_id }
}

struct MetaStatusResponse: Decodable { let connected: Bool; let fb_user_name: String?; let ad_accounts: [MetaAdAccount]?; let selected_account: String? }
struct AdCampaignsResponse: Decodable { let campaigns: [AdCampaign] }

// MARK: - View

struct AdCampaignsView: View {
    @EnvironmentObject var api: APIService

    @State private var status: MetaStatusResponse?
    @State private var campaigns: [AdCampaign] = []
    @State private var loading = true
    @State private var errorMsg: String?
    @State private var togglingIds: Set<String> = []
    @State private var deleteTarget: AdCampaign?
    private var webUrl: URL { URL(string: "https://hogaresrd.com/broker")! }

    var body: some View {
        List {
            if loading {
                Section { ProgressView() }
            } else if let s = status, !s.connected {
                // Not connected
                Section {
                    VStack(alignment: .leading, spacing: 10) {
                        HStack(spacing: 12) {
                            Image(systemName: "megaphone.fill")
                                .font(.title2)
                                .foregroundStyle(Color.rdBlue)
                            VStack(alignment: .leading, spacing: 2) {
                                Text("Meta Ads no conectado")
                                    .font(.subheadline).bold()
                                Text("Conecta tu cuenta de Facebook desde la web para crear campañas publicitarias.")
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                        }
                        Link(destination: webUrl) {
                            Label("Conectar en hogaresrd.com", systemImage: "arrow.up.forward.app")
                                .font(.subheadline).bold()
                                .foregroundStyle(.white)
                                .frame(maxWidth: .infinity)
                                .padding(.vertical, 10)
                                .background(Color.rdBlue)
                                .clipShape(RoundedRectangle(cornerRadius: 10))
                        }
                    }
                    .padding(.vertical, 4)
                }
            } else {
                // Connected
                if let s = status, s.connected {
                    Section {
                        HStack(spacing: 12) {
                            ZStack {
                                Circle().fill(Color.rdGreen.opacity(0.15))
                                    .frame(width: 40, height: 40)
                                Image(systemName: "checkmark.circle.fill")
                                    .foregroundStyle(Color.rdGreen)
                            }
                            VStack(alignment: .leading, spacing: 2) {
                                Text("Conectado")
                                    .font(.subheadline).bold()
                                if let name = s.fb_user_name {
                                    Text(name).font(.caption).foregroundStyle(.secondary)
                                }
                                if let accId = s.selected_account, let accName = s.ad_accounts?.first(where: { $0.id == accId })?.name {
                                    Text(accName).font(.caption2).foregroundStyle(.secondary)
                                }
                            }
                        }
                    }
                }

                Section("Campañas (\(campaigns.count))") {
                    if campaigns.isEmpty {
                        Text("Sin campañas activas. Crea una nueva en la web.")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .padding(.vertical, 12)
                    } else {
                        ForEach(campaigns) { c in
                            campaignRow(c)
                        }
                    }
                }

                Section {
                    Link(destination: webUrl) {
                        Label("Crear nueva campaña en web", systemImage: "plus.circle.fill")
                            .foregroundStyle(Color.rdBlue)
                    }
                } footer: {
                    Text("La creación de campañas y conexión con Meta requiere el flujo web.")
                        .font(.caption)
                }
            }

            if let err = errorMsg {
                Section {
                    Label(err, systemImage: "exclamationmark.triangle")
                        .font(.caption).foregroundStyle(Color.rdRed)
                }
            }
        }
        .navigationTitle("Publicidad")
        .navigationBarTitleDisplayMode(.inline)
        .task { await load() }
        .refreshable { await load() }
        .alert("¿Eliminar campaña?", isPresented: Binding(get: { deleteTarget != nil }, set: { if !$0 { deleteTarget = nil } })) {
            Button("Cancelar", role: .cancel) { deleteTarget = nil }
            Button("Eliminar", role: .destructive) {
                if let c = deleteTarget { Task { await deleteCampaign(c) } }
            }
        } message: {
            Text("Esta campaña se eliminará permanentemente de Meta Ads.")
        }
    }

    @ViewBuilder
    private func campaignRow(_ c: AdCampaign) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(c.name ?? "Campaña sin nombre")
                        .font(.subheadline).bold()
                        .lineLimit(2)
                    if let lt = c.listing_title {
                        Text(lt).font(.caption2).foregroundStyle(.secondary).lineLimit(1)
                    }
                }
                Spacer()
                statusPill(c.status)
            }

            HStack(spacing: 14) {
                metric("Imp.", value: "\(c.impressions ?? 0)")
                metric("Clicks", value: "\(c.clicks ?? 0)")
                metric("Gasto", value: "$\(c.spend_usd ?? "0.00")")
                if let ctr = c.ctr { metric("CTR", value: "\(ctr)%") }
            }
            .padding(.top, 4)

            HStack(spacing: 8) {
                Button {
                    Task { await toggleStatus(c) }
                } label: {
                    if togglingIds.contains(c.campaign_id) {
                        ProgressView().scaleEffect(0.7).frame(width: 50, height: 22)
                    } else {
                        Text(c.status == "ACTIVE" ? "Pausar" : "Reanudar")
                            .font(.caption).bold()
                            .foregroundStyle(Color.rdBlue)
                            .padding(.horizontal, 10).padding(.vertical, 4)
                            .background(Color.rdBlue.opacity(0.1))
                            .clipShape(Capsule())
                    }
                }
                .disabled(togglingIds.contains(c.campaign_id))
                .buttonStyle(.plain)

                Button {
                    deleteTarget = c
                } label: {
                    Text("Eliminar")
                        .font(.caption).bold()
                        .foregroundStyle(Color.rdRed)
                        .padding(.horizontal, 10).padding(.vertical, 4)
                        .background(Color.rdRed.opacity(0.1))
                        .clipShape(Capsule())
                }
                .buttonStyle(.plain)
            }
            .padding(.top, 4)
        }
        .padding(.vertical, 4)
    }

    @ViewBuilder
    private func statusPill(_ s: String?) -> some View {
        let color: Color = (s == "ACTIVE") ? .rdGreen : (s == "PAUSED" ? .orange : .secondary)
        Text(s == "ACTIVE" ? "Activa" : (s == "PAUSED" ? "Pausada" : (s ?? "—")))
            .font(.caption2).bold()
            .foregroundStyle(color)
            .padding(.horizontal, 8).padding(.vertical, 3)
            .background(color.opacity(0.12))
            .clipShape(Capsule())
    }

    private func metric(_ label: String, value: String) -> some View {
        VStack(alignment: .leading, spacing: 1) {
            Text(value).font(.caption).bold().foregroundStyle(Color.rdBlue)
            Text(label).font(.caption2).foregroundStyle(.secondary)
        }
    }

    // MARK: - Actions

    private func load() async {
        if campaigns.isEmpty { loading = true }
        errorMsg = nil
        do {
            async let s: MetaStatusResponse = api.getMetaStatus()
            async let c: AdCampaignsResponse = api.getAdCampaigns()
            let (st, cs) = try await (s, c)
            status = st
            campaigns = cs.campaigns
        } catch {
            errorMsg = error.localizedDescription
        }
        loading = false
    }

    private func toggleStatus(_ c: AdCampaign) async {
        togglingIds.insert(c.campaign_id)
        defer { togglingIds.remove(c.campaign_id) }
        do {
            try await api.toggleAdCampaign(id: c.campaign_id)
            await load()
        } catch {
            errorMsg = error.localizedDescription
        }
    }

    private func deleteCampaign(_ c: AdCampaign) async {
        do {
            try await api.deleteAdCampaign(id: c.campaign_id)
            campaigns.removeAll { $0.campaign_id == c.campaign_id }
        } catch {
            errorMsg = error.localizedDescription
        }
        deleteTarget = nil
    }
}
