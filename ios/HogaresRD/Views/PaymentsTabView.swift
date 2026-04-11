import SwiftUI
import SafariServices

// MARK: - Payments Tab (CRM — payment tracking for agents)

struct PaymentsTabView: View {
    @EnvironmentObject var api: APIService
    @State private var payments: [PaymentItem] = []
    @State private var stats: PaymentStats?
    @State private var loading = true
    @State private var selectedFilter = "all"
    @State private var sendingReminder: String? = nil
    @State private var showCreatePlan = false
    @State private var reviewingPayment: PaymentItem?
    @State private var receiptURL: PaymentReceiptURL?
    @State private var toast: String?

    private var filtered: [PaymentItem] {
        switch selectedFilter {
        case "overdue":   return payments.filter { $0.isOverdue }
        case "due_soon":  return payments.filter { $0.isDueSoon }
        case "review":    return payments.filter { $0.status == "proof_uploaded" }
        case "approved":  return payments.filter { $0.status == "approved" }
        case "pending":   return payments.filter { $0.status == "pending" }
        default:          return payments
        }
    }

    var body: some View {
        VStack(spacing: 0) {
            if loading {
                VStack(spacing: 16) {
                    Spacer()
                    ProgressView()
                    Text("Cargando pagos...")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                    Spacer()
                }
            } else {
                ScrollView {
                    VStack(spacing: 16) {
                        // Create plan button
                        Button { showCreatePlan = true } label: {
                            Label("Crear Plan de Pago", systemImage: "plus.circle.fill")
                                .font(.subheadline.bold())
                                .foregroundStyle(.white)
                                .frame(maxWidth: .infinity)
                                .padding(.vertical, 12)
                                .background(Color.rdBlue, in: RoundedRectangle(cornerRadius: 10))
                        }
                        .buttonStyle(.plain)
                        .padding(.horizontal)
                        .padding(.top, 4)

                        // Stats cards
                        if let s = stats {
                            statsSection(s)
                        }

                        // Filter chips
                        filterChips

                        // Payments list
                        if filtered.isEmpty {
                            emptyState
                        } else {
                            LazyVStack(spacing: 10) {
                                ForEach(filtered) { payment in
                                    paymentCard(payment)
                                }
                            }
                            .padding(.horizontal)
                        }
                    }
                    .padding(.bottom, 20)
                }
            }
        }
        .task { await load() }
        .refreshable { await load() }
        .sheet(isPresented: $showCreatePlan) {
            CreatePaymentPlanView()
                .environmentObject(api)
                .onDisappear { Task { await load() } }
        }
        .sheet(item: $reviewingPayment) { payment in
            NavigationStack {
                ReviewPaymentSheet(payment: payment, onReviewed: {
                    reviewingPayment = nil
                    Task { await load() }
                }, onViewReceipt: {
                    if let url = api.paymentReceiptURL(applicationId: payment.applicationId ?? "") {
                        receiptURL = PaymentReceiptURL(url: url)
                    }
                })
                .environmentObject(api)
            }
        }
        .sheet(item: $receiptURL) { wrapper in
            PaymentSafariView(url: wrapper.url)
                .ignoresSafeArea()
        }
        .overlay(alignment: .top) {
            if let t = toast {
                Text(t)
                    .font(.caption).bold()
                    .padding(.horizontal, 14).padding(.vertical, 8)
                    .background(Color.rdBlue)
                    .foregroundStyle(.white)
                    .clipShape(Capsule())
                    .padding(.top, 6)
                    .transition(.move(edge: .top).combined(with: .opacity))
            }
        }
    }

    private func load() async {
        loading = true
        do {
            let result = try await api.getPaymentsSummary()
            payments = result.payments
            stats = result.stats
        } catch {
            payments = []
            stats = nil
        }
        loading = false
    }

    // MARK: - Stats

