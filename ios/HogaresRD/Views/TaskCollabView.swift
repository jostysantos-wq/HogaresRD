// TaskCollabView.swift
//
// Mirrors the web's task-collaboration tabs (public/tareas.html
// "Actividad" + "Archivos") on iOS. Hosts:
//   • Comments — list + composer + edit/delete-own
//   • Attachments — grid + upload (photos / files) + delete-own
//
// Subtasks, dependencies, and recurrence each warrant their own
// dedicated picker UI and are deliberately deferred to follow-up
// commits — the API surface is already in place via APIService.

import SwiftUI
import PhotosUI
import UniformTypeIdentifiers

struct TaskCollabView: View {
    let task: TaskItem

    @EnvironmentObject var api: APIService
    @State private var tab: Tab = .comments

    enum Tab: String, CaseIterable, Identifiable {
        case comments = "Comentarios"
        case files    = "Archivos"
        var id: String { rawValue }
    }

    var body: some View {
        VStack(spacing: 0) {
            Picker("", selection: $tab) {
                ForEach(Tab.allCases) { t in Text(t.rawValue).tag(t) }
            }
            .pickerStyle(.segmented)
            .padding(.horizontal, 16)
            .padding(.top, 12)
            .padding(.bottom, 8)

            Divider()

            switch tab {
            case .comments:
                TaskCommentsTab(task: task).environmentObject(api)
            case .files:
                TaskAttachmentsTab(task: task).environmentObject(api)
            }
        }
        .navigationTitle("Colaboración")
        .navigationBarTitleDisplayMode(.inline)
    }
}

// MARK: - Comments tab

struct TaskCommentsTab: View {
    let task: TaskItem
    @EnvironmentObject var api: APIService

    @State private var comments: [TaskComment] = []
    @State private var draft:    String = ""
    @State private var loading:  Bool   = false
    @State private var posting:  Bool   = false
    @State private var errorMsg: String?
    @State private var editing:  TaskComment?
    @State private var editDraft: String = ""

    private var myId: String { api.currentUser?.id ?? "" }

    var body: some View {
        VStack(spacing: 0) {
            if loading && comments.isEmpty {
                ProgressView().padding(.top, 40)
                Spacer()
            } else if comments.isEmpty {
                VStack(spacing: 8) {
                    Image(systemName: "bubble.left.and.bubble.right")
                        .font(.system(size: 36))
                        .foregroundStyle(.secondary)
                    Text("Aún no hay comentarios. Sé el primero en comentar.")
                        .font(.callout)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                        .padding(.horizontal, 32)
                }
                .padding(.top, 40)
                Spacer()
            } else {
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 14) {
                        ForEach(comments) { c in
                            commentBubble(c)
                        }
                    }
                    .padding(16)
                }
            }

            if let errorMsg {
                Text(errorMsg)
                    .font(.caption)
                    .foregroundStyle(.red)
                    .padding(.horizontal, 16)
                    .padding(.bottom, 4)
            }

