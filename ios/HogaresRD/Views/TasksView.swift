import SwiftUI

// MARK: - Tasks list

struct TasksView: View {
    @EnvironmentObject var api: APIService

    @State private var tasks: [TaskItem] = []
    @State private var loading = true
    @State private var errorMsg: String?
    @State private var filter = 0 // 0=Todas, 1=Pendientes, 2=Completadas
    @State private var showCreate = false

    private var filteredTasks: [TaskItem] {
        switch filter {
        case 1:  return tasks.filter { $0.status != "completada" }
        case 2:  return tasks.filter { $0.status == "completada" }
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
            } else if tasks.isEmpty {
                VStack(spacing: 16) {
                    Image(systemName: "checklist")
                        .font(.system(size: 60))
                        .foregroundStyle(Color.rdBlue.opacity(0.35))
                    Text("Sin tareas")
                        .font(.title3).bold()
                    Text("No tienes tareas asignadas por el momento.")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                        .padding(.horizontal, 32)
                }
            } else {
                VStack(spacing: 0) {
                    Picker("Filtro", selection: $filter) {
                        Text("Todas").tag(0)
                        Text("Pendientes").tag(1)
                        Text("Completadas").tag(2)
                    }
                    .pickerStyle(.segmented)
                    .padding(.horizontal)
                    .padding(.vertical, 8)

                    List {
                        if !activeTasks.isEmpty {
                            Section("Activas") {
                                ForEach(activeTasks) { task in
                                    TaskRow(task: task)
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
                            Section("Completadas") {
                                ForEach(completedTasks) { task in
                                    TaskRow(task: task)
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
    }

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
            if let idx = tasks.firstIndex(where: { $0.id == task.id }) {
                tasks[idx] = TaskItem(
                    id: task.id, title: task.title, description: task.description,
                    status: "completada", priority: task.priority, dueDate: task.dueDate,
                    assignedTo: task.assignedTo, assignedBy: task.assignedBy,
                    applicationId: task.applicationId, listingId: task.listingId,
                    source: task.source, sourceEvent: task.sourceEvent,
                    completedAt: ISO8601DateFormatter().string(from: Date()),
                    createdAt: task.createdAt, updatedAt: task.updatedAt
                )
            }
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
        default:     return .yellow
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
        return "Vence \(fmt.string(from: date))"
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
                    .lineLimit(2)

                if let desc = task.description, !desc.isEmpty {
                    Text(desc)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }

                HStack(spacing: 6) {
                    Text(task.statusLabel)
                        .font(.caption2).bold()
                        .padding(.horizontal, 6)
                        .padding(.vertical, 2)
                        .background(statusColor.opacity(0.15))
                        .foregroundStyle(statusColor)
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

                    if let dueStr = dueDateFormatted {
                        Text(dueStr)
                            .font(.caption2)
                            .foregroundStyle(task.isOverdue ? Color.rdRed : .secondary)
                    }
                }
            }
        }
        .padding(.vertical, 4)
    }
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
    @State private var assignedTo = ""
    @State private var saving = false
    @State private var errorMsg: String?

    var body: some View {
        NavigationStack {
            Form {
                Section("Tarea") {
                    TextField("Titulo de la tarea", text: $title)
                    TextEditor(text: $desc)
                        .frame(minHeight: 80)
                        .overlay(alignment: .topLeading) {
                            if desc.isEmpty {
                                Text("Descripcion (opcional)")
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

                Section("Fecha limite") {
                    Toggle("Establecer fecha limite", isOn: $hasDueDate)
                    if hasDueDate {
                        DatePicker("Vence", selection: $dueDate, displayedComponents: .date)
                    }
                }

                Section("Asignar a") {
                    TextField("ID del agente", text: $assignedTo)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
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
                    Button(saving ? "Guardando..." : "Crear") {
                        Task { await save() }
                    }
                    .disabled(title.trimmingCharacters(in: .whitespaces).isEmpty || saving)
                }
            }
            .presentationDetents([.large])
        }
    }

    private func save() async {
        saving = true
        errorMsg = nil
        let dueDateStr: String? = hasDueDate ? ISO8601DateFormatter().string(from: dueDate) : nil
        let assignee: String? = assignedTo.trimmingCharacters(in: .whitespaces).isEmpty ? nil : assignedTo.trimmingCharacters(in: .whitespaces)
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
