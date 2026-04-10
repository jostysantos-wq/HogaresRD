import SwiftUI

// MARK: - Create Payment Plan (Broker → Client installment schedule)

struct CreatePaymentPlanView: View {
    @EnvironmentObject var api: APIService
    @Environment(\.dismiss) var dismiss

    // Application selection
    @State private var applications: [Application] = []
    @State private var selectedAppId = ""
    @State private var loadingApps = true

    // Plan fields
    @State private var paymentMethod = "Transferencia Bancaria"
    @State private var methodDetails = ""
    @State private var currency = "DOP"
    @State private var notes = ""

    // Installments
    @State private var installments: [InstallmentRow] = [
        InstallmentRow(label: "Entrada", amount: "", dueDate: Date().addingTimeInterval(7 * 86400)),
    ]

    @State private var submitting = false
    @State private var error: String?
    @State private var showSuccess = false

    private let paymentMethods = ["Transferencia Bancaria", "Efectivo", "Cheque", "Tarjeta de Credito", "Otro"]
    private let currencies = ["DOP", "USD"]

    private var totalAmount: Double {
        installments.compactMap { Double($0.amount) }.reduce(0, +)
    }

    private var canSubmit: Bool {
        !selectedAppId.isEmpty &&
        !paymentMethod.isEmpty &&
        !installments.isEmpty &&
        installments.allSatisfy { !$0.amount.isEmpty && (Double($0.amount) ?? 0) > 0 } &&
        totalAmount > 0
    }

    var body: some View {
        NavigationStack {
            if showSuccess {
                successView
            } else {
                formView
            }
        }
    }

    // MARK: - Form

