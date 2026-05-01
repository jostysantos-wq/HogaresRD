import SwiftUI

struct SavedListingsView: View {
    @EnvironmentObject var saved: SavedStore

    @State private var listings: [Listing] = []
    @State private var loading = false

    private let columns = [GridItem(.flexible(), spacing: 14), GridItem(.flexible(), spacing: 14)]

    var body: some View {
        Group {
            if loading {
                VStack(spacing: 14) {
                    ProgressView()
                    Text("Cargando favoritos…")
                        .font(.subheadline).foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if listings.isEmpty {
                ContentUnavailableView(
                    "Sin favoritos",
                    systemImage: "heart.slash",
                    description: Text("Guarda propiedades tocando el corazón en el feed.")
                )
            } else {
                ScrollView {
                    LazyVGrid(columns: columns, spacing: 14) {
                        ForEach(listings) { listing in
                            NavigationLink {
                                ListingDetailView(id: listing.id)
                            } label: {
                                ZStack(alignment: .topTrailing) {
                                    GridCard(listing: listing)
                                    Button {
                                        saved.toggle(listing.id)
                                        listings.removeAll { $0.id == listing.id }
                                    } label: {
                                        Image(systemName: "heart.fill")
                                            .font(.caption).bold()
                                            .foregroundStyle(Color.rdRed)
                                            .padding(6)
                                            .background(.ultraThinMaterial)
                                            .clipShape(Circle())
                                    }
                                    .buttonStyle(.plain)
                                    .padding(7)
                                }
                            }
                            .buttonStyle(.plain)
                        }
                    }
                    .padding(16)
                }
            }
        }
        .navigationTitle("Mis Favoritos")
        .task { await fetchSaved() }
        .onChange(of: saved.savedIDs) { _, _ in Task { await fetchSaved() } }
    }

    private func fetchSaved() async {
        let ids = Array(saved.savedIDs)
        guard !ids.isEmpty else { listings = []; return }
        loading = true
        listings = await withTaskGroup(of: Listing?.self) { group in
            for id in ids { group.addTask { try? await APIService.shared.getListing(id: id) } }
            var result: [Listing] = []
            for await l in group { if let l { result.append(l) } }
            return result.sorted { $0.title < $1.title }
        }
        loading = false
    }
}
