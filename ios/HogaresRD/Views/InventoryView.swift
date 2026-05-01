import SwiftUI

// MARK: - Inventory Management View
//
// Wave 8-C refactor: 56pt thumbnail row pattern (Airbnb-style), status
// pills via `DSStatusBadge`, empty state via `EmptyStateView.calm`.

struct InventoryManagementView: View {
    let listingId: String
    let listingTitle: String
    var unitTypes: [ListingUnit]?

    @EnvironmentObject var api: APIService
    @State private var units: [UnitInventoryItem] = []
    @State private var loading = true
    @State private var errorMsg: String?

    // Add unit form
    @State private var showAdd = false
    @State private var newLabel = ""
    @State private var newType = ""
    @State private var newFloor = ""
    @State private var adding = false

    var body: some View {
        List {
            // Summary header
            Section {
                VStack(alignment: .leading, spacing: Spacing.s8) {
                    Text(listingTitle)
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(Color.rdInk)
                        .lineLimit(2)

                    if !units.isEmpty {
                        HStack(spacing: Spacing.s12) {
                            summaryPill(count: units.count, label: "Total", color: .rdBlue)
                            summaryPill(count: units.filter { $0.status == "available" }.count, label: "Disponibles", color: .rdGreen)
                            summaryPill(count: units.filter { $0.status == "reserved" }.count, label: "Reservadas", color: .rdOrange)
                            summaryPill(count: units.filter { $0.status == "sold" }.count, label: "Vendidas", color: .rdRed)
                        }
                    }
                }
                .padding(.vertical, Spacing.s4)
            }

            // Add unit section
            Section {
                Button {
                    showAdd.toggle()
                } label: {
                    Label(showAdd ? "Cancelar" : "Agregar unidad", systemImage: showAdd ? "xmark" : "plus.circle.fill")
                        .foregroundStyle(showAdd ? Color.rdInkSoft : Color.rdAccent)
                }

                if showAdd {
                    VStack(spacing: Spacing.s8) {
                        TextField("Etiqueta (ej: Edif. 3 - Apt 2B)", text: $newLabel)
                            .textFieldStyle(.roundedBorder)

                        if let types = unitTypes, !types.isEmpty {
                            Picker("Tipo de unidad", selection: $newType) {
                                Text("Seleccionar tipo...").tag("")
                                ForEach(types, id: \.name) { ut in
                                    if let name = ut.name {
                                        Text(name).tag(name)
                                    }
                                }
                            }
                            .pickerStyle(.menu)
                        } else {
                            TextField("Tipo (ej: Penthouse 3BR)", text: $newType)
                                .textFieldStyle(.roundedBorder)
                        }

                        TextField("Piso (opcional)", text: $newFloor)
                            .textFieldStyle(.roundedBorder)

                        Button {
                            Task { await addUnit() }
                        } label: {
                            HStack {
                                Spacer()
                                if adding {
                                    ProgressView().tint(.white)
                                } else {
                                    Text("Agregar Unidad").bold()
                                }
                                Spacer()
                            }
                            .padding(.vertical, Spacing.s8)
                            .background(newLabel.isEmpty ? Color.rdMuted : Color.rdAccent)
                            .foregroundStyle(.white)
                            .clipShape(RoundedRectangle(cornerRadius: Radius.medium))
                        }
                        .disabled(newLabel.isEmpty || adding)
                        .buttonStyle(.plain)
                    }
                }
            }

            // Error
            if let err = errorMsg {
                Section {
                    Label(err, systemImage: "exclamationmark.triangle")
                        .font(.caption)
                        .foregroundStyle(Color.rdRed)
                }
            }

            // Units list
            if loading {
                Section { ProgressView() }
            } else if units.isEmpty {
                Section {
                    EmptyStateView.calm(
                        systemImage: "building.2",
                        title: "Sin unidades registradas",
                        description: "Agrega las unidades individuales de esta propiedad para rastrear su disponibilidad."
                    )
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, Spacing.s24)
                }
            } else {
                // Available
                let available = units.filter { $0.status == "available" }
                if !available.isEmpty {
                    Section("Disponibles (\(available.count))") {
                        ForEach(available) { unit in
                            UnitRow(unit: unit)
                        }
                        .onDelete { offsets in
                            let toDelete = offsets.map { available[$0] }
                            for unit in toDelete {
                                Task { await deleteUnit(unit) }
                            }
                        }
                    }
                }

                // Reserved
                let reserved = units.filter { $0.status == "reserved" }
                if !reserved.isEmpty {
                    Section("Reservadas (\(reserved.count))") {
                        ForEach(reserved) { unit in
                            UnitRow(unit: unit)
                                .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                                    Button {
                                        Task { await releaseUnit(unit) }
                                    } label: {
                                        Label("Liberar", systemImage: "arrow.uturn.backward")
                                    }
                                    .tint(Color.rdOrange)
                                }
                        }
                    }
                }

                // Sold
                let sold = units.filter { $0.status == "sold" }
                if !sold.isEmpty {
                    Section("Vendidas (\(sold.count))") {
                        ForEach(sold) { unit in
                            UnitRow(unit: unit)
                        }
                    }
                }
            }
        }
        .navigationTitle("Inventario")
        .navigationBarTitleDisplayMode(.inline)
        .task { await load() }
        .refreshable { await load() }
    }

    // MARK: - Subviews

    private func summaryPill(count: Int, label: String, color: Color) -> some View {
        VStack(spacing: 2) {
            Text("\(count)")
                .font(.title3.weight(.bold))
                .foregroundStyle(color)
            Text(label)
                .font(.caption2)
                .foregroundStyle(Color.rdInkSoft)
        }
        .frame(maxWidth: .infinity)
    }

    // MARK: - Actions

    private func load() async {
        if units.isEmpty { loading = true }
        errorMsg = nil
        do {
            let result = try await api.getInventory(listingId: listingId)
            units = result.inventory
        } catch {
            errorMsg = error.localizedDescription
        }
        loading = false
    }

    private func addUnit() async {
        adding = true
        errorMsg = nil
        do {
            let unit = try await api.addInventoryUnit(
                listingId: listingId,
                label: newLabel.trimmingCharacters(in: .whitespaces),
                type: newType,
                floor: newFloor
            )
            units.append(unit)
            newLabel = ""
            newType = ""
            newFloor = ""
            showAdd = false
            let impact = UINotificationFeedbackGenerator()
            impact.notificationOccurred(.success)
        } catch {
            errorMsg = error.localizedDescription
        }
        adding = false
    }

    private func deleteUnit(_ unit: UnitInventoryItem) async {
        do {
            try await api.deleteInventoryUnit(listingId: listingId, unitId: unit.id)
            units.removeAll { $0.id == unit.id }
        } catch {
            errorMsg = error.localizedDescription
        }
    }

    private func releaseUnit(_ unit: UnitInventoryItem) async {
        errorMsg = nil
        do {
            try await api.releaseUnit(listingId: listingId, unitId: unit.id)
            // Refresh so the unit moves into the Disponibles section with
            // cleared buyer info. Easier than mutating in place.
            await load()
            UINotificationFeedbackGenerator().notificationOccurred(.success)
        } catch {
            errorMsg = error.localizedDescription
        }
    }
}

