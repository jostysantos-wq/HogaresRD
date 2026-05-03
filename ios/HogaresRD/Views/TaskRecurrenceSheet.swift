// TaskRecurrenceSheet.swift
//
// Mirrors the web's task-recurrence dropdown on the task sheet's
// "Detalle" tab. Lets the task creator set a recurrence rule
// (daily/weekly/biweekly/monthly/yearly) with an interval and an
// optional terminator (count of occurrences OR end date).
//
// Server endpoint: PUT /api/tasks/:id/recurrence with body
//   { rule, interval, count?, until? }   to set
//   null                                 to clear

import SwiftUI

struct TaskRecurrenceSheet: View {
    let taskId: String
    /// Existing recurrence (if known) — pre-fills the form. Pass nil
    /// for tasks that aren't currently recurring.
    let existing: TaskRecurrence?
    /// Called with the freshly-saved task so the parent can refresh.
    var onSaved: (TaskItem) -> Void

    @EnvironmentObject var api: APIService
    @Environment(\.dismiss) private var dismiss

    @State private var enabled: Bool   = false
    @State private var rule:    String = "weekly"
    @State private var interval: Int   = 1
    @State private var terminator: Terminator = .none
    @State private var count:   Int    = 5
    @State private var until:   Date   = Date().addingTimeInterval(60 * 60 * 24 * 30)

    @State private var saving = false
    @State private var errorMsg: String?

    enum Terminator: String, CaseIterable, Identifiable {
        case none  = "Sin límite"
        case count = "Por número de veces"
        case until = "Hasta una fecha"
        var id: String { rawValue }
    }

    private static let rules: [(String, String)] = [
        ("daily",     "Diaria"),
        ("weekly",    "Semanal"),
        ("biweekly",  "Quincenal"),
        ("monthly",   "Mensual"),
        ("yearly",    "Anual"),
    ]

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Toggle("Repetir esta tarea", isOn: $enabled.animation())
                }

                if enabled {
                    Section("Frecuencia") {
                        Picker("Cada", selection: $rule) {
                            ForEach(Self.rules, id: \.0) { code, label in
                                Text(label).tag(code)
                            }
                        }
                        Stepper(value: $interval, in: 1...365) {
                            HStack {
                                Text("Intervalo")
                                Spacer()
                                Text("cada \(interval)")
                                    .foregroundStyle(.secondary)
                            }
                        }
                    }

                    Section("Cuándo termina") {
                        Picker("Terminador", selection: $terminator) {
                            ForEach(Terminator.allCases) { Text($0.rawValue).tag($0) }
                        }
                        .pickerStyle(.segmented)

                        if terminator == .count {
                            Stepper(value: $count, in: 1...1000) {
                                HStack {
                                    Text("Repetir")
                                    Spacer()
                                    Text("\(count) vez/veces")
                                        .foregroundStyle(.secondary)
                                }
                            }
                        } else if terminator == .until {
                            DatePicker("Hasta", selection: $until, in: Date()..., displayedComponents: .date)
                        }
                    }
                }

                if let errorMsg {
                    Section {
                        Label(errorMsg, systemImage: "exclamationmark.triangle.fill")
                            .foregroundStyle(.red)
                            .font(.callout)
                    }
                }
            }
            .navigationTitle("Recurrencia")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancelar") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Guardar") { Task { await save() } }
                        .disabled(saving)
                }
            }
            .onAppear { applyExisting() }
        }
    }

    private func applyExisting() {
        guard let r = existing else {
            enabled = false
            return
        }
        enabled = true
        rule = r.rule
        interval = r.interval
        if let c = r.count {
            terminator = .count
            count = max(1, min(1000, c))
        } else if let u = r.until {
            terminator = .until
            let f = ISO8601DateFormatter()
            f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            if let d = f.date(from: u) ?? {
                f.formatOptions = [.withInternetDateTime]; return f.date(from: u)
            }() {
                until = d
            }
        } else {
            terminator = .none
        }
    }

    private func save() async {
        saving = true
        errorMsg = nil
        defer { saving = false }
        do {
            let updated: TaskItem
            if !enabled {
                // Clear recurrence
                updated = try await api.setTaskRecurrence(taskId: taskId, recurrence: nil)
            } else {
                var rec = TaskRecurrence(rule: rule, interval: interval, count: nil, until: nil)
                switch terminator {
                case .none:  break
                case .count: rec.count = count
                case .until:
                    let f = ISO8601DateFormatter()
                    f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
                    rec.until = f.string(from: until)
                }
                updated = try await api.setTaskRecurrence(taskId: taskId, recurrence: rec)
            }
            await MainActor.run {
                onSaved(updated)
                dismiss()
            }
        } catch {
            errorMsg = (error as? LocalizedError)?.errorDescription ?? "No se pudo guardar."
        }
    }
}
