import SwiftUI

struct AgencyPortfolioView: View {
    let slug: String

    @State private var agencyName = ""
    @State private var listings:   [Listing] = []
    @State private var page        = 0
    @State private var totalPages  = 1
    @State private var total       = 0
    @State private var loading     = false
    @State private var initialLoad = true

    private let columns = [GridItem(.flexible(), spacing: 14), GridItem(.flexible(), spacing: 14)]

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {

                // ── Header ─────────────────────────────────────────
                VStack(alignment: .leading, spacing: 6) {
                    HStack(spacing: 12) {
                        ZStack {
                            Circle()
                                .fill(LinearGradient(
                                    colors: [Color.rdBlue, Color.rdBlue.opacity(0.7)],
                                    startPoint: .topLeading,
                                    endPoint: .bottomTrailing))
                                .frame(width: 56, height: 56)
                            Image(systemName: "building.2.fill")
                                .font(.title2)
                                .foregroundStyle(.white)
                        }
                        VStack(alignment: .leading, spacing: 3) {
                            if agencyName.isEmpty {
                                RoundedRectangle(cornerRadius: 4)
                                    .fill(Color(.systemGray5))
                                    .frame(width: 160, height: 20)
                            } else {
                                Text(agencyName)
                                    .font(.title3).bold()
                            }
                            Text(total == 0 ? "" : "\(total) propiedad\(total == 1 ? "" : "es")")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                    }
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 20)

                Divider()

                // ── Grid ───────────────────────────────────────────
                if initialLoad && loading {
                    VStack(spacing: 14) {
                        ProgressView()
                        Text("Cargando portafolio…")
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.top, 60)
                } else if listings.isEmpty && !loading {
                    ContentUnavailableView(
                        "Sin propiedades",
                        systemImage: "house.slash",
                        description: Text("Esta agencia no tiene propiedades publicadas.")
                    )
                    .padding(.top, 40)
                } else {
                    LazyVGrid(columns: columns, spacing: 14) {
                        ForEach(listings) { listing in
                            NavigationLink {
                                ListingDetailView(id: listing.id)
                            } label: {
                                GridCard(listing: listing)
                            }
                            .buttonStyle(.plain)
                            .onAppear {
                                if listing.id == listings.last?.id {
                                    Task { await loadMore() }
                                }
                            }
                        }
                    }
                    .padding(16)

                    if loading {
                        ProgressView().padding(.bottom, 24)
                    }
                }
            }
        }
        .navigationTitle(agencyName.isEmpty ? "Portafolio" : agencyName)
        .navigationBarTitleDisplayMode(.inline)
        .task { await loadMore() }
    }

    private func loadMore() async {
        guard !loading, page < totalPages else { return }
        loading = true
        page += 1
        do {
            let result = try await APIService.shared.getAgency(slug: slug, page: page)
            if agencyName.isEmpty { agencyName = result.name }
            total      = result.total
            totalPages = result.pages
            listings.append(contentsOf: result.listings)
        } catch {
            // silently ignore — show whatever was loaded
        }
        initialLoad = false
        loading = false
    }
}
