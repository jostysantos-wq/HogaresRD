import SwiftUI
import PhotosUI

// MARK: - Tasks list

struct TasksView: View {
    @EnvironmentObject var api: APIService

    @State private var tasks: [TaskItem] = []
    @State private var loading = true
    @State private var errorMsg: String?
    @State private var filter = 0 // 0=Todas, 1=Pendientes, 2=En Progreso, 3=Completadas, 4=Vencidas
    @State private var showCreate = false
    @State private var selectedTask: TaskItem? = nil

    private var filteredTasks: [TaskItem] {
        switch filter {
        case 1:  return tasks.filter { $0.status == "pendiente" }
        case 2:  return tasks.filter { $0.status == "en_progreso" }
        case 3:  return tasks.filter { $0.status == "completada" }
        case 4:  return tasks.filter { $0.isOverdue }
        default: return tasks
        }
    }

    private var activeTasks: [TaskItem] {
        filteredTasks.filter { $0.status != "completada" }
    }

    private var completedTasks: [TaskItem] {
        filteredTasks.filter { $0.status == "completada" }
    }

    private var canCreate: Bool {
        api.currentUser?.isTeamLead == true
    }

    // Stats
    private var statTotal: Int { tasks.count }
    private var statPending: Int { tasks.filter { $0.status == "pendiente" }.count }
    private var statProgress: Int { tasks.filter { $0.status == "en_progreso" }.count }
    private var statDone: Int { tasks.filter { $0.status == "completada" }.count }
    private var statOverdue: Int { tasks.filter { $0.isOverdue }.count }

