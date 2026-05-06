import SwiftUI

// MARK: - ComparisonView
/// Side-by-side comparison of 2-3 property listings.
/// Users select listings from BrowseView, then open this view.
struct ComparisonView: View {
    @Binding var selectedIds: [String]
    @State private var listings: [Listing] = []
    @State private var loading = true
    @State private var error: String?
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            Group {
                if loading {
                    ProgressView("Cargando propiedades...")
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                } else if let error {
                    VStack(spacing: 16) {
                        Image(systemName: "exclamationmark.triangle")
                            .font(.system(size: 40))
                            .foregroundColor(.orange)
                        Text(error)
                            .foregroundColor(.secondary)
                        Button("Reintentar") { Task { await load() } }
                            .buttonStyle(.borderedProminent)
                    }
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                } else if listings.isEmpty {
                    VStack(spacing: 16) {
                        Image(systemName: "square.split.2x1")
                            .font(.system(size: 50))
                            .foregroundColor(.secondary)
                        Text("Sin propiedades para comparar")
                            .font(.headline)
                        Text("Selecciona 2 o 3 propiedades desde la vista de explorar.")
                            .foregroundColor(.secondary)
                            .multilineTextAlignment(.center)
                            .padding(.horizontal)
                    }
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                } else {
                    comparisonContent
                }
            }
            .navigationTitle("Comparar")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .navigationBarLeading) {
                    Button("Cerrar") { dismiss() }
                }
                if !listings.isEmpty {
                    ToolbarItem(placement: .navigationBarTrailing) {
                        Button("Limpiar") {
                            selectedIds.removeAll()
                            dismiss()
                        }
                        .foregroundColor(.red)
                    }
                }
            }
        }
        .task { await load() }
    }

    // MARK: - Load listings
    private func load() async {
        loading = true
        error = nil
        do {
            var fetched: [Listing] = []
            for id in selectedIds {
                let listing = try await APIService.shared.getListing(id: id)
                fetched.append(listing)
            }
            listings = fetched
            loading = false
        } catch {
            self.error = "No se pudieron cargar las propiedades."
            loading = false
        }
    }

    // MARK: - Comparison content
    private var comparisonContent: some View {
        ScrollView {
            VStack(spacing: 0) {
                // Image headers
                headerRow

                Divider()

                // Data rows
                ForEach(comparisonRows, id: \.label) { row in
                    comparisonRow(row)
                    Divider()
                }

                // Amenities section
                amenitiesSection

                // Action buttons
                actionButtons
            }
            .padding(.bottom, 24)
        }
    }

    // MARK: - Header row with images and prices
    private var headerRow: some View {
        HStack(alignment: .top, spacing: 0) {
            ForEach(listings) { listing in
                VStack(spacing: 0) {
                    // Image
                    if let url = listing.firstImageURL {
                        CachedAsyncImage(url: url) { phase in
                            switch phase {
                            case .success(let img):
                                img.resizable().aspectRatio(contentMode: .fill)
                                    .frame(height: 160).clipped()
                            default:
                                placeholderImage
                            }
                        }
                    } else {
                        placeholderImage
                    }

                    // Price & title
                    VStack(alignment: .leading, spacing: 4) {
                        Text(listing.priceFormatted)
                            .font(.system(size: 18, weight: .bold))
                            .foregroundColor(.accentColor)

                        if listing.type == "alquiler" {
                            Text("/mes")
                                .font(.caption)
                                .foregroundColor(.secondary)
                        }

                        Text(listing.title)
                            .font(.system(size: 13, weight: .semibold))
                            .lineLimit(2)

                        if let city = listing.city ?? listing.sector {
                            HStack(spacing: 3) {
                                Image(systemName: "mappin.circle.fill")
                                    .font(.system(size: 10))
                                Text(city + (listing.province.map { ", \($0)" } ?? ""))
                                    .font(.system(size: 11))
                            }
                            .foregroundColor(.secondary)
                        }

                        // Remove button
                        Button {
                            selectedIds.removeAll { $0 == listing.id }
                            listings.removeAll { $0.id == listing.id }
                        } label: {
                            Label("Quitar", systemImage: "xmark.circle")
                                .font(.system(size: 11, weight: .medium))
                                .foregroundColor(.red)
                        }
                        .padding(.top, 4)
                    }
                    .padding(12)
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
                .frame(maxWidth: .infinity)
                if listing.id != listings.last?.id {
                    Divider()
                }
            }
        }
        .background(Color(.systemBackground))
    }

    private var placeholderImage: some View {
        Rectangle()
            .fill(LinearGradient(colors: [.blue.opacity(0.3), .blue.opacity(0.1)], startPoint: .topLeading, endPoint: .bottomTrailing))
            .frame(height: 160)
            .overlay(
                Image(systemName: "house.fill")
                    .font(.system(size: 30))
                    .foregroundColor(.white.opacity(0.5))
            )
    }

    // MARK: - Data rows
    private struct CompRow {
        let label: String
        let values: [String]
        let highlight: Int? // index of best value
    }

    private var comparisonRows: [CompRow] {
        var rows: [CompRow] = []

        rows.append(CompRow(
            label: "Tipo",
            values: listings.map { $0.typeLabel },
            highlight: nil
        ))

        rows.append(CompRow(
            label: "Area (m\u{00B2})",
            values: listings.map { $0.area_const.map { "\($0) m\u{00B2}" } ?? "—" },
            highlight: bestIndex(listings.map { Double($0.area_const ?? "") }, highest: true)
        ))

        rows.append(CompRow(
            label: "Terreno",
            values: listings.map { $0.area_land.map { "\($0) m\u{00B2}" } ?? "—" },
            highlight: nil
        ))

        // Price per m2
        let ppm2 = listings.map { listing -> Double? in
            guard let p = Double(listing.price), let a = Double(listing.area_const ?? ""), a > 0 else { return nil }
            return p / a
        }
        rows.append(CompRow(
            label: "Precio/m\u{00B2}",
            values: ppm2.map { val in
                guard let v = val else { return "—" }
                return "$\(Int(v).formatted())/m\u{00B2}"
            },
            highlight: bestIndex(ppm2, highest: false)
        ))

        rows.append(CompRow(
            label: "Habitaciones",
            values: listings.map { $0.bedrooms ?? "—" },
            highlight: bestIndex(listings.map { Double($0.bedrooms ?? "") }, highest: true)
        ))

        rows.append(CompRow(
            label: "Ba\u{00F1}os",
            values: listings.map { $0.bathrooms ?? "—" },
            highlight: bestIndex(listings.map { Double($0.bathrooms ?? "") }, highest: true)
        ))

        rows.append(CompRow(
            label: "Parqueos",
            values: listings.map { $0.parking ?? "—" },
            highlight: nil
        ))

        rows.append(CompRow(
            label: "Provincia",
            values: listings.map { $0.province ?? "—" },
            highlight: nil
        ))

        rows.append(CompRow(
            label: "Ciudad",
            values: listings.map { $0.city ?? "—" },
            highlight: nil
        ))

        rows.append(CompRow(
            label: "Sector",
            values: listings.map { $0.sector ?? "—" },
            highlight: nil
        ))

        return rows
    }

    private func bestIndex(_ vals: [Double?], highest: Bool) -> Int? {
        let filtered = vals.enumerated().compactMap { (i, v) -> (Int, Double)? in
            guard let v else { return nil }
            return (i, v)
        }
        guard filtered.count > 1 else { return nil }
        if highest {
            return filtered.max(by: { $0.1 < $1.1 })?.0
        } else {
            return filtered.min(by: { $0.1 < $1.1 })?.0
        }
    }

    private func comparisonRow(_ row: CompRow) -> some View {
        HStack(spacing: 0) {
            ForEach(Array(row.values.enumerated()), id: \.offset) { idx, val in
                VStack(alignment: .leading, spacing: 2) {
                    if idx == 0 {
                        Text(row.label)
                            .font(.system(size: 10, weight: .bold))
                            .foregroundColor(.secondary)
                            .textCase(.uppercase)
                    } else {
                        Text(row.label)
                            .font(.system(size: 10, weight: .bold))
                            .foregroundColor(.clear) // invisible label for alignment
                            .textCase(.uppercase)
                    }
                    Text(val)
                        .font(.system(size: 14, weight: row.highlight == idx ? .bold : .medium))
                        .foregroundColor(row.highlight == idx ? .green : (val == "—" ? .secondary : .primary))
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 10)
                .frame(maxWidth: .infinity, alignment: .leading)
                if idx < row.values.count - 1 {
                    Divider()
                }
            }
        }
        .background(Color(.systemBackground))
    }

    // MARK: - Amenities comparison
    private var amenitiesSection: some View {
        let allAmenities = Array(Set(listings.flatMap { $0.amenities })).sorted()
        guard !allAmenities.isEmpty else { return AnyView(EmptyView()) }

        return AnyView(
            VStack(alignment: .leading, spacing: 8) {
                Text("AMENIDADES")
                    .font(.system(size: 11, weight: .bold))
                    .foregroundColor(.secondary)
                    .padding(.horizontal, 16)
                    .padding(.top, 12)

                HStack(alignment: .top, spacing: 0) {
                    ForEach(listings) { listing in
                        let has = Set(listing.amenities)
                        VStack(alignment: .leading, spacing: 4) {
                            ForEach(allAmenities, id: \.self) { amenity in
                                HStack(spacing: 4) {
                                    Image(systemName: has.contains(amenity) ? "checkmark.circle.fill" : "xmark.circle")
                                        .font(.system(size: 11))
                                        .foregroundColor(has.contains(amenity) ? .green : .secondary.opacity(0.4))
                                    Text(amenity)
                                        .font(.system(size: 11))
                                        .foregroundColor(has.contains(amenity) ? .primary : .secondary.opacity(0.5))
                                        .strikethrough(!has.contains(amenity))
                                }
                            }
                        }
                        .padding(12)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        if listing.id != listings.last?.id {
                            Divider()
                        }
                    }
                }
                .background(Color(.systemBackground))

                Divider()
            }
        )
    }

    // MARK: - Action buttons
    private var actionButtons: some View {
        VStack(spacing: 12) {
            ForEach(listings) { listing in
                NavigationLink(destination: ListingDetailView(id: listing.id)) {
                    Text("Ver \(listing.title)")
                        .font(.system(size: 13, weight: .semibold))
                        .lineLimit(1)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 10)
                        .background(Color.accentColor)
                        .foregroundColor(.white)
                        .cornerRadius(10)
                }
            }
        }
        .padding(16)
    }
}

// MARK: - Compare selection manager (used by BrowseView)
extension Notification.Name {
    /// Posted when CompareManager.toggle is called past capacity. UI
    /// surfaces (BrowseView) listen to render a transient toast.
    static let compareCapacityHit = Notification.Name("rd.compareCapacityHit")
}

class CompareManager: ObservableObject {
    static let shared = CompareManager()
    @Published var selectedIds: [String] = []

    let maxItems = 3

    @discardableResult
    func toggle(_ id: String) -> Bool {
        if let idx = selectedIds.firstIndex(of: id) {
            selectedIds.remove(at: idx)
            return true
        } else if selectedIds.count < maxItems {
            selectedIds.append(id)
            return true
        }
        // At capacity: tell listeners so they can show feedback.
        NotificationCenter.default.post(name: .compareCapacityHit, object: nil)
        return false
    }

    func isSelected(_ id: String) -> Bool {
        selectedIds.contains(id)
    }

    func clear() {
        selectedIds.removeAll()
    }
}
