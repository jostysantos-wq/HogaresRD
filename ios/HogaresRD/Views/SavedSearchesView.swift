import SwiftUI

// MARK: - Saved Searches list
//
// Wave 8-C refactor: rows render via `IconTileRow` against the editorial
// design system; empty state uses `EmptyStateView.calm` with a CTA; the
// "Nueva búsqueda" footer becomes a `bottomCTA(...)` modifier; the
// editor + detail forms are grouped into `FormCard`s.

struct SavedSearchesView: View {
    @EnvironmentObject var api: APIService

    @State private var searches: [SavedSearch] = []
    @State private var loading = true
    @State private var errorMsg: String?
    @State private var showCreate = false
    @State private var searchToDelete: SavedSearch?

    var body: some View {
        Group {
            if loading {
                ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if let err = errorMsg, searches.isEmpty {
                EmptyStateView.calm(
                    systemImage: "exclamationmark.triangle",
                    title: "No pudimos cargar tus búsquedas",
                    description: err,
                    actionTitle: "Reintentar",
                    action: { Task { await load() } }
                )
            } else if searches.isEmpty {
                EmptyStateView.calm(
                    systemImage: "magnifyingglass.circle",
                    title: "Aún no tienes búsquedas guardadas",
                    description: "Crea una búsqueda guardada para recibir alertas cuando aparezcan nuevas propiedades que coincidan con tus criterios.",
                    actionTitle: "Crear búsqueda",
                    action: { showCreate = true }
                )
            } else {
                ScrollView {
                    VStack(spacing: Spacing.s8) {
                        ForEach(searches) { s in
                            NavigationLink {
                                SavedSearchDetailView(search: s, onChange: { updated in
                                    if let idx = searches.firstIndex(where: { $0.id == updated.id }) {
                                        searches[idx] = updated
                                    }
                                }, onDelete: {
                                    searches.removeAll { $0.id == s.id }
                                })
                                .environmentObject(api)
                            } label: {
                                savedSearchRow(s)
                            }
                            .buttonStyle(.plain)
                        }

                        Text("Máximo 10 búsquedas guardadas. Recibirás notificaciones push y correos cuando aparezcan nuevas propiedades que coincidan.")
                            .font(.caption)
                            .foregroundStyle(Color.rdInkSoft)
                            .multilineTextAlignment(.leading)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(.horizontal, Spacing.s16)
                            .padding(.top, Spacing.s8)
                    }
                    .padding(.top, Spacing.s8)
                    .padding(.bottom, 120) // leave room for bottom CTA
                }
                .bottomCTA(
                    title: "Nueva búsqueda guardada",
                    isLoading: false,
                    action: { showCreate = true }
                )
            }
        }
        .navigationTitle("Búsquedas guardadas")
        .navigationBarTitleDisplayMode(.inline)
        .task { await load() }
        .refreshable { await load() }
        .sheet(isPresented: $showCreate) {
            SavedSearchEditorView(mode: .create, onSaved: { newSearch in
                searches.insert(newSearch, at: 0)
            })
            .environmentObject(api)
            .presentationDragIndicator(.visible)
        }
    }

    @ViewBuilder
    private func savedSearchRow(_ s: SavedSearch) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            IconTileRow(
                systemImage: "magnifyingglass",
                label: s.name,
                accessory: {
                    HStack(spacing: 6) {
                        if s.notify {
                            Image(systemName: "bell.fill")
                                .font(.caption2)
                                .foregroundStyle(Color.rdAccent)
                                .accessibilityLabel("Alertas activas")
                        }
                        if let n = s.matchCount {
                            DSCountPill(count: n, tint: .rdGreen)
                        }
                        Image(systemName: "chevron.right")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(Color.rdInkSoft)
                            .accessibilityHidden(true)
                    }
                }
            )
            Text(s.filters.summary)
                .font(.caption)
                .foregroundStyle(Color.rdInkSoft)
                .lineLimit(2)
                .padding(.leading, 28 + Spacing.s12)
                .padding(.bottom, Spacing.s8)
        }
        .padding(.horizontal, Spacing.s16)
        .background(Color.clear)
        .contentShape(Rectangle())
    }

    private func load() async {
        if searches.isEmpty { loading = true }
        errorMsg = nil
        do {
            searches = try await api.listSavedSearches()
        } catch {
            errorMsg = error.localizedDescription
        }
        loading = false
    }
}

// MARK: - Editor sheet (create / edit)

struct SavedSearchEditorView: View {
    enum Mode { case create, edit(SavedSearch) }
    let mode: Mode
    var onSaved: (SavedSearch) -> Void

    @EnvironmentObject var api: APIService
    @Environment(\.dismiss) var dismiss

    @State private var name = ""
    @State private var notifyOn = true
    @State private var selType = ""       // "", venta, alquiler, proyecto
    @State private var selCondition = ""  // "", nueva_construccion, usada, planos
    @State private var province = ""
    @State private var city = ""
    @State private var priceMin = ""
    @State private var priceMax = ""
    @State private var bedroomsMin = 0
    @State private var saving = false
    @State private var errorMsg: String?

