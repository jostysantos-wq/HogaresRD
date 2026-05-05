import SwiftUI

// MARK: - Cancel Subscription Retention Flow (4 steps)

struct CancelSubscriptionView: View {
    @EnvironmentObject var api: APIService
    @Environment(\.dismiss) var dismiss
    @Environment(\.openURL) var openURL

    @State private var step = 1
    @State private var stats: CancelStats?
    @State private var loading = true
    @State private var processing = false
    @State private var selectedReason = ""
    @State private var feedbackText = ""
    @State private var resultMessage = ""
    @State private var showResult = false

    private let reasons = [
        ("expensive", "Muy caro para mi presupuesto"),
        ("no_leads", "No estoy recibiendo suficientes leads"),
        ("competitor", "Encontre otra plataforma"),
        ("business_pause", "Mi negocio esta en pausa temporal"),
        ("missing_features", "Le faltan funciones que necesito"),
        ("other", "Otro motivo"),
    ]

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 24) {
                    if loading {
                        ProgressView("Cargando...").padding(.top, 60)
                    } else if showResult {
                        resultView
                    } else {
                        switch step {
                        case 1: step1WhatYouLose
                        case 2: step2PauseOffer
                        case 3: step3Reason
                        case 4: step4TargetedOffer
                        default: step1WhatYouLose
                        }
                    }
                }
                .padding(24)
            }
            .navigationTitle("Cancelar suscripcion")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cerrar") { dismiss() }
                }
            }
        }
        .task { await loadStats() }
    }

    private func loadStats() async {
        do {
            stats = try await api.getCancelStats()
        } catch {
            stats = CancelStats(listings: 0, applications: 0, conversations: 0, tours: 0, totalViews: 0, memberSince: nil)
        }
        loading = false
    }

    // MARK: - Step 1: What you'll lose

    private var step1WhatYouLose: some View {
        VStack(spacing: 20) {
            Image(systemName: "exclamationmark.triangle.fill")
                .font(.system(size: 48))
                .foregroundStyle(.orange)

            Text("Esto es lo que perderas")
                .font(.title2.bold())

            Text("Al cancelar, perderas acceso a todas estas herramientas y datos.")
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)

            // Stats grid
            LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: 12) {
                statCard("Propiedades", value: stats?.listings ?? 0, icon: "house.fill", color: .rdBlue)
                statCard("Aplicaciones", value: stats?.applications ?? 0, icon: "doc.text.fill", color: .rdGreen)
                statCard("Vistas totales", value: stats?.totalViews ?? 0, icon: "eye.fill", color: .orange)
                statCard("Conversaciones", value: stats?.conversations ?? 0, icon: "bubble.left.fill", color: Color.rdPurple)
            }

            Button {
                withAnimation { step = 2 }
            } label: {
                Text("Continuar con la cancelacion")
                    .font(.subheadline.bold())
                    .foregroundStyle(.white)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 14)
                    .background(Color.rdRed, in: RoundedRectangle(cornerRadius: 12))
            }
            .buttonStyle(.plain)

            Button { dismiss() } label: {
                Text("Mejor no, quiero quedarme")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }
        }
    }

    // MARK: - Step 2: Pause offer

    private var step2PauseOffer: some View {
        VStack(spacing: 20) {
            Image(systemName: "pause.circle.fill")
                .font(.system(size: 48))
                .foregroundStyle(Color.rdBlue)

            Text("Pausa en vez de cancelar?")
                .font(.title2.bold())

            Text("Puedes pausar tu suscripcion por 1 mes sin costo. Tus datos y propiedades se mantienen.")
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)

            Button {
                Task { await submitOffer("pause") }
            } label: {
                HStack {
                    if processing { ProgressView().tint(.white) }
                    Text("Pausar por 1 mes (gratis)")
                        .font(.subheadline.bold())
                }
                .foregroundStyle(.white)
                .frame(maxWidth: .infinity)
                .padding(.vertical, 14)
                .background(Color.rdBlue, in: RoundedRectangle(cornerRadius: 12))
            }
            .buttonStyle(.plain)
            .disabled(processing)

            Button {
                withAnimation { step = 3 }
            } label: {
                Text("No, quiero cancelar")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 12)
                    .overlay(RoundedRectangle(cornerRadius: 12).stroke(Color(.separator)))
            }
            .buttonStyle(.plain)
        }
    }

    // MARK: - Step 3: Reason

    private var step3Reason: some View {
        VStack(spacing: 20) {
            Image(systemName: "text.bubble.fill")
                .font(.system(size: 48))
                .foregroundStyle(Color.rdBlue)

            Text("Cuentanos por que")
                .font(.title2.bold())

            Text("Tu feedback nos ayuda a mejorar para agentes como tu.")
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)

            VStack(spacing: 10) {
                ForEach(reasons, id: \.0) { reason in
                    Button {
                        selectedReason = reason.0
                    } label: {
                        HStack {
                            Text(reason.1)
                                .font(.subheadline)
                                .foregroundStyle(.primary)
                            Spacer()
                            Image(systemName: selectedReason == reason.0 ? "checkmark.circle.fill" : "circle")
                                .foregroundStyle(selectedReason == reason.0 ? Color.rdBlue : .secondary)
                        }
                        .padding(14)
                        .background(selectedReason == reason.0 ? Color.rdBlue.opacity(0.08) : Color(.secondarySystemGroupedBackground))
                        .clipShape(RoundedRectangle(cornerRadius: 10))
                    }
                    .buttonStyle(.plain)
                }
            }

            TextField("Comentarios adicionales (opcional)", text: $feedbackText, axis: .vertical)
                .lineLimit(3...5)
                .font(.subheadline)
                .padding(12)
                .background(Color(.secondarySystemGroupedBackground))
                .clipShape(RoundedRectangle(cornerRadius: 10))

            Button {
                guard !selectedReason.isEmpty else { return }
                withAnimation { step = 4 }
            } label: {
                Text("Continuar")
                    .font(.subheadline.bold())
                    .foregroundStyle(.white)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 14)
                    .background(selectedReason.isEmpty ? Color.gray : Color.rdRed, in: RoundedRectangle(cornerRadius: 12))
            }
            .buttonStyle(.plain)
            .disabled(selectedReason.isEmpty)

            Button { dismiss() } label: {
                Text("Cancelar")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }
        }
    }

    // MARK: - Step 4: Targeted offer

    private var step4TargetedOffer: some View {
        VStack(spacing: 20) {
            if selectedReason == "business_pause" {
                // Re-offer pause
                Image(systemName: "pause.circle.fill")
                    .font(.system(size: 48))
                    .foregroundStyle(Color.rdBlue)
                Text("Pausa gratuita de 1 mes")
                    .font(.title2.bold())
                Text("Perfecto para una pausa temporal. Tus datos se mantienen y puedes reactivar cuando quieras.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)

                offerButton("Pausar suscripcion", offer: "pause", color: .rdBlue)
            } else if ["expensive", "no_leads", "competitor", "missing_features"].contains(selectedReason) {
                // Discount offer
                Image(systemName: "gift.fill")
                    .font(.system(size: 48))
                    .foregroundStyle(Color.rdBlue)
                Text("30% de descuento por 3 meses")
                    .font(.title2.bold())
                Text(selectedReason == "no_leads"
                     ? "Nuestro equipo puede ayudarte a optimizar tus listados. Ademas, te ofrecemos 30% de descuento."
                     : "Te ofrecemos un 30% de descuento por los proximos 3 meses para que sigas creciendo.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)

                offerButton("Aplicar descuento", offer: "discount", color: .rdBlue)
            } else {
                // Generic final confirmation
                Image(systemName: "hand.wave.fill")
                    .font(.system(size: 48))
                    .foregroundStyle(.secondary)
                Text("Confirmar cancelacion")
                    .font(.title2.bold())
                Text("Tu suscripcion se cancelara al final del periodo actual. Tus datos se mantendran por 90 dias.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
            }

            // Final cancel button
            Button {
                Task { await submitOffer(nil) }
            } label: {
                HStack {
                    if processing { ProgressView().tint(Color.rdRed) }
                    Text(["expensive", "no_leads", "competitor", "missing_features", "business_pause"].contains(selectedReason)
                         ? "No gracias, cancelar definitivamente" : "Cancelar suscripcion")
                        .font(.subheadline.bold())
                }
                .foregroundStyle(Color.rdRed)
                .frame(maxWidth: .infinity)
                .padding(.vertical, 12)
                .overlay(RoundedRectangle(cornerRadius: 12).stroke(Color.rdRed))
            }
            .buttonStyle(.plain)
            .disabled(processing)
        }
    }

    // MARK: - Result

    private var resultView: some View {
        VStack(spacing: 20) {
            Image(systemName: "checkmark.circle.fill")
                .font(.system(size: 48))
                .foregroundStyle(Color.rdGreen)
            Text("Listo!")
                .font(.title2.bold())
            Text(resultMessage)
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
            Button { dismiss() } label: {
                Text("Cerrar")
                    .font(.subheadline.bold())
                    .foregroundStyle(.white)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 14)
                    .background(Color.rdBlue, in: RoundedRectangle(cornerRadius: 12))
            }
            .buttonStyle(.plain)
        }
        .padding(.top, 40)
    }

    // MARK: - Helpers

    private func offerButton(_ text: String, offer: String, color: Color) -> some View {
        Button {
            Task { await submitOffer(offer) }
        } label: {
            HStack {
                if processing { ProgressView().tint(.white) }
                Text(text).font(.subheadline.bold())
            }
            .foregroundStyle(.white)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 14)
            .background(color, in: RoundedRectangle(cornerRadius: 12))
        }
        .buttonStyle(.plain)
        .disabled(processing)
    }

    private func submitOffer(_ offer: String?) async {
        processing = true
        do {
            let result = try await api.submitCancelFeedback(
                reason: selectedReason,
                feedback: feedbackText,
                acceptedOffer: offer
            )
            if let url = result.url, let u = URL(string: url) {
                openURL(u)
                dismiss()
            } else {
                resultMessage = result.message ?? "Tu solicitud ha sido procesada."
                withAnimation { showResult = true }
            }
        } catch {
            resultMessage = "Error al procesar. Intenta de nuevo."
            withAnimation { showResult = true }
        }
        processing = false
    }

    private func statCard(_ label: String, value: Int, icon: String, color: Color) -> some View {
        VStack(spacing: 6) {
            Image(systemName: icon)
                .font(.system(size: 20))
                .foregroundStyle(color)
            Text("\(value)")
                .font(.title2.bold())
            Text(label)
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 16)
        .background(color.opacity(0.06))
        .clipShape(RoundedRectangle(cornerRadius: 12))
    }
}