    var body: some View {
        Group {
            if loading {
                ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if let err = errorMsg, tasks.isEmpty {
                VStack(spacing: 16) {
                    Image(systemName: "exclamationmark.triangle")
                        .font(.system(size: 40)).foregroundStyle(.secondary)
                    Text(err).multilineTextAlignment(.center).foregroundStyle(.secondary)
                    Button("Reintentar") { Task { await load() } }
                        .buttonStyle(.borderedProminent).tint(Color.rdBlue)
                }
                .padding()
            } else {
                VStack(spacing: 0) {
                    // Stats bar
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: 10) {
                            statPill("Total", value: statTotal, color: .rdBlue)
                            statPill("Pendientes", value: statPending, color: .orange)
                            statPill("En Progreso", value: statProgress, color: .rdBlue)
                            statPill("Completadas", value: statDone, color: .rdGreen)
                            statPill("Vencidas", value: statOverdue, color: .rdRed)
                        }
                        .padding(.horizontal)
                        .padding(.vertical, 10)
                    }

                    // Filter tabs
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: 6) {
                            filterChip("Todas", tag: 0)
                            filterChip("Pendientes", tag: 1)
                            filterChip("En Progreso", tag: 2)
                            filterChip("Completadas", tag: 3)
                            filterChip("Vencidas", tag: 4)
                        }
                        .padding(.horizontal)
                        .padding(.bottom, 8)
                    }

                    if filteredTasks.isEmpty {
                        Spacer()
                        VStack(spacing: 12) {
                            Image(systemName: "checklist")
                                .font(.system(size: 48))
                                .foregroundStyle(Color(.tertiaryLabel))
                            Text("No hay tareas")
                                .font(.subheadline).foregroundStyle(.secondary)
                        }
                        Spacer()
                    } else {
                        List {
                            if !activeTasks.isEmpty {
                                Section("Activas (\(activeTasks.count))") {
                                    ForEach(activeTasks) { task in
                                        Button { selectedTask = task } label: {
                                            TaskRow(task: task)
                                        }
                                        .buttonStyle(.plain)
                                        .swipeActions(edge: .leading) {
                                            Button {
                                                Task { await completeTask(task) }
                                            } label: {
                                                Label("Completar", systemImage: "checkmark.circle.fill")
                                            }
                                            .tint(Color.rdGreen)
                                        }
                                    }
                                }
                            }
                            if !completedTasks.isEmpty {
                                Section("Completadas (\(completedTasks.count))") {
                                    ForEach(completedTasks) { task in
                                        Button { selectedTask = task } label: {
                                            TaskRow(task: task)
                                        }
                                        .buttonStyle(.plain)
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
        .navigationTitle("Tareas")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if canCreate {
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        showCreate = true
                    } label: {
                        Image(systemName: "plus")
                    }
                }
            }
        }
        .task { await load() }
        .refreshable { await load() }
        .sheet(isPresented: $showCreate) {
            CreateTaskSheet(onCreated: { newTask in
                tasks.insert(newTask, at: 0)
            })
            .environmentObject(api)
        }
        .sheet(item: $selectedTask) { task in
            TaskDetailSheet(task: task, onComplete: {
                Task { await load() }
            })
            .environmentObject(api)
        }
    }

    // MARK: - Subviews

    private func statPill(_ label: String, value: Int, color: Color) -> some View {
        VStack(spacing: 2) {
            Text("\(value)")
                .font(.title3).bold()
                .foregroundStyle(color)
            Text(label)
                .font(.system(size: 9))
                .foregroundStyle(.secondary)
        }
        .frame(minWidth: 60)
        .padding(.vertical, 8).padding(.horizontal, 6)
        .background(Color(.secondarySystemGroupedBackground))
        .clipShape(RoundedRectangle(cornerRadius: 10))
    }

    private func filterChip(_ title: String, tag: Int) -> some View {
        Button {
            withAnimation(.easeInOut(duration: 0.15)) { filter = tag }
        } label: {
            Text(title)
                .font(.caption).bold()
                .padding(.horizontal, 14).padding(.vertical, 7)
                .background(filter == tag ? Color(.label) : Color(.secondarySystemFill))
                .foregroundStyle(filter == tag ? Color(.systemBackground) : .primary)
                .clipShape(RoundedRectangle(cornerRadius: 6))
        }
        .buttonStyle(.plain)
    }

    // MARK: - Actions

    private func load() async {
        if tasks.isEmpty { loading = true }
        errorMsg = nil
        do {
            tasks = try await api.listTasks()
        } catch {
            errorMsg = error.localizedDescription
        }
        loading = false
    }

    private func completeTask(_ task: TaskItem) async {
        do {
            try await api.completeTask(id: task.id)
            await load() // Refresh entire list for correct stats
        } catch {
            errorMsg = error.localizedDescription
        }
    }
}

// MARK: - Task Row

struct TaskRow: View {
    let task: TaskItem

    private var priorityColor: Color {
        switch task.priority {
        case "alta": return Color.rdRed
        case "baja": return Color.rdGreen
        default:     return .orange
        }
    }

    private var statusColor: Color {
        switch task.status {
        case "en_progreso": return Color.rdBlue
        case "completada":  return Color.rdGreen
        default:            return .orange
        }
    }

    private var dueDateFormatted: String? {
        guard let due = task.dueDate else { return nil }
        let isoFmt = ISO8601DateFormatter()
        isoFmt.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let fallback = ISO8601DateFormatter()
        guard let date = isoFmt.date(from: due) ?? fallback.date(from: due) else { return nil }
        let fmt = DateFormatter()
        fmt.dateStyle = .medium
        fmt.timeStyle = .none
        fmt.locale = Locale(identifier: "es_DO")
        return fmt.string(from: date)
    }

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Circle()
                .fill(priorityColor)
                .frame(width: 8, height: 8)
                .padding(.top, 6)

            VStack(alignment: .leading, spacing: 4) {
                Text(task.title)
                    .font(.subheadline).bold()
                    .strikethrough(task.status == "completada")
                    .foregroundStyle(task.status == "completada" ? .secondary : .primary)
                    .lineLimit(2)

                if let desc = task.description, !desc.isEmpty {
                    Text(desc)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }

                HStack(spacing: 6) {
                    // Status badge
                    Text(task.statusLabel)
                        .font(.caption2).bold()
                        .padding(.horizontal, 6)
                        .padding(.vertical, 2)
                        .background(statusColor.opacity(0.15))
                        .foregroundStyle(statusColor)
                        .clipShape(Capsule())

                    // Priority badge
                    Text(task.priorityLabel)
                        .font(.caption2).bold()
                        .padding(.horizontal, 6)
                        .padding(.vertical, 2)
                        .background(priorityColor.opacity(0.15))
                        .foregroundStyle(priorityColor)
                        .clipShape(Capsule())

                    if task.source == "auto" {
                        Text("Auto")
                            .font(.caption2).bold()
                            .padding(.horizontal, 6)
                            .padding(.vertical, 2)
                            .background(Color.indigo.opacity(0.15))
                            .foregroundStyle(.indigo)
                            .clipShape(Capsule())
                    }

                    Spacer()

                    if task.isOverdue {
                        Image(systemName: "exclamationmark.triangle.fill")
                            .font(.caption2)
                            .foregroundStyle(Color.rdRed)
                    }

                    if let dueStr = dueDateFormatted {
                        Text(dueStr)
                            .font(.caption2)
                            .foregroundStyle(task.isOverdue ? Color.rdRed : .secondary)
                    }
                }
            }
        }
        .padding(.vertical, 4)
        .opacity(task.status == "completada" ? 0.6 : 1)
    }
}

