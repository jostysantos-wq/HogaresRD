// LeadQueueView.swift
//
// Broker-side cascade tray. Lists leads visible to the current
// agent at the tier they're eligible for (1=exclusive, 2=priority,
// 3=open). Tapping a lead claims it via /api/lead-queue/:id/claim.
// Mirrors the web's broker.html#lead-queue surface.

import SwiftUI

struct LeadQueueView: View {
    @EnvironmentObject var api: APIService

    @State private var leads:    [LeadQueueItem] = []
    @State private var loading:  Bool = false
    @State private var claiming: Set<String> = []
    @State private var errorMsg: String?
    @State private var bannerMsg: String?

    var body: some View {
        Group {
            if loading && leads.isEmpty {
                VStack(spacing: 12) {
                    ProgressView()
                    Text("Cargando leads…")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if leads.isEmpty {
                emptyState
            } else {
                List {
                    ForEach(leads) { lead in
                        leadRow(lead)
                    }
                }
                .listStyle(.insetGrouped)
                .scrollContentBackground(.hidden)
                .background(Color(.systemBackground))
            }
        }
        .navigationTitle("Cola de leads")
        .navigationBarTitleDisplayMode(.inline)
        .task { await load() }
        .refreshable { await load() }
        .toolbar {
            ToolbarItem(placement: .navigationBarTrailing) {
                Button { Task { await load() } } label: {
                    Image(systemName: "arrow.clockwise")
                }.disabled(loading)
            }
        }
        .overlay(alignment: .top) {
            if let banner = bannerMsg {
                Text(banner)
                    .font(.subheadline.bold())
                    .foregroundStyle(.white)
                    .padding(.horizontal, 16)
                    .padding(.vertical, 10)
                    .background(Color.rdGreen)
                    .clipShape(Capsule())
                    .padding(.top, 8)
                    .transition(.move(edge: .top).combined(with: .opacity))
            }
        }
    }

    private var emptyState: some View {
        ContentUnavailableView(
            "No hay leads en cola",
            systemImage: "tray",
            description: Text("Cuando un cliente envíe una consulta sobre una propiedad afiliada a tu equipo, aparecerá aquí. Las ofertas exclusivas duran 15 minutos.")
        )
    }

    @ViewBuilder
    private func leadRow(_ lead: LeadQueueItem) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 12) {
                if let imgURL = lead.listing_image, let url = URL(string: imgURL) {
                    AsyncImage(url: url) { phase in
                        switch phase {
                        case .success(let img): img.resizable().scaledToFill()
                        default: Color(.tertiarySystemFill)
                        }
                    }
                    .frame(width: 64, height: 48)
                    .clipShape(RoundedRectangle(cornerRadius: 8))
                } else {
                    ZStack {
                        RoundedRectangle(cornerRadius: 8).fill(Color(.tertiarySystemFill))
                        Image(systemName: "house.fill").foregroundStyle(.secondary)
                    }
                    .frame(width: 64, height: 48)
                }

                VStack(alignment: .leading, spacing: 3) {
                    Text(lead.listing_title ?? "Propiedad")
                        .font(.subheadline.bold())
                        .lineLimit(1)
                    HStack(spacing: 6) {
                        if let city = lead.listing_city, !city.isEmpty {
                            Label(city, systemImage: "mappin.circle")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                        if let price = lead.listing_price?.value, !price.isEmpty {
                            Text("· \(price)")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                    }
                }
                Spacer()
                tierBadge(lead.tier ?? 3)
            }

            HStack {
                if let buyer = lead.buyer_name, !buyer.isEmpty {
                    Label(buyer, systemImage: "person.fill")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Spacer()
                if let ms = lead.remaining_ms, ms > 0 {
                    Label(formatRemaining(ms), systemImage: "clock")
                        .font(.caption.bold())
                        .foregroundStyle(.orange)
                }
            }

            Button {
                Task { await claim(lead) }
            } label: {
                HStack {
                    if claiming.contains(lead.id) {
                        ProgressView().tint(.white)
                    }
                    Text(claiming.contains(lead.id) ? "Reclamando…" : "Reclamar lead")
                        .font(.subheadline.bold())
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, 10)
                .background(Color.rdBlue)
                .foregroundStyle(.white)
                .clipShape(RoundedRectangle(cornerRadius: 10))
            }
            .disabled(claiming.contains(lead.id))
            .buttonStyle(.plain)
        }
        .padding(.vertical, 4)
    }

    @ViewBuilder
    private func tierBadge(_ tier: Int) -> some View {
        let label: String = {
            switch tier {
            case 1: return "Exclusiva"
            case 2: return "Prioritaria"
            default: return "Abierta"
            }
        }()
        let color: Color = {
            switch tier {
            case 1: return .purple
            case 2: return Color.rdBlue
            default: return .gray
            }
        }()
        Text(label)
            .font(.caption2.bold())
            .foregroundStyle(color)
            .padding(.horizontal, 8).padding(.vertical, 3)
            .background(color.opacity(0.12))
            .clipShape(Capsule())
    }

    private func formatRemaining(_ ms: Int) -> String {
        let s = ms / 1000
        if s < 60 { return "\(s)s" }
        if s < 3600 { return "\(s/60) min" }
        return "\(s/3600) h"
    }

    private func load() async {
        loading = true
        errorMsg = nil
        defer { loading = false }
        do {
            let list = try await api.getLeadQueue()
            await MainActor.run { leads = list }
        } catch {
            await MainActor.run { errorMsg = (error as? LocalizedError)?.errorDescription ?? "No se pudieron cargar." }
        }
    }

    private func claim(_ lead: LeadQueueItem) async {
        claiming.insert(lead.id)
        defer { claiming.remove(lead.id) }
        do {
            _ = try await api.claimLeadFromQueue(id: lead.id)
            await MainActor.run {
                leads.removeAll { $0.id == lead.id }
                bannerMsg = "Lead reclamado ✓"
            }
            try? await Task.sleep(nanoseconds: 2_000_000_000)
            await MainActor.run { bannerMsg = nil }
        } catch {
            await MainActor.run {
                errorMsg = (error as? LocalizedError)?.errorDescription ?? "No se pudo reclamar."
                bannerMsg = errorMsg
            }
            try? await Task.sleep(nanoseconds: 3_000_000_000)
            await MainActor.run { bannerMsg = nil }
        }
    }
}
