// AgencyPostsView.swift
//
// Mirrors the web's /equipo-publicaciones.html — content management
// for an inmobiliaria's social-update + article posts. Lists posts
// newest-first; tap to edit; "+" to create. Pull-to-refresh.

import SwiftUI

struct AgencyPostsView: View {
    @EnvironmentObject var api: APIService

    @State private var posts:    [AgencyPost] = []
    @State private var loading:  Bool = false
    @State private var errorMsg: String?
    @State private var editing:  AgencyPost?
    @State private var showCreate = false

    var body: some View {
        Group {
            if loading && posts.isEmpty {
                ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if posts.isEmpty {
                emptyState
            } else {
                List {
                    ForEach(posts) { p in
                        Button {
                            editing = p
                        } label: {
                            postRow(p)
                        }
                        .buttonStyle(.plain)
                    }
                    .onDelete(perform: deleteAt)
                }
                .listStyle(.insetGrouped)
                .scrollContentBackground(.hidden)
                .background(Color(.systemBackground))
            }
        }
        .navigationTitle("Publicaciones")
        .navigationBarTitleDisplayMode(.inline)
        .task { await load() }
        .refreshable { await load() }
        .toolbar {
            ToolbarItem(placement: .navigationBarTrailing) {
                Button { showCreate = true } label: { Image(systemName: "plus") }
            }
        }
        .sheet(isPresented: $showCreate) {
            NavigationStack {
                AgencyPostEditor(initial: nil) { saved in
                    posts.insert(saved, at: 0)
                    showCreate = false
                }
                .environmentObject(api)
            }
        }
        .sheet(item: $editing) { p in
            NavigationStack {
                AgencyPostEditor(initial: p) { updated in
                    if let i = posts.firstIndex(where: { $0.id == updated.id }) {
                        posts[i] = updated
                    }
                    editing = nil
                }
                .environmentObject(api)
            }
        }
        .alert(errorMsg ?? "", isPresented: .constant(errorMsg != nil)) {
            Button("OK") { errorMsg = nil }
        }
    }

    private var emptyState: some View {
        ContentUnavailableView(
            "Aún no has publicado nada",
            systemImage: "doc.text.image",
            description: Text("Comparte novedades, artículos y casos de éxito con tus clientes y agentes. Toca el + para crear tu primera publicación.")
        )
    }

    @ViewBuilder
    private func postRow(_ p: AgencyPost) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                kindBadge(p.kind ?? "update")
                if let d = p.created_at {
                    Text(formatRelative(d))
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
                Spacer()
            }
            Text(p.title ?? "")
                .font(.subheadline.bold())
                .lineLimit(2)
            if let body = p.body, !body.isEmpty {
                Text(body)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(3)
            }
        }
        .padding(.vertical, 4)
    }

    @ViewBuilder
    private func kindBadge(_ kind: String) -> some View {
        let label = kind == "article" ? "Artículo" : "Actualización"
        let color: Color = kind == "article" ? .purple : Color.rdBlue
        Text(label)
            .font(.caption2.bold())
            .foregroundStyle(color)
            .padding(.horizontal, 8).padding(.vertical, 2)
            .background(color.opacity(0.12))
            .clipShape(Capsule())
    }

    private func formatRelative(_ iso: String) -> String {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        var date = f.date(from: iso)
        if date == nil { f.formatOptions = [.withInternetDateTime]; date = f.date(from: iso) }
        guard let d = date else { return iso }
        let diff = Date().timeIntervalSince(d)
        if diff < 86400 { return "hoy" }
        if diff < 172800 { return "ayer" }
        if diff < 604800 { return "\(Int(diff/86400)) d" }
        let df = DateFormatter()
        df.dateFormat = "d MMM"
        df.locale = Locale(identifier: "es_DO")
        return df.string(from: d)
    }

    private func load() async {
        loading = true
        errorMsg = nil
        defer { loading = false }
        do {
            posts = try await api.getAgencyPosts()
        } catch {
            errorMsg = (error as? LocalizedError)?.errorDescription ?? "No se pudieron cargar."
        }
    }

    private func deleteAt(_ offsets: IndexSet) {
        let toDelete = offsets.map { posts[$0] }
        for p in toDelete {
            Task {
                do {
                    _ = try await api.deleteAgencyPost(id: p.id)
                    await MainActor.run { posts.removeAll { $0.id == p.id } }
                } catch {
                    await MainActor.run {
                        errorMsg = (error as? LocalizedError)?.errorDescription ?? "No se pudo eliminar."
                    }
                }
            }
        }
    }
}

// MARK: - Editor (create + edit share the same form)

struct AgencyPostEditor: View {
    let initial: AgencyPost?
    var onSaved: (AgencyPost) -> Void

    @EnvironmentObject var api: APIService
    @Environment(\.dismiss) private var dismiss

    @State private var title:    String = ""
    @State private var body_:    String = ""
    @State private var imageUrl: String = ""
    @State private var kind:     String = "update"
    @State private var saving = false
    @State private var errorMsg: String?

    private var isEdit: Bool { initial != nil }

    var body: some View {
        Form {
            Section {
                Picker("Tipo", selection: $kind) {
                    Text("Actualización").tag("update")
                    Text("Artículo").tag("article")
                }
                .pickerStyle(.segmented)
                .disabled(isEdit)  // server's update endpoint doesn't change kind
            }

            Section("Título") {
                TextField("Título", text: $title)
                    .textInputAutocapitalization(.sentences)
            }

            Section("Contenido") {
                TextField("Escribe tu publicación…", text: $body_, axis: .vertical)
                    .lineLimit(6...20)
            }

            Section("Imagen (opcional)") {
                TextField("URL pública de la imagen", text: $imageUrl)
                    .textContentType(.URL)
                    .keyboardType(.URL)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
            }

            if let errorMsg {
                Section {
                    Label(errorMsg, systemImage: "exclamationmark.triangle.fill")
                        .foregroundStyle(.red)
                        .font(.callout)
                }
            }
        }
        .navigationTitle(isEdit ? "Editar publicación" : "Nueva publicación")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .cancellationAction) {
                Button("Cancelar") { dismiss() }
            }
            ToolbarItem(placement: .confirmationAction) {
                Button(isEdit ? "Guardar" : "Publicar") { Task { await save() } }
                    .disabled(saving || title.trimmingCharacters(in: .whitespaces).isEmpty)
            }
        }
        .onAppear {
            if let p = initial {
                title    = p.title ?? ""
                body_    = p.body  ?? ""
                imageUrl = p.image_url ?? ""
                kind     = p.kind ?? "update"
            }
        }
    }

    private func save() async {
        saving = true
        errorMsg = nil
        defer { saving = false }
        do {
            let saved: AgencyPost
            if let p = initial {
                saved = try await api.updateAgencyPost(
                    id: p.id, title: title, body: body_,
                    imageUrl: imageUrl.isEmpty ? nil : imageUrl
                )
            } else {
                saved = try await api.createAgencyPost(
                    title: title, body: body_,
                    kind: kind,
                    imageUrl: imageUrl.isEmpty ? nil : imageUrl
                )
            }
            await MainActor.run {
                onSaved(saved)
                dismiss()
            }
        } catch {
            errorMsg = (error as? LocalizedError)?.errorDescription ?? "No se pudo guardar."
        }
    }
}