// MARK: - Task Detail Sheet (with upload capability)

struct TaskDetailSheet: View {
    let task: TaskItem
    var onComplete: () -> Void

    @EnvironmentObject var api: APIService
    @Environment(\.dismiss) var dismiss
    @State private var showPicker = false
    @State private var selectedPhotos: [PhotosPickerItem] = []
    @State private var uploading = false
    @State private var completing = false
    @State private var uploadSuccess = false
    @State private var errorMsg: String?

    /// Does this task require a file upload?
    private var needsUpload: Bool {
        guard task.status != "completada" else { return false }
        let uploadEvents = ["documents_requested", "documents_insufficient", "payment_required", "payment_rejected"]
        return task.applicationId != nil && uploadEvents.contains(task.sourceEvent ?? "")
    }

    /// Is this a payment-related task?
    private var isPaymentTask: Bool {
        ["payment_required", "payment_rejected"].contains(task.sourceEvent ?? "")
    }

    private var uploadLabel: String {
        if isPaymentTask { return "Subir comprobante de pago" }
        return "Subir documento"
    }

    private var uploadIcon: String {
        if isPaymentTask { return "creditcard.fill" }
        return "doc.badge.arrow.up.fill"
    }

    private var taskIcon: String {
        switch task.sourceEvent {
        case "documents_requested", "documents_insufficient": return "doc.text.fill"
        case "payment_required", "payment_rejected": return "creditcard.fill"
        case "payment_uploaded": return "checkmark.seal.fill"
        case "tour_scheduled": return "calendar.badge.clock"
        default: return "checklist"
        }
    }

