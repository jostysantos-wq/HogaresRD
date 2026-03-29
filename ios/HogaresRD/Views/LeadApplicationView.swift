import SwiftUI

struct LeadApplicationView: View {
    let listing: Listing
    @EnvironmentObject var api: APIService
    @Environment(\.dismiss) private var dismiss

    // Form fields
    @State private var name     = ""
    @State private var phone    = ""
    @State private var email    = ""
    @State private var intent   = "comprar"
    @State private var timeline = "1-3 meses"
    @State private var budget   = ""
    @State private var notes    = ""

    // State
    @State private var submitting = false
    @State private var submitted  = false
    @State private var errorMsg   = ""

    private let intents   = [("comprar","Comprar"),("alquilar","Alquilar"),("invertir","Invertir")]
    private let timelines = ["Inmediato","1-3 meses","3-6 meses","6-12 meses","+1 año"]

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
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {

                // Listing context pill
                HStack(spacing: 10) {
                    Image(systemName: "house.fill")
                        .foregroundStyle(Color.rdBlue)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(listing.title)
                            .font(.subheadline.weight(.semibold))
                            .lineLimit(1)
                        if !listing.price.isEmpty {
                            Text("$\(listing.price)")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                    }
                    Spacer()
                }
                .padding(12)
                .background(Color.rdBlue.opacity(0.07))
                .clipShape(RoundedRectangle(cornerRadius: 12))

                Group {
                    field("Nombre completo", systemImage: "person") {
                        TextField("Tu nombre", text: $name)
                    }
                    HStack(spacing: 12) {
                        field("Teléfono", systemImage: "phone") {
                            TextField("809-555-0000", text: $phone)
                                .keyboardType(.phonePad)
                        }
                        field("Email", systemImage: "envelope") {
                            TextField("tu@email.com", text: $email)
                                .keyboardType(.emailAddress)
                                .autocapitalization(.none)
                        }
                    }
                }

                // Intención
                VStack(alignment: .leading, spacing: 6) {
                    Label("Intención", systemImage: "target")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.secondary)
                    Picker("Intención", selection: $intent) {
                        ForEach(intents, id: \.0) { Text($0.1).tag($0.0) }
                    }
                    .pickerStyle(.segmented)
                }

                // Timeline
                VStack(alignment: .leading, spacing: 6) {
                    Label("Plazo estimado", systemImage: "calendar")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.secondary)
                    Picker("Plazo", selection: $timeline) {
                        ForEach(timelines, id: \.self) { Text($0).tag($0) }
                    }
                    .pickerStyle(.menu)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 10)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(Color(.systemGray6))
                    .clipShape(RoundedRectangle(cornerRadius: 10))
                }

                field("Presupuesto máximo (USD)", systemImage: "dollarsign.circle") {
                    TextField("ej. 150,000", text: $budget)
                        .keyboardType(.numbersAndPunctuation)
                }

                // Notes
                VStack(alignment: .leading, spacing: 6) {
                    Label("Notas adicionales", systemImage: "text.bubble")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.secondary)
                    TextEditor(text: $notes)
                        .frame(minHeight: 80)
                        .padding(8)
                        .background(Color(.systemGray6))
                        .clipShape(RoundedRectangle(cornerRadius: 10))
                }

                if !errorMsg.isEmpty {
                    Text(errorMsg)
                        .font(.subheadline)
                        .foregroundStyle(.red)
                }

                Text("Al enviar, HogaresRD coordinará el proceso con la inmobiliaria afiliada. Puedes recibir comunicación de nuestra parte y del agente asignado.")
                    .font(.caption)
                    .foregroundStyle(.secondary)

                Button {
                    Task { await submit() }
                } label: {
                    Group {
                        if submitting {
                            ProgressView().tint(.white)
                        } else {
                            Label("Enviar Aplicación", systemImage: "paperplane.fill")
                                .font(.headline)
                        }
                    }
                    .frame(maxWidth: .infinity)
                    .padding()
                    .background(name.isEmpty || phone.isEmpty ? Color.gray : Color.rdGreen)
                    .foregroundStyle(.white)
                    .clipShape(RoundedRectangle(cornerRadius: 14))
                }
                .disabled(name.isEmpty || phone.isEmpty || submitting)
            }
            .padding()
        }
        .navigationTitle("Aplicar")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .cancellationAction) {
                Button("Cancelar") { dismiss() }
            }
        }
    }

    // MARK: - Success

    private var successView: some View {
        VStack(spacing: 20) {
            Spacer()
            Image(systemName: "checkmark.seal.fill")
                .font(.system(size: 70))
                .foregroundStyle(Color.rdGreen)
            Text("¡Aplicación enviada!")
                .font(.title2.weight(.heavy))
            Text("Nos pondremos en contacto contigo para coordinar los próximos pasos.")
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 32)
            Spacer()
            Button("Cerrar") { dismiss() }
                .buttonStyle(.borderedProminent)
                .tint(Color.rdGreen)
        }
        .navigationTitle("Aplicación")
        .navigationBarTitleDisplayMode(.inline)
    }

    // MARK: - Helpers

    @ViewBuilder
    private func field<F: View>(_ label: String, systemImage: String, @ViewBuilder content: () -> F) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Label(label, systemImage: systemImage)
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)
            content()
                .padding(.horizontal, 12)
                .padding(.vertical, 10)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Color(.systemGray6))
                .clipShape(RoundedRectangle(cornerRadius: 10))
        }
    }

    private func submit() async {
        submitting = true
        errorMsg   = ""
        let ok = await api.submitLead(
            listing:  listing,
            name:     name,  phone: phone, email: email,
            intent:   intent, timeline: timeline,
            budget:   budget, notes: notes
        )
        submitting = false
        if ok { submitted = true } else { errorMsg = "Error al enviar. Inténtalo de nuevo." }
    }
}
