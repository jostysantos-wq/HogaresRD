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

    // Inline validation messages per installment row
    private func validationMessage(for inst: InstallmentRow) -> String? {
        if inst.amount.isEmpty { return "Indica un monto." }
        guard let value = Double(inst.amount), value > 0 else {
            return "Monto debe ser mayor a 0."
        }
        return nil
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
            VStack(spacing: Spacing.s16) {
                applicationCard
                if let app = applications.first(where: { $0.id == selectedAppId }) {
                    selectedAppCard(app: app)
                }
                paymentMethodCard
                installmentsCard
                notesCard

                if let err = error {
                    HStack(spacing: 6) {
                        Image(systemName: "exclamationmark.circle.fill")
                            .foregroundStyle(Color.rdRed)
                        Text(err)
                            .font(.caption)
                            .foregroundStyle(Color.rdRed)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, Spacing.s4)
                }
            }
            .padding(.horizontal)
            .padding(.top, Spacing.s12)
        }
        .background(Color.rdBg.ignoresSafeArea())
        .navigationTitle("Crear plan de pago")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .cancellationAction) {
                Button("Cancelar") { dismiss() }
            }
        }
        .task { await loadApplications() }
        .bottomCTA(title: "Crear plan", isLoading: submitting) {
            Task { await submit() }
        }
    }

    // MARK: - Sections

    private var applicationCard: some View {
        FormCard("Aplicación") {
            if loadingApps {
                HStack(spacing: 8) {
                    ProgressView().scaleEffect(0.8)
                    Text("Cargando aplicaciones...")
                        .font(.caption)
                        .foregroundStyle(Color.rdInkSoft)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.vertical, Spacing.s8)
            } else if applications.isEmpty {
                HStack(spacing: 8) {
                    Image(systemName: "exclamationmark.circle")
                        .foregroundStyle(Color.rdOrange)
                    Text("No hay aplicaciones en estado 'pendiente de pago'.")
                        .font(.caption)
                        .foregroundStyle(Color.rdInkSoft)
                }
                .padding(.vertical, Spacing.s8)
            } else {
                LabeledRow("Seleccionar") {
                    Picker("", selection: $selectedAppId) {
                        Text("Seleccionar...").tag("")
                        ForEach(applications) { app in
                            Text(app.listingTitle).tag(app.id)
                        }
                    }
                    .pickerStyle(.menu)
                    .tint(Color.rdInk)
                }
            }
        }
    }

    private func selectedAppCard(app: Application) -> some View {
        FormCard {
            HStack(spacing: Spacing.s12) {
                Image(systemName: "person.fill")
                    .foregroundStyle(Color.rdInk)
                VStack(alignment: .leading, spacing: 2) {
                    Text(app.listingTitle)
                        .font(.subheadline.bold())
                        .foregroundStyle(Color.rdInk)
                        .lineLimit(1)
                    Text("Cliente aplicando")
                        .font(.caption)
                        .foregroundStyle(Color.rdInkSoft)
                }
                Spacer()
                if let price = app.priceValue, price > 0 {
                    Text("$\(Int(price).formatted())")
                        .font(.subheadline.bold())
                        .foregroundStyle(Color.rdInk)
                }
            }
            .padding(.vertical, Spacing.s8)
        }
    }

    private var paymentMethodCard: some View {
        FormCard("Método de pago") {
            LabeledRow("Método") {
                Picker("", selection: $paymentMethod) {
                    ForEach(paymentMethods, id: \.self) { Text($0).tag($0) }
                }
                .pickerStyle(.menu)
                .tint(Color.rdInk)
            }
            LabeledRow("Detalles") {
                TextField("Cuenta, banco, etc.", text: $methodDetails)
                    .multilineTextAlignment(.trailing)
                    .font(.body)
                    .foregroundStyle(Color.rdInk)
            }
            LabeledRow("Moneda") {
                Picker("", selection: $currency) {
                    ForEach(currencies, id: \.self) { Text($0).tag($0) }
                }
                .pickerStyle(.segmented)
                .frame(width: 140)
            }
        }
    }

    private var installmentsCard: some View {
        FormCard("Cuotas (\(installments.count))") {
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
                        .foregroundStyle(Color.rdInk)
                        .frame(maxWidth: .infinity, minHeight: 44)
                        .padding(.vertical, Spacing.s4)
                        .background(Color.rdSurfaceMuted)
                        .clipShape(RoundedRectangle(cornerRadius: Radius.medium))
                }
                .buttonStyle(.plain)
            }

            HStack {
                Text("Total")
                    .font(.headline)
                    .foregroundStyle(Color.rdInk)
                Spacer()
                Text("\(currency) $\(totalAmount.formatted(.number.grouping(.automatic)))")
                    .font(.title3.bold())
                    .foregroundStyle(Color.rdInk)
                    .monospacedDigit()
            }
            .padding(.vertical, Spacing.s8)
        }
    }

    private var notesCard: some View {
        FormCard("Notas (opcional)") {
            TextField("Instrucciones adicionales...", text: $notes, axis: .vertical)
                .lineLimit(3...5)
                .font(.body)
                .foregroundStyle(Color.rdInk)
                .padding(.vertical, Spacing.s8)
        }
    }

    // MARK: - Installment Row

    private func installmentRow(index: Int, inst: InstallmentRow) -> some View {
        VStack(alignment: .leading, spacing: Spacing.s8) {
            HStack {
                Text("#\(index + 1)")
                    .font(.caption.bold())
                    .foregroundStyle(.white)
                    .frame(width: 24, height: 24)
                    .background(Color.rdInk, in: Circle())

                TextField("Etiqueta", text: $installments[index].label)
                    .font(.subheadline.bold())
                    .foregroundStyle(Color.rdInk)

                Spacer()

                if installments.count > 1 {
                    Button {
                        installments.remove(at: index)
                    } label: {
                        Image(systemName: "trash")
                            .font(.body)
                            .foregroundStyle(Color.rdRed)
                            .frame(width: 44, height: 44)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Eliminar cuota \(index + 1)")
                }
            }

            HStack(spacing: 10) {
                HStack {
                    Text(currency)
                        .font(.caption.bold())
                        .foregroundStyle(Color.rdInkSoft)
                    TextField("Monto", text: $installments[index].amount)
                        .keyboardType(.decimalPad)
                        .font(.body)
                        .foregroundStyle(Color.rdInk)
                }
                .padding(10)
                .background(Color.rdSurfaceMuted)
                .clipShape(RoundedRectangle(cornerRadius: Radius.small))

                DatePicker("", selection: $installments[index].dueDate, displayedComponents: .date)
                    .labelsHidden()
                    .datePickerStyle(.compact)
                    .tint(Color.rdInk)
            }

            if let msg = validationMessage(for: inst) {
                Text(msg)
                    .font(.caption)
                    .foregroundStyle(Color.rdRed.opacity(0.85))
            }
        }
        .padding(.vertical, Spacing.s8)
    }

    // MARK: - Success

    private var successView: some View {
        VStack(spacing: Spacing.s24) {
            Spacer()
            Image(systemName: "checkmark.circle.fill")
                .font(.system(size: 56))
                .foregroundStyle(Color.rdGreen)
            Text("Plan de pago creado")
                .font(.title2.bold())
                .foregroundStyle(Color.rdInk)
            Text("El cliente recibirá un correo con los detalles del plan y las fechas de cada cuota.")
                .font(.subheadline)
                .foregroundStyle(Color.rdInkSoft)
                .multilineTextAlignment(.center)
                .padding(.horizontal)
            PrimaryButton(title: "Cerrar") { dismiss() }
                .padding(.horizontal)
            Spacer()
        }
        .background(Color.rdBg.ignoresSafeArea())
        .navigationTitle("Plan creado")
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