    private var taskColor: Color {
        switch task.sourceEvent {
        case "documents_requested", "documents_insufficient": return .orange
        case "payment_required", "payment_rejected": return Color.rdBlue
        case "payment_uploaded": return Color.rdGreen
        default: return Color.rdBlue
        }
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 20) {
                    // Icon header
                    VStack(spacing: 12) {
                        ZStack {
                            Circle()
                                .fill(taskColor.opacity(0.12))
                                .frame(width: 72, height: 72)
                            Image(systemName: taskIcon)
                                .font(.system(size: 30))
                                .foregroundStyle(taskColor)
                        }

                        Text(task.title)
                            .font(.title3.bold())
                            .multilineTextAlignment(.center)

                        // Status + priority
                        HStack(spacing: 8) {
                            Text(task.statusLabel)
                                .font(.caption.bold())
                                .foregroundStyle(task.status == "completada" ? Color.rdGreen : task.status == "en_progreso" ? Color.rdBlue : .orange)
                                .padding(.horizontal, 10).padding(.vertical, 4)
                                .background((task.status == "completada" ? Color.rdGreen : task.status == "en_progreso" ? Color.rdBlue : Color.orange).opacity(0.1))
                                .clipShape(Capsule())

                            Text(task.priorityLabel)
                                .font(.caption.bold())
                                .foregroundStyle(task.priority == "alta" ? Color.rdRed : task.priority == "baja" ? Color.rdGreen : .orange)
                                .padding(.horizontal, 10).padding(.vertical, 4)
                                .background((task.priority == "alta" ? Color.rdRed : task.priority == "baja" ? Color.rdGreen : Color.orange).opacity(0.1))
                                .clipShape(Capsule())

                            if task.isOverdue {
                                Label("Vencida", systemImage: "exclamationmark.triangle.fill")
                                    .font(.caption.bold())
                                    .foregroundStyle(Color.rdRed)
                                    .padding(.horizontal, 10).padding(.vertical, 4)
                                    .background(Color.rdRed.opacity(0.1))
                                    .clipShape(Capsule())
                            }
                        }
                    }
                    .padding(.top, 8)

                    // Description
                    if let desc = task.description, !desc.isEmpty {
                        VStack(alignment: .leading, spacing: 6) {
                            Text("Descripcion")
                                .font(.caption.bold())
                                .foregroundStyle(.secondary)
                            Text(desc)
                                .font(.subheadline)
                                .frame(maxWidth: .infinity, alignment: .leading)
                        }
                        .padding(14)
                        .background(Color(.secondarySystemGroupedBackground))
                        .clipShape(RoundedRectangle(cornerRadius: 12))
                    }

                    // Details
                    VStack(spacing: 10) {
                        if let due = task.dueDate {
                            detailRow(icon: "calendar", label: "Vence", value: formatDate(due))
                        }
                        if task.source == "auto" {
                            detailRow(icon: "gear", label: "Origen", value: "Generada automaticamente")
                        }
                        if let created = task.createdAt {
                            detailRow(icon: "clock", label: "Creada", value: formatDate(created))
                        }
                    }
                    .padding(14)
                    .background(Color(.secondarySystemGroupedBackground))
                    .clipShape(RoundedRectangle(cornerRadius: 12))

                    // Upload section (for document/payment tasks)
                    if needsUpload {
                        VStack(spacing: 14) {
                            Divider()

                            Image(systemName: uploadIcon)
                                .font(.system(size: 32))
                                .foregroundStyle(taskColor)

                            Text(isPaymentTask ? "Sube tu comprobante de pago" : "Sube los documentos solicitados")
                                .font(.subheadline.bold())
                                .multilineTextAlignment(.center)

                            Text(isPaymentTask
                                 ? "Toma una foto o selecciona el comprobante de tu galeria."
                                 : "Toma una foto de tu documento o selecciona de tu galeria. Formatos: JPG, PNG, PDF.")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                                .multilineTextAlignment(.center)

                            if uploadSuccess {
                                Label("Documento subido correctamente", systemImage: "checkmark.circle.fill")
                                    .font(.subheadline.bold())
                                    .foregroundStyle(Color.rdGreen)
                            } else {
                                Button { showPicker = true } label: {
                                    HStack {
                                        if uploading {
                                            ProgressView().tint(.white)
                                        } else {
                                            Image(systemName: "arrow.up.circle.fill")
                                        }
                                        Text(uploading ? "Subiendo..." : uploadLabel)
                                            .font(.subheadline.bold())
                                    }
                                    .foregroundStyle(.white)
                                    .frame(maxWidth: .infinity)
                                    .padding(.vertical, 14)
                                    .background(taskColor, in: RoundedRectangle(cornerRadius: 12))
                                }
                                .buttonStyle(.plain)
                                .disabled(uploading)
                            }
                        }
                        .padding(16)
                        .background(taskColor.opacity(0.05))
                        .clipShape(RoundedRectangle(cornerRadius: 14))
                    }

                    if let err = errorMsg {
                        Label(err, systemImage: "exclamationmark.circle")
                            .font(.caption)
                            .foregroundStyle(Color.rdRed)
                    }

                    // Complete button (for non-upload tasks or after upload)
                    if task.status != "completada" && (!needsUpload || uploadSuccess) {
                        Button {
                            Task { await markComplete() }
                        } label: {
                            HStack {
                                if completing { ProgressView().tint(.white) }
                                Text("Marcar como completada")
                                    .font(.subheadline.bold())
                            }
                            .foregroundStyle(.white)
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 14)
                            .background(Color.rdGreen, in: RoundedRectangle(cornerRadius: 12))
                        }
                        .buttonStyle(.plain)
                        .disabled(completing)
                    }
                }
                .padding(.horizontal, 20)
                .padding(.bottom, 24)
            }
            .navigationTitle("Detalle de Tarea")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cerrar") { dismiss() }
                }
            }
            .photosPicker(isPresented: $showPicker, selection: $selectedPhotos, maxSelectionCount: 5, matching: .any(of: [.images]))
            .onChange(of: selectedPhotos) {
                guard let item = selectedPhotos.first else { return }
                Task { await handleUpload(item: item) }
                selectedPhotos = []
            }
        }
    }

    // MARK: - Helpers

    private func detailRow(icon: String, label: String, value: String) -> some View {
        HStack(spacing: 10) {
            Image(systemName: icon)
                .font(.system(size: 14))
                .foregroundStyle(.secondary)
                .frame(width: 20)
            Text(label)
                .font(.caption.bold())
                .foregroundStyle(.secondary)
            Spacer()
            Text(value)
                .font(.caption)
        }
    }

    private func formatDate(_ iso: String) -> String {
        let fmt = ISO8601DateFormatter()
        fmt.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        var date = fmt.date(from: iso)
        if date == nil { fmt.formatOptions = [.withInternetDateTime]; date = fmt.date(from: iso) }
        guard let d = date else { return iso }
        let df = DateFormatter()
        df.locale = Locale(identifier: "es_DO")
        df.dateFormat = "d MMM yyyy"
        return df.string(from: d)
    }

    // MARK: - Actions

    private func handleUpload(item: PhotosPickerItem) async {
        guard let data = try? await item.loadTransferable(type: Data.self),
              let appId = task.applicationId else { return }
        let filename = "upload_\(Date().timeIntervalSince1970).jpg"

        uploading = true
        errorMsg = nil
        do {
            if isPaymentTask {
                try await api.uploadPaymentReceipt(
                    applicationId: appId, amount: "0", notes: task.title,
                    fileData: data, filename: filename
                )
            } else {
                try await api.uploadDocument(
                    applicationId: appId, requestId: nil,
                    type: "other", fileData: data, filename: filename
                )
            }
            withAnimation { uploadSuccess = true }
        } catch {
            errorMsg = error.localizedDescription
        }
        uploading = false
    }

    private func markComplete() async {
        completing = true
        do {
            try await api.completeTask(id: task.id)
            onComplete()
            dismiss()
        } catch {
            errorMsg = error.localizedDescription
        }
        completing = false
    }
}

