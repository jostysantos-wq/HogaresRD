import SwiftUI

// MARK: - Inventory Management View

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
                VStack(alignment: .leading, spacing: 8) {
                    Text(listingTitle)
                        .font(.subheadline).bold()
                        .lineLimit(2)

                    if !units.isEmpty {
                        HStack(spacing: 12) {
                            summaryPill(count: units.count, label: "Total", color: .rdBlue)
                            summaryPill(count: units.filter { $0.status == "available" }.count, label: "Disponibles", color: .rdGreen)
                            summaryPill(count: units.filter { $0.status == "reserved" }.count, label: "Reservadas", color: .orange)
                            summaryPill(count: units.filter { $0.status == "sold" }.count, label: "Vendidas", color: .rdRed)
                        }
                    }
                }
                .padding(.vertical, 4)
            }

            // Add unit section
            Section {
                Button {
                    showAdd.toggle()
                } label: {
                    Label(showAdd ? "Cancelar" : "Agregar unidad", systemImage: showAdd ? "xmark" : "plus.circle.fill")
                        .foregroundStyle(showAdd ? .secondary : Color.rdBlue)
                }

                if showAdd {
                    VStack(spacing: 10) {
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
                            .padding(.vertical, 10)
                            .background(newLabel.isEmpty ? Color(.systemGray4) : Color.rdBlue)
                            .foregroundStyle(.white)
                            .clipShape(RoundedRectangle(cornerRadius: 10))
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
                        .foregroundStyle(.red)
                }
            }

            // Units list
            if loading {
                Section { ProgressView() }
            } else if units.isEmpty {
                Section {
                    VStack(spacing: 12) {
                        Image(systemName: "building.2")
                            .font(.system(size: 36))
                            .foregroundStyle(Color(.tertiaryLabel))
                        Text("Sin unidades registradas")
                            .font(.subheadline).foregroundStyle(.secondary)
                        Text("Agrega las unidades individuales de esta propiedad para rastrear su disponibilidad.")
                            .font(.caption).foregroundStyle(.tertiary)
                            .multilineTextAlignment(.center)
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 24)
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
                                    .tint(.orange)
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
                .font(.title3).bold()
                .foregroundStyle(color)
            Text(label)
                .font(.system(size: 9))
                .foregroundStyle(.secondary)
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

struct UnitRow: View {
    let unit: UnitInventoryItem

    private var statusColor: Color {
        switch unit.status {
        case "available": return .rdGreen
        case "reserved":  return .orange
        case "sold":      return .rdRed
        default:          return .secondary
        }
    }

    var body: some View {
        HStack(spacing: 12) {
            // Status dot
            Circle()
                .fill(statusColor)
                .frame(width: 10, height: 10)

            VStack(alignment: .leading, spacing: 2) {
                Text(unit.label)
                    .font(.subheadline).bold()
                if let type = unit.type, !type.isEmpty {
                    Text(type)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                if let client = unit.clientName, !client.isEmpty {
                    Label(client, systemImage: "person.fill")
                        .font(.caption2)
                        .foregroundStyle(statusColor)
                }
            }

            Spacer()

            Text(unit.statusLabel)
                .font(.caption2).bold()
                .foregroundStyle(statusColor)
                .padding(.horizontal, 8).padding(.vertical, 3)
                .background(statusColor.opacity(0.12))
                .clipShape(Capsule())
        }
        .padding(.vertical, 2)
    }
}

// MARK: - Compact Inventory Display (for listing detail)

struct InventoryBadgeView: View {
    let units: [UnitInventoryItem]

    var body: some View {
        let available = units.filter { $0.status == "available" }.count
        let reserved  = units.filter { $0.status == "reserved" }.count
        let sold      = units.filter { $0.status == "sold" }.count

        HStack(spacing: 10) {
            inventoryDot(count: available, label: "Disponibles", color: .rdGreen)
            inventoryDot(count: reserved, label: "Reservadas", color: .orange)
            inventoryDot(count: sold, label: "Vendidas", color: .rdRed)
        }
        .padding(12)
        .background(Color(.secondarySystemGroupedBackground))
        .clipShape(RoundedRectangle(cornerRadius: 12))
    }

    private func inventoryDot(count: Int, label: String, color: Color) -> some View {
        HStack(spacing: 4) {
            Circle().fill(color).frame(width: 8, height: 8)
            Text("\(count)")
                .font(.subheadline).bold()
                .foregroundStyle(color)
            Text(label)
                .font(.caption2)
                .foregroundStyle(.secondary)
        }
    }
}
