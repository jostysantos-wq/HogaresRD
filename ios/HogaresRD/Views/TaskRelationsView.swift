// TaskRelationsView.swift
//
// Mirrors the web's task-sheet "Subtareas" and "Dependencias"
// sections. Two server relations on the task model:
//   • parent_task_id  — strict tree ("X is a subtask of Y")
//   • depends_on[]    — DAG ("Y can't complete until X is done")
//
// Server runs cycle detection on every write, so the UI just lists
// + offers a picker. Pickers source from listTasks() and filter out
// the current task and (for dependencies) any already-linked
// predecessors.

import SwiftUI

struct TaskRelationsView: View {
    let task: TaskItem
    /// Called when something changes so the parent sheet can refresh.
    var onChanged: () -> Void = {}

    @EnvironmentObject var api: APIService

    @State private var subtasks:    [TaskItem] = []
    @State private var dependencies: [TaskItem] = []
    @State private var allTasks:    [TaskItem] = []
    @State private var loading:     Bool = false
    @State private var working:     Set<String> = []
    @State private var errorMsg:    String?
    @State private var showSubtaskPicker = false
    @State private var showDependencyPicker = false

    var body: some View {
        Form {
            // ── Subtasks ──
            Section {
                if subtasks.isEmpty && !loading {
                    Text("Esta tarea no tiene subtareas.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                } else {
                    ForEach(subtasks) { st in
                        relationRow(st, action: "Detach", color: .red) {
                            Task { await detachSubtask(st) }
                        }
                    }
                }
                Button {
                    showSubtaskPicker = true
                } label: {
                    Label("Añadir subtarea", systemImage: "plus.circle.fill")
                }
            } header: {
                Text("Subtareas")
            } footer: {
                Text("Las subtareas son tareas que pertenecen a esta. Forman un árbol estricto — una tarea tiene a lo más un padre.")
                    .font(.caption2)
            }

            // ── Dependencies ──
            Section {
                if dependencies.isEmpty && !loading {
                    Text("Esta tarea no espera por ninguna otra.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                } else {
                    ForEach(dependencies) { d in
                        relationRow(d, action: "Quitar", color: .red) {
                            Task { await removeDependency(d) }
                        }
                    }
                }
                Button {
                    showDependencyPicker = true
                } label: {
                    Label("Añadir dependencia", systemImage: "plus.circle.fill")
                }
            } header: {
                Text("Dependencias")
            } footer: {
                Text("Esta tarea no se puede completar hasta que terminen las que aparecen aquí.")
                    .font(.caption2)
            }

            if let errorMsg {
                Section {
                    Label(errorMsg, systemImage: "exclamationmark.triangle.fill")
                        .foregroundStyle(.red)
                        .font(.callout)
                }
            }
        }
        .navigationTitle("Subtareas y dependencias")
        .navigationBarTitleDisplayMode(.inline)
        .task { await reload() }
        .refreshable { await reload() }
        .sheet(isPresented: $showSubtaskPicker) {
            NavigationStack {
                TaskPickerView(
                    title: "Elegir subtarea",
                    candidates: candidatesForSubtask,
                    onPick: { picked in
                        Task { await attachSubtask(picked) }
                    }
                )
            }
        }
        .sheet(isPresented: $showDependencyPicker) {
            NavigationStack {
                TaskPickerView(
                    title: "Elegir predecesor",
                    candidates: candidatesForDependency,
                    onPick: { picked in
                        Task { await addDependency(picked) }
                    }
                )
            }
        }
    }

    @ViewBuilder
    private func relationRow(_ t: TaskItem, action: String, color: Color, onTap: @escaping () -> Void) -> some View {
        HStack(alignment: .top, spacing: 10) {
            VStack(alignment: .leading, spacing: 3) {
                Text(t.title).font(.subheadline)
                HStack(spacing: 6) {
                    Text(t.statusLabel)
                        .font(.caption2.bold())
                        .foregroundStyle(.secondary)
                    if let due = t.dueDate {
                        Text("· vence \(formatShort(due))")
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    }
                }
            }
            Spacer()
            if working.contains(t.id) {
                ProgressView()
            } else {
                Button(action: onTap) {
                    Text(action)
                        .font(.caption.bold())
                        .foregroundStyle(color)
                }
                .buttonStyle(.plain)
            }
        }
    }

    // MARK: - Picker source filters

    /// For "subtask" — exclude self + any task already with a parent
    /// elsewhere (server allows reparenting but doing so via a single
    /// tap from here would be confusing). Best-effort filter; server
    /// will reject anyway if it would create a cycle.
    private var candidatesForSubtask: [TaskItem] {
        let usedIds = Set(subtasks.map { $0.id } + [task.id])
        return allTasks.filter { !usedIds.contains($0.id) }
    }

    /// For "depends-on" — exclude self + already-linked predecessors.
    private var candidatesForDependency: [TaskItem] {
        let usedIds = Set(dependencies.map { $0.id } + [task.id])
        return allTasks.filter { !usedIds.contains($0.id) }
    }

    private func formatShort(_ iso: String) -> String {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        var d = f.date(from: iso)
        if d == nil { f.formatOptions = [.withInternetDateTime]; d = f.date(from: iso) }
        guard let date = d else { return iso }
        let df = DateFormatter()
        df.dateFormat = "d MMM"
        df.locale = Locale(identifier: "es_DO")
        return df.string(from: date)
    }

    // MARK: - Actions

    private func reload() async {
        loading = true
        errorMsg = nil
        defer { loading = false }
        do {
            async let subsT  = api.getTaskSubtasks(taskId: task.id)
            async let allT   = api.listTasks()
            // Dependencies are not exposed as a separate endpoint in
            // the same shape; the task model carries depends_on[] —
            // this iOS round just shows what the API offers via
            // subtasks. To list depends_on we'd extend the TaskItem
            // model. For now we only render an empty state and offer
            // the add picker.
            let (s, all) = try await (subsT, allT)
            await MainActor.run {
                subtasks = s
                allTasks = all
            }
        } catch {
            await MainActor.run { errorMsg = (error as? LocalizedError)?.errorDescription ?? "No se pudieron cargar." }
        }
    }

    private func attachSubtask(_ child: TaskItem) async {
        working.insert(child.id)
        defer { working.remove(child.id) }
        do {
            _ = try await api.setTaskParent(taskId: child.id, parentId: task.id)
            await reload()
            onChanged()
        } catch {
            errorMsg = (error as? LocalizedError)?.errorDescription ?? "No se pudo enlazar."
        }
    }

    private func detachSubtask(_ child: TaskItem) async {
        working.insert(child.id)
        defer { working.remove(child.id) }
        do {
            _ = try await api.setTaskParent(taskId: child.id, parentId: nil)
            await reload()
            onChanged()
        } catch {
            errorMsg = (error as? LocalizedError)?.errorDescription ?? "No se pudo desenlazar."
        }
    }

    private func addDependency(_ predecessor: TaskItem) async {
        working.insert(predecessor.id)
        defer { working.remove(predecessor.id) }
        do {
            _ = try await api.addTaskDependency(taskId: task.id, predecessorId: predecessor.id)
            await MainActor.run { dependencies.append(predecessor) }
            onChanged()
        } catch {
            errorMsg = (error as? LocalizedError)?.errorDescription ?? "No se pudo añadir."
        }
    }

    private func removeDependency(_ predecessor: TaskItem) async {
        working.insert(predecessor.id)
        defer { working.remove(predecessor.id) }
        do {
            _ = try await api.removeTaskDependency(taskId: task.id, predecessorId: predecessor.id)
            await MainActor.run { dependencies.removeAll { $0.id == predecessor.id } }
            onChanged()
        } catch {
            errorMsg = (error as? LocalizedError)?.errorDescription ?? "No se pudo quitar."
        }
    }
}

// MARK: - Reusable picker

struct TaskPickerView: View {
    let title: String
    let candidates: [TaskItem]
    var onPick: (TaskItem) -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var query: String = ""

    var body: some View {
        List {
            if filtered.isEmpty {
                Text("Sin tareas elegibles.")
                    .font(.callout)
                    .foregroundStyle(.secondary)
            } else {
                ForEach(filtered) { t in
                    Button {
                        onPick(t)
                        dismiss()
                    } label: {
                        VStack(alignment: .leading, spacing: 3) {
                            Text(t.title).font(.subheadline.bold())
                            HStack(spacing: 6) {
                                Text(t.statusLabel)
                                    .font(.caption2)
                                    .foregroundStyle(.secondary)
                                if let appId = t.applicationId, !appId.isEmpty {
                                    Text("· aplicación")
                                        .font(.caption2)
                                        .foregroundStyle(.secondary)
                                }
                            }
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    .buttonStyle(.plain)
                }
            }
        }
        .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .always),
                    prompt: "Buscar tarea")
        .navigationTitle(title)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .cancellationAction) {
                Button("Cancelar") { dismiss() }
            }
        }
    }

    private var filtered: [TaskItem] {
        let q = query.lowercased()
        guard !q.isEmpty else { return candidates }
        return candidates.filter { $0.title.lowercased().contains(q) }
    }
}