// MARK: - Team member for picker

struct TeamMember: Identifiable, Decodable {
    let id: String
    let name: String
    let email: String?
}

struct TeamBrokersResponse: Decodable {
    let brokers: [TeamMember]
}

// MARK: - Create Task Sheet

struct CreateTaskSheet: View {
    var onCreated: (TaskItem) -> Void

    @EnvironmentObject var api: APIService
    @Environment(\.dismiss) var dismiss

    @State private var title = ""
    @State private var desc = ""
    @State private var priority = "media"
    @State private var hasDueDate = false
    @State private var dueDate = Calendar.current.date(byAdding: .day, value: 7, to: Date()) ?? Date()
    @State private var assignedTo = "" // "" = self
    @State private var teamMembers: [TeamMember] = []
    @State private var saving = false
    @State private var errorMsg: String?

    var body: some View {
        NavigationStack {
            Form {
                Section("Tarea") {
                    TextField("Título de la tarea", text: $title)
                    TextEditor(text: $desc)
                        .frame(minHeight: 80)
                        .overlay(alignment: .topLeading) {
                            if desc.isEmpty {
                                Text("Descripción (opcional)")
                                    .foregroundStyle(.tertiary)
                                    .padding(.top, 8)
                                    .padding(.leading, 4)
                                    .allowsHitTesting(false)
                            }
                        }
                }

                Section("Prioridad") {
                    Picker("Prioridad", selection: $priority) {
                        Text("Alta").tag("alta")
                        Text("Media").tag("media")
                        Text("Baja").tag("baja")
                    }
                    .pickerStyle(.segmented)
                }

                Section("Fecha límite") {
                    Toggle("Establecer fecha límite", isOn: $hasDueDate)
                    if hasDueDate {
                        DatePicker("Vence", selection: $dueDate, displayedComponents: .date)
                    }
                }

                Section {
                    Picker("Asignar a", selection: $assignedTo) {
                        Text("Yo mismo").tag("")
                        ForEach(teamMembers) { member in
                            Text("\(member.name)\(member.email.map { " (\($0))" } ?? "")")
                                .tag(member.id)
                        }
                    }
                } header: {
                    Text("Asignar a")
                } footer: {
                    if assignedTo.isEmpty {
                        Text("La tarea comenzará como Pendiente.")
                    } else {
                        Text("La tarea se asignará como En Progreso automáticamente.")
                    }
                }

                if let err = errorMsg {
                    Section {
                        Label(err, systemImage: "exclamationmark.triangle")
                            .font(.caption).foregroundStyle(.red)
                    }
                }
            }
            .navigationTitle("Nueva tarea")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancelar") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(saving ? "Guardando…" : "Crear") {
                        Task { await save() }
                    }
                    .disabled(title.trimmingCharacters(in: .whitespaces).isEmpty || saving)
                }
            }
            .presentationDetents([.large])
            .task { await loadTeam() }
        }
    }

    private func loadTeam() async {
        guard api.currentUser?.isTeamLead == true else { return }
        guard let url = URL(string: "\(apiBase)/api/inmobiliaria/brokers") else { return }
        guard let req = try? api.authedRequest(url) else { return }
        guard let (data, _) = try? await URLSession.shared.data(for: req) else { return }
        if let resp = try? JSONDecoder().decode(TeamBrokersResponse.self, from: data) {
            teamMembers = resp.brokers
        }
    }

    private func save() async {
        saving = true
        errorMsg = nil
        let dueDateStr: String? = hasDueDate ? ISO8601DateFormatter().string(from: dueDate) : nil
        let assignee: String? = assignedTo.isEmpty ? nil : assignedTo
        do {
            let task = try await api.createTask(
                title: title.trimmingCharacters(in: .whitespaces),
                description: desc.trimmingCharacters(in: .whitespaces),
                priority: priority,
                dueDate: dueDateStr,
                assignedTo: assignee
            )
            onCreated(task)
            dismiss()
        } catch {
            errorMsg = error.localizedDescription
        }
        saving = false
    }
}