    private var isEdit: Bool { if case .edit = mode { return true } else { return false } }
    private var title: String { isEdit ? "Editar búsqueda" : "Nueva búsqueda" }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: Spacing.s16) {
                    FormCard("Nombre") {
                        TextField("Ej. Apartamentos Piantini 2BR", text: $name)
                            .textFieldStyle(.plain)
                            .padding(.vertical, Spacing.s8)
                    }

                    FormCard("Tipo") {
                        LabeledRow("Transacción") {
                            Picker("Transacción", selection: $selType) {
                                Text("Cualquiera").tag("")
                                Text("En Venta").tag("venta")
                                Text("Alquiler").tag("alquiler")
                                Text("Proyectos").tag("proyecto")
                            }
                            .labelsHidden()
                        }
                        LabeledRow("Condición") {
                            Picker("Condición", selection: $selCondition) {
                                Text("Cualquiera").tag("")
                                Text("Nueva construcción").tag("nueva_construccion")
                                Text("Usada").tag("usada")
                                Text("En planos").tag("planos")
                            }
                            .labelsHidden()
                        }
                    }

                    FormCard("Ubicación") {
                        LabeledRow("Provincia") {
                            TextField("Provincia", text: $province)
                                .multilineTextAlignment(.trailing)
                        }
                        LabeledRow("Ciudad") {
                            TextField("Ciudad", text: $city)
                                .multilineTextAlignment(.trailing)
                        }
                    }

                    FormCard("Precio (USD)") {
                        LabeledRow("Mínimo") {
                            TextField("Mínimo", text: $priceMin)
                                .keyboardType(.numberPad)
                                .multilineTextAlignment(.trailing)
                        }
                        LabeledRow("Máximo") {
                            TextField("Máximo", text: $priceMax)
                                .keyboardType(.numberPad)
                                .multilineTextAlignment(.trailing)
                        }
                    }

                    FormCard("Habitaciones") {
                        LabeledRow(bedroomsMin == 0 ? "Cualquiera" : "\(bedroomsMin)+") {
                            Stepper("", value: $bedroomsMin, in: 0...10)
                                .labelsHidden()
                        }
                    }

                    FormCard("Alertas") {
                        LabeledRow("Recibir alertas") {
                            Toggle("", isOn: $notifyOn).labelsHidden()
                        }
                        Text("Notificación push + correo cuando aparezcan nuevas propiedades.")
                            .font(.caption)
                            .foregroundStyle(Color.rdInkSoft)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(.bottom, Spacing.s4)
                    }

                    if let err = errorMsg {
                        Label(err, systemImage: "exclamationmark.triangle")
                            .font(.caption)
                            .foregroundStyle(Color.rdRed)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(.horizontal, Spacing.s4)
                    }
                }
                .padding(.horizontal, Spacing.s16)
                .padding(.vertical, Spacing.s16)
            }
            .background(Color.rdBg)
            .navigationTitle(title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancelar") { dismiss() }
                        .accessibilityLabel("Cancelar")
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(saving ? "Guardando…" : "Guardar") {
                        Task { await save() }
                    }
                    .disabled(saving)
                }
            }
            .onAppear { prefill() }
        }
    }

    private func prefill() {
        if case .edit(let s) = mode {
            name = s.name
            notifyOn = s.notify
            selType = s.filters.type ?? ""
            selCondition = s.filters.condition ?? ""
            province = s.filters.province ?? ""
            city = s.filters.city ?? ""
            priceMin = s.filters.priceMin.map { String(Int($0)) } ?? ""
            priceMax = s.filters.priceMax.map { String(Int($0)) } ?? ""
            bedroomsMin = s.filters.bedroomsMin ?? 0
        }
    }

    private func buildFilters() -> SavedSearchFilters {
        SavedSearchFilters(
            type: selType.isEmpty ? nil : selType,
            condition: selCondition.isEmpty ? nil : selCondition,
            province: province.trimmingCharacters(in: .whitespaces).isEmpty ? nil : province.trimmingCharacters(in: .whitespaces),
            city: city.trimmingCharacters(in: .whitespaces).isEmpty ? nil : city.trimmingCharacters(in: .whitespaces),
            priceMin: Double(priceMin),
            priceMax: Double(priceMax),
            bedroomsMin: bedroomsMin == 0 ? nil : bedroomsMin,
            tags: nil
        )
    }

    private func save() async {
        saving = true
        errorMsg = nil
        let filters = buildFilters()
        do {
            let saved: SavedSearch
            if case .edit(let existing) = mode {
                saved = try await api.updateSavedSearch(id: existing.id, name: name, filters: filters, notify: notifyOn)
            } else {
                saved = try await api.createSavedSearch(name: name, filters: filters, notify: notifyOn)
            }
            onSaved(saved)
            dismiss()
        } catch {
            errorMsg = error.localizedDescription
        }
        saving = false
    }
}

// MARK: - Detail view (matches + settings)