    private func statsSection(_ s: PaymentStats) -> some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 10) {
                statCard(icon: "exclamationmark.circle.fill", label: "Vencidos", value: "\(s.overdue)", color: .rdRed)
                statCard(icon: "clock.badge.exclamationmark", label: "Por vencer", value: "\(s.dueSoon)", color: .orange)
                statCard(icon: "doc.badge.clock", label: "En revision", value: "\(s.pendingReview)", color: .rdBlue)
                statCard(icon: "checkmark.circle.fill", label: "Aprobados", value: "\(s.approvedMonth)", color: .rdGreen)
            }
            .padding(.horizontal)
        }
        .padding(.top, 8)
    }

    private func statCard(icon: String, label: String, value: String, color: Color) -> some View {
        VStack(spacing: 8) {
            HStack(spacing: 6) {
                Image(systemName: icon)
                    .font(.system(size: 14))
                    .foregroundStyle(color)
                Text(value)
                    .font(.title2.bold())
                    .foregroundStyle(color)
            }
            Text(label)
                .font(.caption.bold())
                .foregroundStyle(.secondary)
        }
        .frame(width: 100, height: 72)
        .background(color.opacity(0.08))
        .clipShape(RoundedRectangle(cornerRadius: 12))
    }

    // MARK: - Filters

    private var filterChips: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                filterChip("Todo", value: "all")
                filterChip("Vencidos", value: "overdue")
                filterChip("Por vencer", value: "due_soon")
                filterChip("En revision", value: "review")
                filterChip("Pendientes", value: "pending")
                filterChip("Aprobados", value: "approved")
            }
            .padding(.horizontal)
        }
    }

    private func filterChip(_ label: String, value: String) -> some View {
        Button {
            withAnimation(.easeInOut(duration: 0.15)) { selectedFilter = value }
        } label: {
            Text(label)
                .font(.caption.bold())
                .padding(.horizontal, 14).padding(.vertical, 7)
                .background(selectedFilter == value ? Color.rdBlue : Color(.tertiarySystemFill))
                .foregroundStyle(selectedFilter == value ? .white : .primary)
                .clipShape(Capsule())
        }
        .buttonStyle(.plain)
    }

    // MARK: - Empty State

    private var emptyState: some View {
        VStack(spacing: 12) {
            Image(systemName: "creditcard")
                .font(.system(size: 40))
                .foregroundStyle(.secondary)
            Text("Sin pagos")
                .font(.headline)
            Text("No hay pagos que coincidan con este filtro.")
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
        }
        .padding(.top, 40)
        .padding(.horizontal)
    }

    // MARK: - Payment Card

    private func paymentCard(_ p: PaymentItem) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            // Header: client + status
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    Text(p.clientName ?? "Cliente")
                        .font(.subheadline.bold())
                    if let listing = p.listingTitle, !listing.isEmpty {
                        Text(listing)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }
                }
                Spacer()
                Text(p.statusLabel)
                    .font(.system(size: 10, weight: .bold))
                    .foregroundStyle(p.statusColor)
                    .padding(.horizontal, 10).padding(.vertical, 4)
                    .background(p.statusColor.opacity(0.1))
                    .clipShape(Capsule())
            }

            Divider()

            // Payment details
            HStack {
                VStack(alignment: .leading, spacing: 4) {
                    Text(p.installmentLabel ?? "Pago")
                        .font(.caption.bold())
                        .foregroundStyle(.secondary)
                    Text(p.formattedAmount)
                        .font(.title3.bold())
                        .foregroundStyle(Color.rdBlue)
                }
                Spacer()
                VStack(alignment: .trailing, spacing: 4) {
                    Text("Vence")
                        .font(.caption.bold())
                        .foregroundStyle(.secondary)
                    if let days = p.daysUntilDue {
                        HStack(spacing: 4) {
                            if days < 0 {
                                Image(systemName: "exclamationmark.triangle.fill")
                                    .font(.system(size: 10))
                                    .foregroundStyle(Color.rdRed)
                            }
                            Text(p.formattedDueDate)
                                .font(.subheadline.bold())
                                .foregroundStyle(days < 0 ? Color.rdRed : days <= 3 ? Color.orange : Color.primary)
                        }
                        Text(days == 0 ? "Hoy" : days == 1 ? "Manana" : days < 0 ? "Hace \(abs(days))d" : "En \(days)d")
                            .font(.caption2.bold())
                            .foregroundStyle(days < 0 ? Color.rdRed : days <= 3 ? Color.orange : Color.secondary)
                    } else {
                        Text("—")
                            .font(.subheadline)
                    }
                }
            }

            // Actions
            if p.status == "pending" || p.status == "proof_uploaded" {
                HStack(spacing: 10) {
                    // Reminder button (for pending installments)
                    if p.status == "pending", p.type == "installment", let appId = p.applicationId, let instId = p.installmentId {
                        Button {
                            Task { await sendReminder(appId: appId, instId: instId, paymentId: p.id) }
                        } label: {
                            HStack(spacing: 4) {
                                if sendingReminder == p.id {
                                    ProgressView().scaleEffect(0.7)
                                } else {
                                    Image(systemName: "bell.badge")
                                        .font(.system(size: 11))
                                    Text(p.reminderSent == true ? "Reenviar" : "Recordatorio")
                                        .font(.caption.bold())
                                }
                            }
                            .foregroundStyle(.white)
                            .padding(.horizontal, 12).padding(.vertical, 7)
                            .background(Color.orange, in: Capsule())
                        }
                        .buttonStyle(.plain)
                        .disabled(sendingReminder != nil)
                    }

                    // Review button (for proof_uploaded — primary action)
                    if p.status == "proof_uploaded" {
                        Button {
                            reviewingPayment = p
                        } label: {
                            HStack(spacing: 4) {
                                Image(systemName: "checkmark.seal.fill")
                                    .font(.system(size: 11))
                                Text("Revisar Pago")
                                    .font(.caption.bold())
                            }
                            .foregroundStyle(.white)
                            .padding(.horizontal, 12).padding(.vertical, 7)
                            .background(Color.rdBlue, in: Capsule())
                        }
                        .buttonStyle(.plain)
                    }

                    // Proof indicator (only shown when NOT already offering review)
                    if p.proofUploaded == true && p.status != "proof_uploaded" {
                        Label("Comprobante subido", systemImage: "doc.fill")
                            .font(.caption2.bold())
                            .foregroundStyle(Color.rdBlue)
                            .padding(.horizontal, 10).padding(.vertical, 5)
                            .background(Color.rdBlue.opacity(0.08))
                            .clipShape(Capsule())
                    }

                    Spacer()

                    if let method = p.paymentMethod, !method.isEmpty {
                        Text(method)
                            .font(.caption2)
                            .foregroundStyle(.tertiary)
                    }
                }
            }
        }
        .padding(14)
        .background(Color(.secondarySystemGroupedBackground))
        .clipShape(RoundedRectangle(cornerRadius: 12))
    }

    // MARK: - Send Reminder

    private func sendReminder(appId: String, instId: String, paymentId: String) async {
        sendingReminder = paymentId
        do {
            try await api.sendPaymentReminder(applicationId: appId, installmentId: instId)
            // Reload to reflect updated reminder status
            await load()
        } catch {
            // Silently fail — could show alert
        }
        sendingReminder = nil
    }

    private func showToast(_ msg: String) {
        withAnimation { toast = msg }
        DispatchQueue.main.asyncAfter(deadline: .now() + 2.2) {
            withAnimation { toast = nil }
        }
    }
}

