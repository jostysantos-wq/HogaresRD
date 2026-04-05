import SwiftUI

/// Reusable report sheet for listings, agents, or inmobiliarias.
struct ReportView: View {
    let reportType: ReportType
    let targetId: String
    let targetName: String

    @EnvironmentObject var api: APIService
    @Environment(\.dismiss) var dismiss

    @State private var selectedReason = ""
    @State private var details = ""
    @State private var submitting = false
    @State private var submitted = false
    @State private var errorMsg: String?

    enum ReportType: String {
        case listing = "listing"
        case agent = "agent"
        case inmobiliaria = "inmobiliaria"

        var title: String {
            switch self {
            case .listing:      return "Reportar Propiedad"
            case .agent:        return "Reportar Agente"
            case .inmobiliaria: return "Reportar Inmobiliaria"
            }
        }

        var reasons: [(String, String)] {
            switch self {
            case .listing:
                return [
                    ("informacion_falsa",  "Informacion falsa o enganosa"),
                    ("precio_incorrecto",  "Precio incorrecto"),
                    ("propiedad_vendida",  "Propiedad ya vendida o no disponible"),
                    ("fotos_enganosas",    "Fotos enganosas o no corresponden"),
                    ("spam",               "Spam o publicacion duplicada"),
                    ("fraude",             "Posible fraude o estafa"),
                    ("otro",               "Otro"),
                ]
            case .agent:
                return [
                    ("comportamiento_inapropiado", "Comportamiento inapropiado"),
                    ("no_responde",                "No responde a consultas"),
                    ("informacion_falsa",          "Proporciona informacion falsa"),
                    ("fraude",                     "Posible fraude"),
                    ("acoso",                      "Acoso o presion indebida"),
                    ("otro",                       "Otro"),
                ]
            case .inmobiliaria:
                return [
                    ("practica_desleal",   "Practica comercial desleal"),
                    ("incumplimiento",     "Incumplimiento de acuerdos"),
                    ("informacion_falsa",  "Informacion falsa sobre la empresa"),
                    ("fraude",             "Posible fraude"),
                    ("otro",               "Otro"),
                ]
            }
        }
    }

    var body: some View {
        NavigationStack {
            if submitted {
                successView
            } else {
                formView
            }
        }
    }

    // MARK: - Form

    private var formView: some View {
        List {
            Section {
                HStack(spacing: 14) {
                    ZStack {
                        Circle()
                            .fill(Color.rdRed.opacity(0.1))
                            .frame(width: 44, height: 44)
                        Image(systemName: "flag.fill")
                            .foregroundStyle(Color.rdRed)
                    }
                    VStack(alignment: .leading, spacing: 3) {
                        Text(reportType.title)
                            .font(.subheadline).bold()
                        Text(targetName)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .lineLimit(2)
                    }
                }
                .padding(.vertical, 4)
            }

            Section("Razon del reporte") {
                ForEach(reportType.reasons, id: \.0) { code, label in
                    Button {
                        selectedReason = code
                    } label: {
                        HStack {
                            Text(label)
                                .font(.subheadline)
                                .foregroundStyle(.primary)
                            Spacer()
                            if selectedReason == code {
                                Image(systemName: "checkmark.circle.fill")
                                    .foregroundStyle(Color.rdBlue)
                            }
                        }
                    }
                }
            }

            Section("Detalles adicionales (opcional)") {
                TextEditor(text: $details)
                    .frame(minHeight: 80)
                    .font(.subheadline)
            }

            if let err = errorMsg {
                Section {
                    Label(err, systemImage: "exclamationmark.circle.fill")
                        .font(.caption)
                        .foregroundStyle(.red)
                }
            }

            Section {
                Button {
                    Task { await submit() }
                } label: {
                    HStack {
                        Spacer()
                        if submitting {
                            ProgressView().tint(.white)
                        } else {
                            Text("Enviar Reporte")
                                .bold()
                        }
                        Spacer()
                    }
                }
                .disabled(selectedReason.isEmpty || submitting)
                .listRowBackground(selectedReason.isEmpty ? Color(.systemGray4) : Color.rdRed)
                .foregroundStyle(.white)
            }
        }
        .navigationTitle(reportType.title)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .cancellationAction) {
                Button("Cancelar") { dismiss() }
            }
        }
    }

    // MARK: - Success

    private var successView: some View {
        VStack(spacing: 24) {
            Spacer()

            ZStack {
                Circle()
                    .fill(Color.rdGreen.opacity(0.1))
                    .frame(width: 100, height: 100)
                Image(systemName: "checkmark.circle.fill")
                    .font(.system(size: 48))
                    .foregroundStyle(Color.rdGreen)
            }

            VStack(spacing: 8) {
                Text("Reporte enviado")
                    .font(.title2).bold()
                Text("Gracias por ayudarnos a mantener la calidad de HogaresRD. Nuestro equipo revisara tu reporte y tomara las medidas necesarias.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, 32)
            }

            Button {
                dismiss()
            } label: {
                Text("Entendido")
                    .bold()
                    .frame(maxWidth: .infinity)
                    .padding()
                    .background(Color.rdBlue)
                    .foregroundStyle(.white)
                    .clipShape(RoundedRectangle(cornerRadius: 12))
            }
            .padding(.horizontal, 32)

            Spacer()
        }
        .navigationTitle("Reporte Enviado")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .cancellationAction) {
                Button("Cerrar") { dismiss() }
            }
        }
    }

    // MARK: - Submit

    private func submit() async {
        guard !selectedReason.isEmpty else { return }
        submitting = true
        errorMsg = nil

        do {
            try await api.submitReport(
                type: reportType.rawValue,
                targetId: targetId,
                targetName: targetName,
                reason: selectedReason,
                details: details
            )
            submitted = true
            let impact = UINotificationFeedbackGenerator()
            impact.notificationOccurred(.success)
        } catch {
            errorMsg = error.localizedDescription
        }
        submitting = false
    }
}