            composer
        }
        .task { await load() }
        .refreshable { await load() }
        .sheet(item: $editing) { c in
            NavigationStack {
                Form {
                    Section("Editar comentario") {
                        TextField("Comentario", text: $editDraft, axis: .vertical)
                            .lineLimit(4...10)
                    }
                }
                .navigationTitle("Editar")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("Cancelar") { editing = nil }
                    }
                    ToolbarItem(placement: .confirmationAction) {
                        Button("Guardar") { Task { await saveEdit(c) } }
                            .disabled(editDraft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    }
                }
            }
        }
    }

    @ViewBuilder
    private func commentBubble(_ c: TaskComment) -> some View {
        let mine = c.author_id == myId
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 8) {
                Text(c.author_name ?? "—")
                    .font(.subheadline).bold()
                Text(relTime(c.created_at))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                if c.edited_at != nil {
                    Text("(editado)")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
                Spacer()
                if mine {
                    Menu {
                        Button {
                            editDraft = c.body
                            editing   = c
                        } label: { Label("Editar", systemImage: "pencil") }
                        Button(role: .destructive) {
                            Task { await delete(c) }
                        } label: { Label("Eliminar", systemImage: "trash") }
                    } label: {
                        Image(systemName: "ellipsis")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .padding(.horizontal, 6).padding(.vertical, 4)
                    }
                }
            }
            Text(c.body)
                .font(.body)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: 12)
                .fill(mine ? Color.rdBlue.opacity(0.06) : Color(.secondarySystemBackground))
        )
    }

    private var composer: some View {
        HStack(alignment: .bottom, spacing: 10) {
            TextField("Escribe un comentario…", text: $draft, axis: .vertical)
                .lineLimit(1...4)
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
                .background(Color(.secondarySystemBackground))
                .clipShape(RoundedRectangle(cornerRadius: 18))

            Button {
                Task { await post() }
            } label: {
                if posting {
                    ProgressView().tint(.white)
                        .frame(width: 36, height: 36)
                        .background(Color.rdBlue.opacity(0.6))
                        .clipShape(Circle())
                } else {
                    Image(systemName: "arrow.up")
                        .font(.system(size: 16, weight: .bold))
                        .foregroundStyle(.white)
                        .frame(width: 36, height: 36)
                        .background(canPost ? Color.rdBlue : Color(.systemGray3))
                        .clipShape(Circle())
                }
            }
            .disabled(!canPost || posting)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .background(.thinMaterial)
    }

    private var canPost: Bool {
        !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    // MARK: - Actions

    private func load() async {
        loading = true
        errorMsg = nil
        defer { loading = false }
        do {
            let list = try await api.getTaskComments(taskId: task.id)
            await MainActor.run { comments = list.sorted { $0.created_at < $1.created_at } }
        } catch {
            await MainActor.run { errorMsg = (error as? LocalizedError)?.errorDescription ?? "No se pudieron cargar." }
        }
    }

    private func post() async {
        let body = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !body.isEmpty else { return }
        posting = true
        errorMsg = nil
        defer { posting = false }
        do {
            let new = try await api.postTaskComment(taskId: task.id, body: body)
            await MainActor.run {
                comments.append(new)
                draft = ""
            }
        } catch {
            await MainActor.run { errorMsg = (error as? LocalizedError)?.errorDescription ?? "No se pudo publicar." }
        }
    }

    private func saveEdit(_ c: TaskComment) async {
        let trimmed = editDraft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        do {
            let updated = try await api.editTaskComment(taskId: task.id, commentId: c.id, body: trimmed)
            await MainActor.run {
                if let i = comments.firstIndex(where: { $0.id == c.id }) { comments[i] = updated }
                editing = nil
                editDraft = ""
            }
        } catch {
            await MainActor.run { errorMsg = (error as? LocalizedError)?.errorDescription ?? "No se pudo editar." }
        }
    }

    private func delete(_ c: TaskComment) async {
        do {
            _ = try await api.deleteTaskComment(taskId: task.id, commentId: c.id)
            await MainActor.run { comments.removeAll { $0.id == c.id } }
        } catch {
            await MainActor.run { errorMsg = (error as? LocalizedError)?.errorDescription ?? "No se pudo eliminar." }
        }
    }

    private func relTime(_ iso: String) -> String {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        var date = f.date(from: iso)
        if date == nil {
            f.formatOptions = [.withInternetDateTime]
            date = f.date(from: iso)
        }
        guard let d = date else { return iso }
        let diff = Date().timeIntervalSince(d)
        if diff < 60 { return "ahora" }
        if diff < 3600 { return "\(Int(diff/60)) min" }
        if diff < 86400 { return "\(Int(diff/3600)) h" }
        if diff < 604800 { return "\(Int(diff/86400)) d" }
        let df = DateFormatter()
        df.dateFormat = "d MMM"
        df.locale = Locale(identifier: "es_DO")
        return df.string(from: d)
    }
}

// MARK: - Attachments tab

struct TaskAttachmentsTab: View {
    let task: TaskItem
    @EnvironmentObject var api: APIService

    @State private var items:    [TaskAttachment] = []
    @State private var loading:  Bool = false
    @State private var uploading: Bool = false
    @State private var errorMsg: String?
    @State private var photoItem: PhotosPickerItem?
    @State private var showFileImporter = false

    private let columns = [
        GridItem(.flexible(), spacing: 10),
        GridItem(.flexible(), spacing: 10),
        GridItem(.flexible(), spacing: 10),
    ]

    var body: some View {
        VStack(spacing: 0) {
            if loading && items.isEmpty {
                ProgressView().padding(.top, 40)
                Spacer()
            } else if items.isEmpty {
                VStack(spacing: 8) {
                    Image(systemName: "paperclip")
                        .font(.system(size: 36))
                        .foregroundStyle(.secondary)
                    Text("No hay archivos. Sube fotos, recibos o documentos relevantes a esta tarea.")
                        .font(.callout)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                        .padding(.horizontal, 32)
                }
                .padding(.top, 40)
                Spacer()
            } else {
                ScrollView {
                    LazyVGrid(columns: columns, spacing: 10) {
                        ForEach(items) { a in
                            attachmentTile(a)
                        }
                    }
                    .padding(16)
                }
            }

            if let errorMsg {
                Text(errorMsg)
                    .font(.caption)
                    .foregroundStyle(.red)
                    .padding(.horizontal, 16)
                    .padding(.bottom, 4)
            }

            uploadBar
        }
        .task { await load() }
        .refreshable { await load() }
        .onChange(of: photoItem) { _, newItem in
            guard let newItem else { return }
            Task { await uploadFromPhoto(newItem) }
        }
        .fileImporter(
            isPresented: $showFileImporter,
            allowedContentTypes: [.pdf, .jpeg, .png, .image],
            allowsMultipleSelection: false
        ) { result in
            guard case .success(let urls) = result, let url = urls.first else { return }
            Task { await uploadFromURL(url) }
        }
    }

    @ViewBuilder
    private func attachmentTile(_ a: TaskAttachment) -> some View {
        let isImage = (a.mime_type ?? "").hasPrefix("image/")
        VStack(spacing: 0) {
            ZStack {
                Rectangle()
                    .fill(Color(.secondarySystemBackground))
                    .aspectRatio(1, contentMode: .fit)

                if isImage {
                    AsyncImage(url: api.taskAttachmentFileURL(taskId: task.id, attachmentId: a.id)) { phase in
                        switch phase {
                        case .success(let img):
                            img.resizable().scaledToFill()
                        default:
                            Image(systemName: "photo")
                                .font(.title2)
                                .foregroundStyle(.secondary)
                        }
                    }
                    .clipped()
                } else {
                    Image(systemName: a.mime_type == "application/pdf" ? "doc.richtext" : "doc")
                        .font(.system(size: 28))
                        .foregroundStyle(.secondary)
                }
            }
            .clipShape(RoundedRectangle(cornerRadius: 10))

            Text(a.original_name ?? a.filename ?? "archivo")
                .font(.caption2)
                .lineLimit(1)
                .truncationMode(.middle)
                .padding(.top, 4)
        }
        .contextMenu {
            Button {
                if let url = openableURL(a) { UIApplication.shared.open(url) }
            } label: { Label("Abrir", systemImage: "arrow.up.right.square") }

            if a.uploaded_by == api.currentUser?.id {
                Button(role: .destructive) {
                    Task { await delete(a) }
                } label: { Label("Eliminar", systemImage: "trash") }
            }
        }
    }

    private var uploadBar: some View {
        HStack(spacing: 10) {
            PhotosPicker(selection: $photoItem, matching: .any(of: [.images, .not(.videos)])) {
                Label("Foto", systemImage: "photo")
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 10)
                    .background(Color.rdBlue)
                    .foregroundStyle(.white)
                    .clipShape(RoundedRectangle(cornerRadius: 12))
            }
            .disabled(uploading)

            Button {
                showFileImporter = true
            } label: {
                Label("Archivo", systemImage: "doc")
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 10)
                    .background(Color(.secondarySystemBackground))
                    .foregroundStyle(.primary)
                    .clipShape(RoundedRectangle(cornerRadius: 12))
            }
            .disabled(uploading)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .background(.thinMaterial)
        .overlay(alignment: .top) {
            if uploading {
                ProgressView().padding(.top, 4)
            }
        }
    }

    private func openableURL(_ a: TaskAttachment) -> URL? {
        // Server gates the file with Authorization, so a plain UIApplication.open
        // won't authenticate. Use universal-link forwarding via the iOS app's
        // own Authorization-aware fetch + temp file write would be ideal; for
        // now, expose the URL so the OS can attempt to render it (if the user
        // is logged in via cookie on the same WebView session).
        api.taskAttachmentFileURL(taskId: task.id, attachmentId: a.id)
    }

    // MARK: - Actions

    private func load() async {
        loading = true
        errorMsg = nil
        defer { loading = false }
        do {
            let list = try await api.getTaskAttachments(taskId: task.id)
            await MainActor.run { items = list.sorted { ($0.uploaded_at ?? "") > ($1.uploaded_at ?? "") } }
        } catch {
            await MainActor.run { errorMsg = (error as? LocalizedError)?.errorDescription ?? "No se pudieron cargar." }
        }
    }

    private func uploadFromPhoto(_ item: PhotosPickerItem) async {
        do {
            guard let data = try await item.loadTransferable(type: Data.self) else { return }
            let stamp = Int(Date().timeIntervalSince1970)
            await uploadData(data, filename: "imagen_\(stamp).jpg", mimeType: "image/jpeg")
        } catch {
            await MainActor.run { errorMsg = "No se pudo cargar la imagen." }
        }
        await MainActor.run { photoItem = nil }
    }

    private func uploadFromURL(_ url: URL) async {
        let needsAccess = url.startAccessingSecurityScopedResource()
        defer { if needsAccess { url.stopAccessingSecurityScopedResource() } }
        do {
            let data = try Data(contentsOf: url)
            let mime = (UTType(filenameExtension: url.pathExtension)?.preferredMIMEType) ?? "application/octet-stream"
            await uploadData(data, filename: url.lastPathComponent, mimeType: mime)
        } catch {
            await MainActor.run { errorMsg = "No se pudo leer el archivo." }
        }
    }

    private func uploadData(_ data: Data, filename: String, mimeType: String) async {
        uploading = true
        errorMsg = nil
        defer { uploading = false }
        do {
            let saved = try await api.uploadTaskAttachment(
                taskId: task.id, fileData: data,
                filename: filename, mimeType: mimeType
            )
            await MainActor.run { items.insert(saved, at: 0) }
        } catch {
            await MainActor.run { errorMsg = (error as? LocalizedError)?.errorDescription ?? "No se pudo subir." }
        }
    }

    private func delete(_ a: TaskAttachment) async {
        do {
            _ = try await api.deleteTaskAttachment(taskId: task.id, attachmentId: a.id)
            await MainActor.run { items.removeAll { $0.id == a.id } }
        } catch {
            await MainActor.run { errorMsg = (error as? LocalizedError)?.errorDescription ?? "No se pudo eliminar." }
        }
    }
}
