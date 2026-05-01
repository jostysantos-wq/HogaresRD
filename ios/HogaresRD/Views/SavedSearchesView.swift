import SwiftUI

// MARK: - Saved Searches list

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
                VStack(spacing: 16) {
                    Image(systemName: "exclamationmark.triangle")
                        .font(.system(size: 40)).foregroundStyle(.secondary)
                    Text(err).multilineTextAlignment(.center).foregroundStyle(.secondary)
                    Button("Reintentar") { Task { await load() } }
                        .buttonStyle(.borderedProminent).tint(Color.rdBlue)
                }
                .padding()
            } else if searches.isEmpty {
                VStack(spacing: 16) {
                    Image(systemName: "bell.badge")
                        .font(.system(size: 60))
                        .foregroundStyle(Color.rdBlue.opacity(0.35))
                    Text("Sin búsquedas guardadas")
                        .font(.title3).bold()
                    Text("Crea una búsqueda guardada para recibir alertas cuando aparezcan nuevas propiedades que coincidan con tus criterios.")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                        .padding(.horizontal, 32)
                    Button {
                        showCreate = true
                    } label: {
                        Label("Crear búsqueda", systemImage: "plus.circle.fill")
                            .font(.subheadline).bold()
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 12)
                            .background(Color.rdBlue)
                            .foregroundStyle(.white)
                            .clipShape(RoundedRectangle(cornerRadius: 12))
                    }
                    .padding(.horizontal, 32)
                }
            } else {
                List {
                    Section {
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
                        }
                    }

                    Section {
                        Button {
                            showCreate = true
                        } label: {
                            Label("Nueva búsqueda guardada", systemImage: "plus.circle.fill")
                                .foregroundStyle(Color.rdBlue)
                        }
                    } footer: {
                        Text("Máximo 10 búsquedas guardadas. Recibirás notificaciones push y correos cuando aparezcan nuevas propiedades que coincidan.")
                            .font(.caption)
                    }
                }
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
        }
    }

    @ViewBuilder
    private func savedSearchRow(_ s: SavedSearch) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text(s.name)
                    .font(.subheadline).bold()
                    .lineLimit(1)
                Spacer()
                if s.notify {
                    Image(systemName: "bell.fill")
                        .font(.caption2)
                        .foregroundStyle(Color.rdBlue)
                }
            }
            Text(s.filters.summary)
                .font(.caption)
                .foregroundStyle(.secondary)
                .lineLimit(2)
            if let n = s.matchCount {
                Text("\(n) \(n == 1 ? "propiedad" : "propiedades") coinciden")
                    .font(.caption2)
                    .foregroundStyle(Color.rdGreen)
            }
        }
        .padding(.vertical, 4)
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
            Form {
                Section("Nombre") {
                    TextField("Ej. Apartamentos Piantini 2BR", text: $name)
                }

                Section("Tipo") {
                    Picker("Transacción", selection: $selType) {
                        Text("Cualquiera").tag("")
                        Text("En Venta").tag("venta")
                        Text("Alquiler").tag("alquiler")
                        Text("Proyectos").tag("proyecto")
                    }
                    Picker("Condición", selection: $selCondition) {
                        Text("Cualquiera").tag("")
                        Text("Nueva construcción").tag("nueva_construccion")
                        Text("Usada").tag("usada")
                        Text("En planos").tag("planos")
                    }
                }

                Section("Ubicación") {
                    TextField("Provincia", text: $province)
                    TextField("Ciudad", text: $city)
                }

                Section("Precio (USD)") {
                    TextField("Mínimo", text: $priceMin).keyboardType(.numberPad)
                    TextField("Máximo", text: $priceMax).keyboardType(.numberPad)
                }

                Section("Habitaciones") {
                    Stepper(value: $bedroomsMin, in: 0...10) {
                        Text(bedroomsMin == 0 ? "Cualquiera" : "\(bedroomsMin)+")
                    }
                }

                Section {
                    Toggle(isOn: $notifyOn) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text("Recibir alertas")
                            Text("Notificación push + correo cuando aparezcan nuevas propiedades")
                                .font(.caption).foregroundStyle(.secondary)
                        }
                    }
                }

                if let err = errorMsg {
                    Section {
                        Label(err, systemImage: "exclamationmark.triangle")
                            .font(.caption).foregroundStyle(.red)
                    }
                }
            }
            .navigationTitle(title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancelar") { dismiss() }
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
        List {
            Section {
                VStack(alignment: .leading, spacing: 6) {
                    Text(current.name).font(.headline)
                    Text(current.filters.summary)
                        .font(.caption).foregroundStyle(.secondary)
                }
                .padding(.vertical, 4)

                Toggle(isOn: Binding(
                    get: { current.notify },
                    set: { newVal in
                        if !togglingNotify { Task { await toggleNotify(newVal) } }
                    }
                )) {
                    Label("Alertas activas", systemImage: "bell.fill")
                }
                .disabled(togglingNotify)
            }

            if loading {
                Section { ProgressView() }
            } else if listings.isEmpty {
                Section {
                    Text("Ninguna propiedad coincide actualmente.")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .padding(.vertical, 12)
                }
            } else {
                Section(total == 1 ? "1 propiedad" : "\(total) propiedades") {
                    ForEach(listings) { l in
                        NavigationLink {
                            ListingDetailView(id: l.id).environmentObject(api)
                        } label: {
                            ListingRow(listing: l, isSelected: false)
                        }
                    }
                }
            }

            if let err = errorMsg {
                Section {
                    Label(err, systemImage: "exclamationmark.triangle")
                        .font(.caption).foregroundStyle(.red)
                }
            }
        }
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