// MARK: - Unit Row
//
// Airbnb-style 56pt leading thumbnail (a tinted tile with a building
// glyph since units don't have individual photos), title + caption
// stacked, trailing `DSStatusBadge` for unit status.

struct UnitRow: View {
    let unit: UnitInventoryItem

    private var statusTint: Color {
        switch unit.status {
        case "available": return .rdGreen
        case "reserved":  return .rdOrange
        case "sold":      return .rdRed
        default:          return .rdMuted
        }
    }

    var body: some View {
        HStack(spacing: Spacing.s12) {
            // 56pt thumbnail tile
            ZStack {
                RoundedRectangle(cornerRadius: Radius.medium, style: .continuous)
                    .fill(statusTint.opacity(0.12))
                Image(systemName: "building.2.fill")
                    .font(.title3)
                    .foregroundStyle(statusTint)
            }
            .frame(width: 56, height: 56)
            .accessibilityHidden(true)

            VStack(alignment: .leading, spacing: 2) {
                Text(unit.label)
                    .font(.body)
                    .foregroundStyle(Color.rdInk)
                    .lineLimit(1)
                if let type = unit.type, !type.isEmpty {
                    Text(type)
                        .font(.caption)
                        .foregroundStyle(Color.rdInkSoft)
                        .lineLimit(1)
                }
                if let client = unit.clientName, !client.isEmpty {
                    Label(client, systemImage: "person.fill")
                        .font(.caption2)
                        .foregroundStyle(statusTint)
                        .lineLimit(1)
                }
            }

            Spacer(minLength: Spacing.s8)

            DSStatusBadge(label: unit.statusLabel, tint: statusTint)
        }
        .padding(.vertical, Spacing.s4)
        .frame(minHeight: 56)
        .contentShape(Rectangle())
    }
}

// MARK: - Compact Inventory Display (for listing detail)

struct InventoryBadgeView: View {
    let units: [UnitInventoryItem]

    var body: some View {
        let available = units.filter { $0.status == "available" }.count
        let reserved  = units.filter { $0.status == "reserved" }.count
        let sold      = units.filter { $0.status == "sold" }.count

        HStack(spacing: Spacing.s8) {
            DSPill(label: "Disponibles \(available)", tint: .rdGreen)
            DSPill(label: "Reservadas \(reserved)", tint: .rdOrange)
            DSPill(label: "Vendidas \(sold)", tint: .rdRed)
        }
        .padding(Spacing.s12)
        .background(Color.rdSurface)
        .clipShape(RoundedRectangle(cornerRadius: Radius.medium))
    }
}
