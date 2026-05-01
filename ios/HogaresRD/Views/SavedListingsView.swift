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
                EmptyStateView.calm(
                    systemImage: "heart",
                    title: "Aún no tienes propiedades guardadas",
                    description: "Toca el corazón en cualquier propiedad para guardarla aquí.",
                    actionTitle: "Explorar",
                    action: {
                        // Deep-link to the Explorar tab via the same
                        // notification ProfileTabView's quick-action chips
                        // use. ContentView routes only the Mensajes chip
                        // today; we extend the contract here so "Explorar"
                        // sends the user to tab 1 without needing more
                        // plumbing. Reuses an existing channel rather than
                        // adding a new Notification.Name.
                        NotificationCenter.default.post(
                            name: .profileQuickAction,
                            object: nil,
                            userInfo: ["destination": "explorar"]
                        )
                    }
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
                                            .frame(minWidth: 44, minHeight: 44)
                                            .contentShape(Rectangle())
                                    }
                                    .buttonStyle(.plain)
                                    .accessibilityLabel("Quitar de favoritos")
                                    .accessibilityHint("Elimina esta propiedad de tu lista de guardados")
                                    .padding(.top, 2)
                                    .padding(.trailing, 2)
                                }
                            }
                            .buttonStyle(.plain)
                        }
                    }
                    .padding(16)
                }
            }
        }
        .navigationTitle("Mis favoritos")
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
