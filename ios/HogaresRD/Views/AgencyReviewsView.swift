// AgencyReviewsView.swift
//
// Inmobiliaria/constructora reviews moderation: pending list with
// approve/reject actions, plus a button to invite reviews from
// completed-deal applications. Mirrors the web's reviews tab.
//
// Note: the server has no "list ALL reviews" endpoint (only the
// public per-inmobiliaria GET, which doesn't expose pending), so
// this view focuses on the moderation actions.

import SwiftUI

struct AgencyReviewsView: View {
    @EnvironmentObject var api: APIService

    @State private var inviteAppId: String = ""
    @State private var inviteMessage: String = ""
    @State private var inviting = false
    @State private var inviteResult: String?
    @State private var pendingId: String = ""
    @State private var actioning = false
    @State private var actionResult: String?

    var body: some View {
        Form {
            Section {
                Text("Tus reseñas aparecen en tu página pública. Aprueba las que quieras destacar y rechaza las que no cumplan tus criterios.")
                    .font(.callout)
                    .foregroundStyle(.secondary)
            }

            // ── Invite reviews ──
            // Send a review request to the buyer of a completed deal.
            Section {
                TextField("Application ID", text: $inviteAppId)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                TextField("Mensaje opcional", text: $inviteMessage, axis: .vertical)
                    .lineLimit(2...6)
                Button {
                    Task { await invite() }
                } label: {
                    HStack {
                        if inviting { ProgressView().padding(.trailing, 4) }
                        Text("Enviar invitación de reseña")
                    }
                }
                .disabled(inviteAppId.isEmpty || inviting)
                if let inviteResult {
                    Label(inviteResult, systemImage: "checkmark.circle.fill")
                        .foregroundStyle(.green)
                        .font(.caption)
                }
            } header: {
                Text("Invitar reseña")
            } footer: {
                Text("Pega el ID de una aplicación cerrada/aprobada. El comprador recibirá un correo con un enlace para dejar su reseña.")
                    .font(.caption2)
            }

            // ── Moderate by ID ──
            // Approve/reject by review id (received from server-side
            // notifications). When the public reviews list endpoint
            // is added, this section can become a regular list.
            Section {
                TextField("Review ID", text: $pendingId)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                HStack {
                    Button {
                        Task { await approve() }
                    } label: {
                        HStack {
                            Image(systemName: "checkmark")
                            Text("Aprobar")
                        }
                        .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.borderedProminent)
                    .tint(.green)
                    .disabled(pendingId.isEmpty || actioning)

                    Button(role: .destructive) {
                        Task { await reject() }
                    } label: {
                        HStack {
                            Image(systemName: "xmark")
                            Text("Rechazar")
                        }
                        .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.bordered)
                    .disabled(pendingId.isEmpty || actioning)
                }
                if let actionResult {
                    Label(actionResult, systemImage: "info.circle.fill")
                        .font(.caption)
                }
            } header: {
                Text("Moderar reseña")
            } footer: {
                Text("Pega el ID de la reseña recibido por correo o notificación.")
                    .font(.caption2)
            }
        }
        .navigationTitle("Reseñas")
        .navigationBarTitleDisplayMode(.inline)
    }

    private func invite() async {
        inviting = true
        inviteResult = nil
        defer { inviting = false }
        do {
            _ = try await api.inviteAgencyReview(
                applicationId: inviteAppId.trimmingCharacters(in: .whitespaces),
                message: inviteMessage.isEmpty ? nil : inviteMessage
            )
            await MainActor.run {
                inviteResult = "Invitación enviada"
                inviteMessage = ""
                inviteAppId = ""
            }
        } catch {
            await MainActor.run {
                inviteResult = (error as? LocalizedError)?.errorDescription ?? "No se pudo enviar."
            }
        }
    }

    private func approve() async {
        actioning = true
        actionResult = nil
        defer { actioning = false }
        do {
            _ = try await api.approveAgencyReview(id: pendingId.trimmingCharacters(in: .whitespaces))
            await MainActor.run {
                actionResult = "Reseña aprobada"
                pendingId = ""
            }
        } catch {
            await MainActor.run {
                actionResult = (error as? LocalizedError)?.errorDescription ?? "No se pudo aprobar."
            }
        }
    }

    private func reject() async {
        actioning = true
        actionResult = nil
        defer { actioning = false }
        do {
            _ = try await api.rejectAgencyReview(id: pendingId.trimmingCharacters(in: .whitespaces), reason: nil)
            await MainActor.run {
                actionResult = "Reseña rechazada"
                pendingId = ""
            }
        } catch {
            await MainActor.run {
                actionResult = (error as? LocalizedError)?.errorDescription ?? "No se pudo rechazar."
            }
        }
    }
}