// MARK: - Identifiable URL wrapper

struct PaymentReceiptURL: Identifiable {
    let url: URL
    var id: String { url.absoluteString }
}

struct PaymentSafariView: UIViewControllerRepresentable {
    let url: URL
    func makeUIViewController(context: Context) -> SFSafariViewController {
        SFSafariViewController(url: url)
    }
    func updateUIViewController(_ controller: SFSafariViewController, context: Context) {}
}

// MARK: - Review Payment Sheet

/// Lets the broker/inmobiliaria review a client's uploaded proof. The primary
/// actions are Approve / Reject — Reject optionally requires a note.
struct ReviewPaymentSheet: View {
    @EnvironmentObject var api: APIService
    @Environment(\.dismiss) var dismiss
    let payment: PaymentItem
    let onReviewed: () -> Void
    let onViewReceipt: () -> Void

    @State private var notes = ""
    @State private var submitting = false
    @State private var showReject = false
    @State private var errorMsg: String?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                // Summary header
                VStack(alignment: .leading, spacing: 10) {
                    HStack {
                        Text(payment.clientName ?? "Cliente")
                            .font(.headline)
                        Spacer()
                        Text(payment.statusLabel)
                            .font(.caption).bold()
                            .padding(.horizontal, 10).padding(.vertical, 4)
                            .background(payment.statusColor.opacity(0.12))
                            .foregroundStyle(payment.statusColor)
                            .clipShape(Capsule())
                    }
                    if let title = payment.listingTitle {
                        Text(title)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    Divider()
                    HStack {
                        VStack(alignment: .leading, spacing: 4) {
                            Text(payment.installmentLabel ?? "Pago")
                                .font(.caption).bold()
                                .foregroundStyle(.secondary)
                            Text(payment.formattedAmount)
                                .font(.title3.bold())
                                .foregroundStyle(Color.rdBlue)
                        }
                        Spacer()
                        VStack(alignment: .trailing, spacing: 4) {
                            Text("Fecha")
                                .font(.caption).bold()
                                .foregroundStyle(.secondary)
                            Text(payment.formattedDueDate)
                                .font(.subheadline.bold())
                        }
                    }
                    if let method = payment.paymentMethod, !method.isEmpty {
                        HStack(spacing: 6) {
                            Image(systemName: "creditcard")
                                .foregroundStyle(.secondary)
                            Text("Método: \(method)")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                    }
                }
                .padding()
                .background(Color(.secondarySystemGroupedBackground))
                .clipShape(RoundedRectangle(cornerRadius: 12))
                .padding(.horizontal)

                // Receipt preview button
                Button(action: onViewReceipt) {
                    HStack {
                        Image(systemName: "doc.viewfinder")
                        Text("Ver Comprobante")
                            .font(.subheadline).bold()
                        Spacer()
                        Image(systemName: "arrow.up.right.square")
                    }
                    .padding()
                    .background(Color(.secondarySystemGroupedBackground))
                    .foregroundStyle(Color.rdBlue)
                    .clipShape(RoundedRectangle(cornerRadius: 12))
                }
                .buttonStyle(.plain)
                .padding(.horizontal)

                // Notes field (used for rejection reason)
                if showReject {
                    VStack(alignment: .leading, spacing: 6) {
                        Text("Motivo del rechazo")
                            .font(.caption).bold()
                            .foregroundStyle(.secondary)
                        TextField("Describe por qué el comprobante no es válido...", text: $notes, axis: .vertical)
                            .lineLimit(3...6)
                            .padding(10)
                            .background(Color(.secondarySystemGroupedBackground))
                            .clipShape(RoundedRectangle(cornerRadius: 10))
                    }
                    .padding(.horizontal)
                }

                if let e = errorMsg {
                    Text(e)
                        .font(.caption)
                        .foregroundStyle(.red)
                        .padding(.horizontal)
                }

                // Actions
                HStack(spacing: 10) {
                    Button {
                        if showReject {
                            showReject = false
                            notes = ""
                        } else {
                            showReject = true
                        }
                    } label: {
                        HStack {
                            Image(systemName: showReject ? "xmark.circle" : "xmark")
                            Text(showReject ? "Cancelar Rechazo" : "Rechazar")
                        }
                        .font(.subheadline).bold()
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 14)
                        .background(Color.red.opacity(0.12))
                        .foregroundStyle(.red)
                        .clipShape(RoundedRectangle(cornerRadius: 12))
                    }
                    .buttonStyle(.plain)
                    .disabled(submitting)

                    if showReject {
                        Button {
                            Task { await submit(approved: false) }
                        } label: {
                            HStack {
                                if submitting {
                                    ProgressView().tint(.white)
                                } else {
                                    Image(systemName: "paperplane.fill")
                                    Text("Confirmar Rechazo")
                                }
                            }
                            .font(.subheadline).bold()
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 14)
                            .background(Color.red)
                            .foregroundStyle(.white)
                            .clipShape(RoundedRectangle(cornerRadius: 12))
                        }
                        .buttonStyle(.plain)
                        .disabled(submitting || notes.trimmingCharacters(in: .whitespaces).isEmpty)
                    } else {
                        Button {
                            Task { await submit(approved: true) }
                        } label: {
                            HStack {
                                if submitting {
                                    ProgressView().tint(.white)
                                } else {
                                    Image(systemName: "checkmark.circle.fill")
                                    Text("Aprobar Pago")
                                }
                            }
                            .font(.subheadline).bold()
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 14)
                            .background(Color.rdGreen)
                            .foregroundStyle(.white)
                            .clipShape(RoundedRectangle(cornerRadius: 12))
                        }
                        .buttonStyle(.plain)
                        .disabled(submitting)
                    }
                }
                .padding(.horizontal)
            }
            .padding(.vertical)
        }
        .background(Color(.systemGroupedBackground))
        .navigationTitle("Revisar Pago")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .navigationBarLeading) {
                Button("Cerrar") { dismiss() }
            }
        }
    }

    private func submit(approved: Bool) async {
        guard let appId = payment.applicationId else {
            errorMsg = "ID de solicitud faltante"
            return
        }
        submitting = true
        errorMsg = nil
        do {
            if payment.type == "installment", let instId = payment.installmentId {
                try await api.reviewPaymentInstallment(
                    applicationId: appId,
                    installmentId: instId,
                    approved: approved,
                    reviewNotes: notes.trimmingCharacters(in: .whitespaces)
                )
            } else {
                try await api.verifySinglePayment(
                    applicationId: appId,
                    approved: approved,
                    notes: notes.trimmingCharacters(in: .whitespaces)
                )
            }
            onReviewed()
        } catch {
            errorMsg = error.localizedDescription
        }
        submitting = false
    }
}