    private var formView: some View {
        ScrollView {
            VStack(spacing: 20) {

                // Application picker
                VStack(alignment: .leading, spacing: 8) {
                    Label("Aplicacion", systemImage: "doc.text.fill")
                        .font(.subheadline.bold())
                        .foregroundStyle(Color.rdBlue)

                    if loadingApps {
                        HStack {
                            ProgressView().scaleEffect(0.8)
                            Text("Cargando aplicaciones...")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                        .padding(12)
                    } else if applications.isEmpty {
                        HStack(spacing: 8) {
                            Image(systemName: "exclamationmark.circle")
                                .foregroundStyle(.orange)
                            Text("No hay aplicaciones en estado 'pendiente de pago'.")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                        .padding(12)
                        .background(Color.orange.opacity(0.08))
                        .clipShape(RoundedRectangle(cornerRadius: 10))
                    } else {
                        Picker("Seleccionar aplicacion", selection: $selectedAppId) {
                            Text("Seleccionar...").tag("")
                            ForEach(applications) { app in
                                VStack(alignment: .leading) {
                                    Text(app.listingTitle)
                                        .font(.subheadline)
                                }
                                .tag(app.id)
                            }
                        }
                        .pickerStyle(.menu)
                        .padding(12)
                        .background(Color(.secondarySystemGroupedBackground))
                        .clipShape(RoundedRectangle(cornerRadius: 10))
                    }
                }

                // Selected app info
                if let app = applications.first(where: { $0.id == selectedAppId }) {
                    HStack(spacing: 12) {
                        Image(systemName: "person.fill")
                            .foregroundStyle(Color.rdBlue)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(app.listingTitle)
                                .font(.subheadline.bold())
                                .lineLimit(1)
                            Text("Cliente aplicando")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                        Spacer()
                        if let price = app.priceValue, price > 0 {
                            Text("$\(Int(price).formatted())")
                                .font(.subheadline.bold())
                                .foregroundStyle(Color.rdBlue)
                        }
                    }
                    .padding(12)
                    .background(Color.rdBlue.opacity(0.06))
                    .clipShape(RoundedRectangle(cornerRadius: 10))
                }

                Divider()

                // Payment method
                VStack(alignment: .leading, spacing: 8) {
                    Label("Metodo de Pago", systemImage: "creditcard.fill")
                        .font(.subheadline.bold())
                        .foregroundStyle(Color.rdBlue)

                    Picker("Metodo", selection: $paymentMethod) {
                        ForEach(paymentMethods, id: \.self) { Text($0).tag($0) }
                    }
                    .pickerStyle(.menu)
                    .padding(12)
                    .background(Color(.secondarySystemGroupedBackground))
                    .clipShape(RoundedRectangle(cornerRadius: 10))

                    TextField("Detalles (cuenta, banco, etc.)", text: $methodDetails)
                        .font(.subheadline)
                        .padding(12)
                        .background(Color(.secondarySystemGroupedBackground))
                        .clipShape(RoundedRectangle(cornerRadius: 10))
                }

                // Currency
                HStack {
                    Label("Moneda", systemImage: "dollarsign.circle")
                        .font(.subheadline.bold())
                        .foregroundStyle(Color.rdBlue)
                    Spacer()
                    Picker("", selection: $currency) {
                        ForEach(currencies, id: \.self) { Text($0).tag($0) }
                    }
                    .pickerStyle(.segmented)
                    .frame(width: 150)
                }

                Divider()

                // Installments
                VStack(alignment: .leading, spacing: 12) {
                    HStack {
                        Label("Cuotas", systemImage: "list.number")
                            .font(.subheadline.bold())
                            .foregroundStyle(Color.rdBlue)
                        Spacer()
                        Text("\(installments.count) cuota\(installments.count == 1 ? "" : "s")")
                            .font(.caption.bold())
                            .foregroundStyle(.secondary)
                    }

                    ForEach(Array(installments.enumerated()), id: \.element.id) { index, inst in
                        installmentRow(index: index, inst: inst)
                    }

                    if installments.count < 24 {
                        Button {
                            let nextDate = (installments.last?.dueDate ?? Date()).addingTimeInterval(30 * 86400)
                            installments.append(InstallmentRow(
                                label: "Cuota \(installments.count + 1)",
                                amount: installments.last?.amount ?? "",
                                dueDate: nextDate
                            ))
                        } label: {
                            Label("Agregar cuota", systemImage: "plus.circle.fill")
                                .font(.subheadline.bold())
                                .foregroundStyle(Color.rdBlue)
                                .frame(maxWidth: .infinity)
                                .padding(12)
                                .background(Color.rdBlue.opacity(0.06))
                                .clipShape(RoundedRectangle(cornerRadius: 10))
                        }
                        .buttonStyle(.plain)
                    }

                    // Total
                    HStack {
                        Text("Total")
                            .font(.headline)
                        Spacer()
                        Text("\(currency) $\(totalAmount.formatted(.number.grouping(.automatic)))")
                            .font(.title3.bold())
                            .foregroundStyle(Color.rdBlue)
                    }
                    .padding(14)
                    .background(Color.rdBlue.opacity(0.06))
                    .clipShape(RoundedRectangle(cornerRadius: 10))
                }

                // Notes
                VStack(alignment: .leading, spacing: 6) {
                    Text("Notas (opcional)")
                        .font(.caption.bold())
                        .foregroundStyle(.secondary)
                    TextField("Instrucciones adicionales...", text: $notes, axis: .vertical)
                        .lineLimit(3...5)
                        .font(.subheadline)
                        .padding(12)
                        .background(Color(.secondarySystemGroupedBackground))
                        .clipShape(RoundedRectangle(cornerRadius: 10))
                }

                // Error
                if let err = error {
                    HStack {
                        Image(systemName: "exclamationmark.circle.fill")
                            .foregroundStyle(Color.rdRed)
                        Text(err)
                            .font(.caption)
                            .foregroundStyle(Color.rdRed)
                    }
                }

                // Submit
                Button {
                    Task { await submit() }
                } label: {
                    HStack {
                        if submitting { ProgressView().tint(.white) }
                        Text("Crear Plan de Pago")
                            .font(.subheadline.bold())
                    }
                    .foregroundStyle(.white)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 14)
                    .background(canSubmit ? Color.rdBlue : Color.gray, in: RoundedRectangle(cornerRadius: 12))
                }
                .buttonStyle(.plain)
                .disabled(!canSubmit || submitting)

                Spacer().frame(height: 20)
            }
            .padding(.horizontal)
            .padding(.top, 12)
        }
        .navigationTitle("Crear Plan de Pago")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .cancellationAction) {
                Button("Cancelar") { dismiss() }
            }
        }
        .task { await loadApplications() }
    }

    // MARK: - Installment Row

    private func installmentRow(index: Int, inst: InstallmentRow) -> some View {
        VStack(spacing: 8) {
            HStack {
                Text("#\(index + 1)")
                    .font(.caption.bold())
                    .foregroundStyle(.white)
                    .frame(width: 24, height: 24)
                    .background(Color.rdBlue, in: Circle())

                TextField("Etiqueta", text: $installments[index].label)
                    .font(.subheadline.bold())

                Spacer()

                if installments.count > 1 {
                    Button {
                        installments.remove(at: index)
                    } label: {
                        Image(systemName: "trash")
                            .font(.caption)
                            .foregroundStyle(Color.rdRed)
                    }
                    .buttonStyle(.plain)
                }
            }

            HStack(spacing: 10) {
                HStack {
                    Text(currency)
                        .font(.caption.bold())
                        .foregroundStyle(.secondary)
                    TextField("Monto", text: $installments[index].amount)
                        .keyboardType(.decimalPad)
                        .font(.subheadline)
                }
                .padding(10)
                .background(Color(.secondarySystemGroupedBackground))
                .clipShape(RoundedRectangle(cornerRadius: 8))

                DatePicker("", selection: $installments[index].dueDate, displayedComponents: .date)
                    .labelsHidden()
                    .datePickerStyle(.compact)
            }
        }
        .padding(12)
        .background(Color(.secondarySystemGroupedBackground))
        .clipShape(RoundedRectangle(cornerRadius: 10))
    }

    // MARK: - Success

    private var successView: some View {
        VStack(spacing: 24) {
            Spacer()
            Image(systemName: "checkmark.circle.fill")
                .font(.system(size: 56))
                .foregroundStyle(Color.rdGreen)
            Text("Plan de Pago Creado")
                .font(.title2.bold())
            Text("El cliente recibira un correo con los detalles del plan y las fechas de cada cuota.")
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal)
            Button {
                dismiss()
            } label: {
                Text("Cerrar")
                    .font(.subheadline.bold())
                    .foregroundStyle(.white)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 14)
                    .background(Color.rdBlue, in: RoundedRectangle(cornerRadius: 12))
            }
            .buttonStyle(.plain)
            .padding(.horizontal)
            Spacer()
        }
        .navigationTitle("Plan Creado")
    }

    // MARK: - API

    private func loadApplications() async {
        loadingApps = true
        do {
            applications = try await api.getApplicationsForPaymentPlan()
        } catch {
            applications = []
        }
        loadingApps = false
    }

    private func submit() async {
        guard canSubmit else { return }
        submitting = true
        error = nil

        let fmt = ISO8601DateFormatter()
        fmt.formatOptions = [.withInternetDateTime]

        let installmentData: [[String: Any]] = installments.map { inst in
            var d: [String: Any] = [
                "label": inst.label,
                "amount": Double(inst.amount) ?? 0,
            ]
            d["due_date"] = fmt.string(from: inst.dueDate)
            return d
        }

        let body: [String: Any] = [
            "payment_method": paymentMethod,
            "method_details": methodDetails,
            "currency": currency,
            "total_amount": totalAmount,
            "notes": notes,
            "installments": installmentData,
        ]

        do {
            try await api.createPaymentPlan(applicationId: selectedAppId, plan: body)
            withAnimation { showSuccess = true }
        } catch let e {
            self.error = e.localizedDescription
        }
        submitting = false
    }
}

// MARK: - Installment Row Model

struct InstallmentRow: Identifiable {
    let id = UUID()
    var label: String
    var amount: String
    var dueDate: Date
}
