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
    @State private var auditEntries: [TaskItem.AuditEntry] = []
    @State private var draft:    String = ""
    @State private var loading:  Bool   = false
    @State private var posting:  Bool   = false
    @State private var errorMsg: String?
    @State private var editing:  TaskComment?
    @State private var editDraft: String = ""

    private var myId: String { api.currentUser?.id ?? "" }

    /// Merged, time-sorted feed of comments + audit events. Comments
    /// render as full bubbles; audit events render as compact event
    /// rows so the timeline reads chronologically without losing
    /// either signal. Mirrors the web's "Actividad" tab.
    private enum FeedItem: Identifiable {
        case comment(TaskComment)
        case audit(TaskItem.AuditEntry)

        var id: String {
            switch self {
            case .comment(let c): return "c_\(c.id)"
            case .audit(let a):   return "a_\(a.id)"
            }
        }
        var time: String {
            switch self {
            case .comment(let c): return c.created_at
            case .audit(let a):   return a.timestamp
            }
        }
    }

    private var feed: [FeedItem] {
        let cs = comments.map { FeedItem.comment($0) }
        // Hide comment_* audit entries — they'd duplicate the bubble.
        let as_ = auditEntries
            .filter { !$0.type.hasPrefix("comment_") }
            .map { FeedItem.audit($0) }
        return (cs + as_).sorted { $0.time < $1.time }
    }

    var body: some View {
        VStack(spacing: 0) {
            if loading && comments.isEmpty && auditEntries.isEmpty {
                ProgressView().padding(.top, 40)
                Spacer()
            } else if feed.isEmpty {
                VStack(spacing: 8) {
                    Image(systemName: "bubble.left.and.bubble.right")
                        .font(.system(size: 36))
                        .foregroundStyle(.secondary)
                    Text("Sin actividad por ahora. Empieza la conversación.")
                        .font(.callout)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                        .padding(.horizontal, 32)
                }
                .padding(.top, 40)
                Spacer()
            } else {
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 12) {
                        ForEach(feed) { item in
                            switch item {
                            case .comment(let c): commentBubble(c)
                            case .audit(let a):   auditRow(a)
                            }
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

    // MARK: - Audit row

    /// Compact icon + label row for a single audit event. Reads more
    /// like a system message than a full bubble so the conversation
    /// dominates and timeline events stay legible but secondary.
    @ViewBuilder
    private func auditRow(_ a: TaskItem.AuditEntry) -> some View {
        let style = auditStyle(a)
        HStack(alignment: .top, spacing: 10) {
            ZStack {
                Circle().fill(style.color.opacity(0.13)).frame(width: 26, height: 26)
                Image(systemName: style.icon)
                    .font(.system(size: 11, weight: .bold))
                    .foregroundStyle(style.color)
            }
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Text(style.label)
                        .font(.caption.bold())
                    if let actor = a.actor_name, !actor.isEmpty {
                        Text("· \(actor)")
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    }
                    Spacer()
                    Text(relTime(a.timestamp))
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                }
                if let detail = style.detail {
                    Text(detail)
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .lineLimit(3)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private struct AuditStyle {
        let icon: String
        let color: Color
        let label: String
        let detail: String?
    }

    private func auditStyle(_ a: TaskItem.AuditEntry) -> AuditStyle {
        switch a.type {
        case "created":
            return .init(icon: "plus.circle.fill", color: Color.rdBlue,
                         label: "Tarea creada", detail: nil)
        case "edited":
            return .init(icon: "pencil", color: .orange,
                         label: "Tarea editada", detail: nil)
        case "status_change":
            // Reject + approve come through here; the most useful detail
            // is the to-status (and any reviewer note).
            let toLabel = statusLabel(a.to ?? "")
            let from    = statusLabel(a.from ?? "")
            let body    = "\(from) → \(toLabel)"
            return .init(icon: iconForStatusChange(to: a.to),
                         color: colorForStatusChange(to: a.to),
                         label: labelForStatusChange(to: a.to),
                         detail: a.note?.isEmpty == false ? a.note : body)
        case "approver_changed":
            return .init(icon: "person.2.arrow.trianglehead.counterclockwise",
                         color: .purple, label: "Revisor reasignado", detail: nil)
        case "reopened":
            return .init(icon: "arrow.uturn.backward.circle.fill",
                         color: Color.rdBlue, label: "Tarea reabierta",
                         detail: a.reason)
        case "recurrence_set":
            return .init(icon: "arrow.clockwise.circle.fill",
                         color: .purple, label: "Recurrencia actualizada", detail: nil)
        case "recurrence_spawned":
            return .init(icon: "plus.rectangle.on.rectangle",
                         color: .purple, label: "Próxima ocurrencia generada", detail: nil)
        case "recurrence_ended":
            return .init(icon: "stop.circle.fill",
                         color: .gray, label: "Recurrencia finalizada", detail: nil)
        case "depends_on_added":
            return .init(icon: "link.badge.plus", color: .teal,
                         label: "Dependencia añadida", detail: nil)
        case "depends_on_removed":
            return .init(icon: "link.badge.plus", color: .gray,
                         label: "Dependencia eliminada", detail: nil)
        case "parent_changed":
            return .init(icon: "rectangle.stack", color: .teal,
                         label: "Tarea padre actualizada", detail: nil)
        case "attachment_added":
            return .init(icon: "paperclip", color: Color.rdBlue,
                         label: "Archivo subido",
                         detail: a.original_name ?? a.filename)
        case "attachment_deleted":
            return .init(icon: "paperclip", color: .gray,
                         label: "Archivo eliminado",
                         detail: a.original_name ?? a.filename)
        case "archived":
            return .init(icon: "archivebox.fill", color: .gray,
                         label: "Tarea archivada", detail: a.reason)
        case "sla_overdue":
            return .init(icon: "exclamationmark.triangle.fill",
                         color: Color.rdRed, label: "SLA vencido", detail: nil)
        case "sla_idle":
            return .init(icon: "clock.badge.exclamationmark.fill",
                         color: .orange, label: "Tarea inactiva", detail: nil)
        default:
            return .init(icon: "circle.fill", color: .secondary,
                         label: a.type.replacingOccurrences(of: "_", with: " "),
                         detail: nil)
        }
    }

    private func statusLabel(_ s: String) -> String {
        switch s {
        case "pendiente":      return "Pendiente"
        case "en_progreso":    return "En Progreso"
        case "pending_review": return "En Revisión"
        case "completada":     return "Completada"
        case "no_aplica":      return "No Aplica"
        default: return s
        }
    }

    private func iconForStatusChange(to: String?) -> String {
        switch to {
        case "pending_review": return "paperplane.fill"
        case "completada":     return "checkmark.seal.fill"
        case "en_progreso":    return "arrow.uturn.left.circle.fill"
        case "no_aplica":      return "minus.circle.fill"
        default:               return "arrow.right.circle.fill"
        }
    }

    private func colorForStatusChange(to: String?) -> Color {
        switch to {
        case "completada":     return Color.rdGreen
        case "pending_review": return .purple
        case "no_aplica":      return .gray
        case "en_progreso":    return Color.rdBlue
        default:               return Color.rdBlue
        }
    }

    private func labelForStatusChange(to: String?) -> String {
        switch to {
        case "pending_review": return "Enviada para revisión"
        case "completada":     return "Aprobada / Completada"
        case "en_progreso":    return "Devuelta a en progreso"
        case "no_aplica":      return "Marcada No Aplica"
        default:               return "Cambio de estado"
        }
    }

    // MARK: - Actions

    private func load() async {
        loading = true
        errorMsg = nil
        defer { loading = false }
        // Fetch comments and the live audit log in parallel. The audit
        // log lives on the task itself so we re-fetch the task — the
        // parent sheet may have a stale snapshot.
        async let commentsResult: [TaskComment] = (try? await api.getTaskComments(taskId: task.id)) ?? []
        async let taskResult:     TaskItem?     = try? await api.getTask(id: task.id)

        let (cs, t) = await (commentsResult, taskResult)
        await MainActor.run {
            comments     = cs.sorted { $0.created_at < $1.created_at }
            auditEntries = t?.auditLog ?? []
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

    /// Mirrors the server's allowed extensions in routes/tasks.js
    /// (jpg/png/gif/webp/heic/heif/tiff/bmp/pdf/doc/docx/xls/xlsx/odt/ods/txt/csv/rtf/zip).
    /// Files outside this set are rejected by multer's fileFilter.
    private var allowedAttachmentTypes: [UTType] {
        var types: [UTType] = [
            .pdf, .image, .jpeg, .png, .plainText, .rtf, .commaSeparatedText, .zip,
        ]
        let extras: [String] = [
            "public.heic",
            "public.heif",
            "public.tiff",
            "com.compuserve.gif",
            "org.webmproject.webp",
            "com.microsoft.bmp",
            "com.microsoft.word.doc",
            "org.openxmlformats.wordprocessingml.document",
            "com.microsoft.excel.xls",
            "org.openxmlformats.spreadsheetml.sheet",
            "org.oasis-open.opendocument.text",
            "org.oasis-open.opendocument.spreadsheet",
        ]
        for id in extras {
            if let t = UTType(id) { types.append(t) }
        }
        return types
    }

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
            allowedContentTypes: allowedAttachmentTypes,
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
