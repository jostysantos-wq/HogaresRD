// LeaveInmobiliariaView.swift
//
// Lets a sub-broker leave their current inmobiliaria. Mirrors the
// web's POST /api/inmobiliaria/leave flow. Open applications are
// reassigned server-side to a chosen target (defaulting to the
// inmobiliaria owner).

import SwiftUI

struct LeaveInmobiliariaView: View {
    @EnvironmentObject var api: APIService
    @Environment(\.dismiss) private var dismiss

    @State private var transferToUserId: String = ""
    @State private var leaving = false
    @State private var errorMsg: String?
    @State private var done = false

    var body: some View {
        Form {
            Section {
                Text("Si abandonas tu inmobiliaria actual, tus aplicaciones abiertas se transferirán automáticamente al destinatario que indiques. Si lo dejas en blanco, las recibe el dueño de la inmobiliaria.")
                    .font(.callout)
                    .foregroundStyle(.secondary)
            }

            Section("Reasignar aplicaciones a") {
                TextField("ID de usuario destino (opcional)", text: $transferToUserId)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                Text("Pega el ID del compañero que recibirá tus aplicaciones. Déjalo vacío para que las reciba el propietario de la inmobiliaria.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            Section {
                Button(role: .destructive) {
                    Task { await leave() }
                } label: {
                    HStack {
                        if leaving { ProgressView().tint(.white).padding(.trailing, 4) }
                        Text(leaving ? "Saliendo…" : "Abandonar inmobiliaria")
                            .frame(maxWidth: .infinity)
                    }
                }
                .disabled(leaving || done)
            }

            if done {
                Section {
                    Label("Saliste de la inmobiliaria. Tus aplicaciones se reasignaron correctamente.",
                          systemImage: "checkmark.seal.fill")
                        .foregroundStyle(.green)
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
        .navigationTitle("Abandonar equipo")
        .navigationBarTitleDisplayMode(.inline)
    }

    private func leave() async {
        leaving = true
        errorMsg = nil
        defer { leaving = false }
        do {
            let target = transferToUserId.trimmingCharacters(in: .whitespaces)
            _ = try await api.leaveInmobiliaria(transferToUserId: target.isEmpty ? nil : target)
            // Refresh user — server bumps tokenVersion; we need a fresh
            // /me to reflect the cleared inmobiliaria_id.
            _ = try? await api.getMe()
            await MainActor.run {
                done = true
            }
            try? await Task.sleep(nanoseconds: 1_500_000_000)
            await MainActor.run { dismiss() }
        } catch {
            errorMsg = (error as? LocalizedError)?.errorDescription ?? "No se pudo procesar la salida."
        }
    }
}