struct SavedSearchDetailView: View {
    let search: SavedSearch
    var onChange: (SavedSearch) -> Void
    var onDelete: () -> Void

    @EnvironmentObject var api: APIService
    @Environment(\.dismiss) var dismiss

    @State private var current: SavedSearch
    @State private var listings: [Listing] = []
    @State private var total = 0
    @State private var loading = true
    @State private var errorMsg: String?
    @State private var showEdit = false
    @State private var showDeleteAlert = false
    @State private var togglingNotify = false

    init(search: SavedSearch, onChange: @escaping (SavedSearch) -> Void, onDelete: @escaping () -> Void) {
        self.search = search
        self.onChange = onChange
        self.onDelete = onDelete
        _current = State(initialValue: search)
    }

    var body: some View {
        ScrollView {
            VStack(spacing: Spacing.s16) {
                FormCard("Búsqueda") {
                    LabeledRow("Nombre") {
                        Text(current.name)
                    }
                    LabeledRow("Filtros") {
                        Text(current.filters.summary)
                            .multilineTextAlignment(.trailing)
                    }
                    LabeledRow("Alertas") {
                        Toggle("", isOn: Binding(
                            get: { current.notify },
                            set: { newVal in
                                if !togglingNotify { Task { await toggleNotify(newVal) } }
                            }
                        ))
                        .labelsHidden()
                        .disabled(togglingNotify)
                    }
                }

                if loading {
                    ProgressView().padding()
                } else if listings.isEmpty {
                    EmptyStateView.calm(
                        systemImage: "magnifyingglass",
                        title: "Sin resultados ahora",
                        description: "Ninguna propiedad coincide con esta búsqueda en este momento."
                    )
                } else {
                    FormCard(total == 1 ? "1 propiedad" : "\(total) propiedades") {
                        ForEach(listings) { l in
                            NavigationLink {
                                ListingDetailView(id: l.id).environmentObject(api)
                            } label: {
                                ListingRow(listing: l, isSelected: false)
                            }
                            .buttonStyle(.plain)
                        }
                    }
                }

                if let err = errorMsg {
                    Label(err, systemImage: "exclamationmark.triangle")
                        .font(.caption)
                        .foregroundStyle(Color.rdRed)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.horizontal, Spacing.s4)
                }
            }
            .padding(.horizontal, Spacing.s16)
            .padding(.vertical, Spacing.s16)
        }
        .background(Color.rdBg)
        .navigationTitle("Búsqueda")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Menu {
                    Button { showEdit = true } label: {
                        Label("Editar filtros", systemImage: "pencil")
                    }
                    Button(role: .destructive) {
                        showDeleteAlert = true
                    } label: {
                        Label("Eliminar búsqueda", systemImage: "trash")
                    }
                } label: {
                    Image(systemName: "ellipsis.circle")
                }
                .accessibilityLabel("Más opciones")
            }
        }
        .task { await load() }
        .refreshable { await load() }
        .sheet(isPresented: $showEdit) {
            SavedSearchEditorView(mode: .edit(current), onSaved: { updated in
                current = updated
                onChange(updated)
                Task { await load() }
            })
            .environmentObject(api)
            .presentationDragIndicator(.visible)
        }
        .alert("¿Eliminar búsqueda?", isPresented: $showDeleteAlert) {
            Button("Cancelar", role: .cancel) {}
            Button("Eliminar", role: .destructive) {
                Task { await doDelete() }
            }
        } message: {
            Text("Dejarás de recibir alertas para esta búsqueda.")
        }
    }

    private func load() async {
        if listings.isEmpty { loading = true }
        errorMsg = nil
        do {
            let r = try await api.getSavedSearchResults(id: current.id)
            listings = r.listings ?? []
            total = r.total ?? listings.count
            current = r.search
            onChange(r.search)
        } catch is CancellationError {
        } catch {
            errorMsg = error.localizedDescription
        }
        loading = false
    }

    private func toggleNotify(_ newVal: Bool) async {
        togglingNotify = true
        let prev = current.notify
        // optimistic
        current = SavedSearch(
            id: current.id, userId: current.userId, name: current.name,
            filters: current.filters, notify: newVal, matchCount: current.matchCount,
            createdAt: current.createdAt, lastNotifiedAt: current.lastNotifiedAt
        )
        do {
            let updated = try await api.updateSavedSearch(id: current.id, name: nil, filters: nil, notify: newVal)
            current = updated
            onChange(updated)
        } catch {
            // revert
            current = SavedSearch(
                id: current.id, userId: current.userId, name: current.name,
                filters: current.filters, notify: prev, matchCount: current.matchCount,
                createdAt: current.createdAt, lastNotifiedAt: current.lastNotifiedAt
            )
            errorMsg = error.localizedDescription
        }
        togglingNotify = false
    }

    private func doDelete() async {
        do {
            try await api.deleteSavedSearch(id: current.id)
            onDelete()
            dismiss()
        } catch {
            errorMsg = error.localizedDescription
        }
    }
}
