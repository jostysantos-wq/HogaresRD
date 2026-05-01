import SwiftUI
import SafariServices
import UIKit

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

    // Toast (design-system)
    @State private var toastStyle: ToastBanner.Style?
    @State private var showToast = false

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
                VStack(spacing: Spacing.s16) {
                    Spacer()
                    ProgressView()
                    Text("Cargando pagos...")
                        .font(.subheadline)
                        .foregroundStyle(Color.rdInkSoft)
                    Spacer()
                }
            } else {
                ScrollView {
                    VStack(spacing: Spacing.s16) {
                        // Create plan button
                        Button { showCreatePlan = true } label: {
                            Label("Crear plan de pago", systemImage: "plus.circle.fill")
                                .font(.subheadline.bold())
                                .foregroundStyle(.white)
                                .frame(maxWidth: .infinity, minHeight: 44)
                                .padding(.vertical, Spacing.s4)
                                .background(Color.rdInk, in: RoundedRectangle(cornerRadius: Radius.medium))
                        }
                        .buttonStyle(.plain)
                        .padding(.horizontal)
                        .padding(.top, 4)
                        .accessibilityLabel("Crear plan de pago")

                        // Stats cards
                        if let s = stats {
                            statsSection(s)
                        }

                        // Filter chips
                        filterChips

                        // Payments list
                        if filtered.isEmpty {
                            EmptyStateView.calm(
                                systemImage: "creditcard",
                                title: "Sin pagos",
                                description: "No hay pagos que coincidan con este filtro."
                            )
                            .padding(.top, Spacing.s24)
                        } else {
                            LazyVStack(spacing: 10) {
                                ForEach(filtered) { payment in
                                    paymentCard(payment)
                                }
                            }
                            .padding(.horizontal)
                        }
                    }
                    .padding(.bottom, Spacing.s24)
                }
            }
        }
        .background(Color.rdBg.ignoresSafeArea())
        .task { await load() }
        .refreshable { await load() }
        .onReceive(NotificationCenter.default.publisher(for: .pushNotificationReceived)) { _ in
            // Refresh stats when a payment-related push arrives so the
            // counters reflect new state (proof uploaded, plan created,
            // installment approved/rejected) without manual pull.
            Task { await load() }
        }
        .sheet(isPresented: $showCreatePlan) {
            CreatePaymentPlanView()
                .environmentObject(api)
                .presentationDragIndicator(.visible)
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
            .presentationDetents([.medium, .large])
            .presentationDragIndicator(.visible)
        }
        .sheet(item: $receiptURL) { wrapper in
            PaymentSafariView(url: wrapper.url)
                .ignoresSafeArea()
        }
        .toast(toastStyle, isPresented: $showToast)
    }

    private func load() async {
        if payments.isEmpty { loading = true }
        do {
            let result = try await api.getPaymentsSummary()
            payments = result.payments
            stats = result.stats
        } catch is CancellationError {
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
                statCard(icon: "clock.badge.exclamationmark", label: "Por vencer", value: "\(s.dueSoon)", color: .rdOrange)
                statCard(icon: "doc.badge.clock", label: "En revisión", value: "\(s.pendingReview)", color: .rdBlue)
                statCard(icon: "checkmark.circle.fill", label: "Aprobados", value: "\(s.approvedMonth)", color: .rdGreen)
            }
            .padding(.horizontal)
        }
        .padding(.top, Spacing.s8)
    }

    /// Text-driven stat tile that grows with Dynamic Type rather than the
    /// previous hardcoded 100×72. Visually similar to a `DSPill` block —
    /// keeps the icon + value on top and the label below.
    private func statCard(icon: String, label: String, value: String, color: Color) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 6) {
                Image(systemName: icon)
                    .font(.subheadline)
                    .foregroundStyle(color)
                Text(value)
                    .font(.title2.bold())
                    .foregroundStyle(color)
                    .monospacedDigit()
            }
            Text(label)
                .font(.caption.bold())
                .foregroundStyle(Color.rdInkSoft)
        }
        .padding(.horizontal, Spacing.s12)
        .padding(.vertical, Spacing.s8)
        .background(color.opacity(0.10))
        .clipShape(RoundedRectangle(cornerRadius: Radius.medium))
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(label) \(value)")
    }

    // MARK: - Filters

    private var filterChips: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                filterChip("Todo", value: "all")
                filterChip("Vencidos", value: "overdue")
                filterChip("Por vencer", value: "due_soon")
                filterChip("En revisión", value: "review")
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
                .background(selectedFilter == value ? Color.rdInk : Color.rdSurfaceMuted)
                .foregroundStyle(selectedFilter == value ? Color.white : Color.rdInk)
                .clipShape(Capsule())
        }
        .buttonStyle(.plain)
    }

    // MARK: - Payment Card

    private func paymentCard(_ p: PaymentItem) -> some View {
        Group {
            if p.status == "approved" {
                approvedCollapsed(p)
            } else {
                paymentCardFull(p)
            }
        }
    }

    /// Collapsed one-liner shown for already-approved installments. The
    /// disclosure group exposes the original detail block as a "revision
    /// history" timeline.
    private func approvedCollapsed(_ p: PaymentItem) -> some View {
        DisclosureGroup {
            VStack(alignment: .leading, spacing: 8) {
                HStack {
                    Text(p.installmentLabel ?? "Pago")
                        .font(.caption.bold())
                        .foregroundStyle(Color.rdInkSoft)
                    Spacer()
                    Text(p.formattedAmount)
                        .font(.subheadline.bold())
                        .foregroundStyle(Color.rdInk)
                }
                HStack {
                    Text("Vence")
                        .font(.caption)
                        .foregroundStyle(Color.rdInkSoft)
                    Spacer()
                    Text(p.formattedDueDate)
                        .font(.caption.bold())
                        .foregroundStyle(Color.rdInk)
                }
                if let method = p.paymentMethod, !method.isEmpty {
                    HStack {
                        Text("Método")
                            .font(.caption)
                            .foregroundStyle(Color.rdInkSoft)
                        Spacer()
                        Text(method)
                            .font(.caption.bold())
                            .foregroundStyle(Color.rdInk)
                    }
                }
            }
            .padding(.top, Spacing.s8)
        } label: {
            HStack(spacing: Spacing.s8) {
                StatusDot(tint: .rdGreen)
                Text(p.clientName ?? "Cliente")
                    .font(.subheadline.bold())
                    .foregroundStyle(Color.rdInk)
                    .lineLimit(1)
                Spacer()
                Text(p.formattedAmount)
                    .font(.subheadline.bold())
                    .foregroundStyle(Color.rdGreen)
                    .monospacedDigit()
            }
        }
        .tint(Color.rdInk)
        .padding(Spacing.s12)
        .background(Color.rdSurface)
        .clipShape(RoundedRectangle(cornerRadius: Radius.medium))
    }

    private func paymentCardFull(_ p: PaymentItem) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            // Header: client + status
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    Text(p.clientName ?? "Cliente")
                        .font(.subheadline.bold())
                        .foregroundStyle(Color.rdInk)
                    if let listing = p.listingTitle, !listing.isEmpty {
                        Text(listing)
                            .font(.caption)
                            .foregroundStyle(Color.rdInkSoft)
                            .lineLimit(1)
                    }
                }
                Spacer()
                Text(p.statusLabel)
                    .font(.caption2.weight(.bold))
                    .foregroundStyle(p.statusColor)
                    .padding(.horizontal, 10).padding(.vertical, 4)
                    .background(p.statusColor.opacity(0.1))
                    .clipShape(Capsule())
            }

            Divider().opacity(0.4)

            // Payment details
            HStack {
                VStack(alignment: .leading, spacing: 4) {
                    Text(p.installmentLabel ?? "Pago")
                        .font(.caption.bold())
                        .foregroundStyle(Color.rdInkSoft)
                    Text(p.formattedAmount)
                        .font(.title3.bold())
                        .foregroundStyle(Color.rdInk)
                        .monospacedDigit()
                }
                Spacer()
                VStack(alignment: .trailing, spacing: 4) {
                    Text("Vence")
                        .font(.caption.bold())
                        .foregroundStyle(Color.rdInkSoft)
                    if let days = p.daysUntilDue {
                        HStack(spacing: 4) {
                            if days < 0 {
                                Image(systemName: "exclamationmark.triangle.fill")
                                    .font(.caption2)
                                    .foregroundStyle(Color.rdRed)
                            }
                            Text(p.formattedDueDate)
                                .font(.subheadline.bold())
                                .foregroundStyle(days < 0 ? Color.rdRed : days <= 3 ? Color.rdOrange : Color.rdInk)
                        }
                        Text(days == 0 ? "Hoy" : days == 1 ? "Mañana" : days < 0 ? "Hace \(abs(days))d" : "En \(days)d")
                            .font(.caption2.bold())
                            .foregroundStyle(days < 0 ? Color.rdRed : days <= 3 ? Color.rdOrange : Color.rdInkSoft)
                    } else {
                        Text("—")
                            .font(.subheadline)
                            .foregroundStyle(Color.rdInkSoft)
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
                                        .font(.caption)
                                    Text(p.reminderSent == true ? "Reenviar" : "Recordatorio")
                                        .font(.caption.bold())
                                }
                            }
                            .foregroundStyle(.white)
                            .padding(.horizontal, 12).padding(.vertical, 7)
                            .frame(minHeight: 36)
                            .background(Color.rdOrange, in: Capsule())
                        }
                        .buttonStyle(.plain)
                        .disabled(sendingReminder != nil)
                        .accessibilityLabel("Enviar recordatorio de pago")
                    }

                    // Review button (for proof_uploaded — primary action)
                    if p.status == "proof_uploaded" {
                        Button {
                            reviewingPayment = p
                        } label: {
                            HStack(spacing: 4) {
                                Image(systemName: "checkmark.seal.fill")
                                    .font(.caption)
                                Text("Revisar pago")
                                    .font(.caption.bold())
                            }
                            .foregroundStyle(.white)
                            .padding(.horizontal, 12).padding(.vertical, 7)
                            .frame(minHeight: 36)
                            .background(Color.rdInk, in: Capsule())
                        }
                        .buttonStyle(.plain)
                    }

                    // Proof indicator (only shown when NOT already offering review)
                    if p.proofUploaded == true && p.status != "proof_uploaded" {
                        Label("Comprobante subido", systemImage: "doc.fill")
                            .font(.caption2.bold())
                            .foregroundStyle(Color.rdInk)
                            .padding(.horizontal, 10).padding(.vertical, 5)
                            .background(Color.rdSurfaceMuted)
                            .clipShape(Capsule())
                    }

                    Spacer()

                    if let method = p.paymentMethod, !method.isEmpty {
                        Text(method)
                            .font(.caption2)
                            .foregroundStyle(Color.rdInkSoft)
                    }
                }
            }
        }
        .padding(Spacing.s12)
        .background(Color.rdSurface)
        .clipShape(RoundedRectangle(cornerRadius: Radius.medium))
    }

    // MARK: - Send Reminder

    private func sendReminder(appId: String, instId: String, paymentId: String) async {
        sendingReminder = paymentId
        do {
            try await api.sendPaymentReminder(applicationId: appId, installmentId: instId)
            // Reload to reflect updated reminder status
            await load()
            await MainActor.run { showToastBanner(.success("Recordatorio enviado")) }
        } catch {
            await MainActor.run { showToastBanner(.error("No se pudo enviar el recordatorio")) }
        }
        sendingReminder = nil
    }

    private func showToastBanner(_ style: ToastBanner.Style) {
        toastStyle = style
        withAnimation { showToast = true }
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

// MARK: - Camera-first image picker (Pattern 11)
//
// Wraps `UIImagePickerController` so the broker/client receipt-upload
// flow can open straight to the camera. A secondary "Elegir de la
// galería" button is exposed via the `sourceType` parameter so callers
// can offer both entry points without re-implementing the bridge.

struct CameraImagePicker: UIViewControllerRepresentable {
    @Environment(\.dismiss) private var dismiss
    var sourceType: UIImagePickerController.SourceType = .camera
    var onPick: (UIImage) -> Void

    func makeUIViewController(context: Context) -> UIImagePickerController {
        let picker = UIImagePickerController()
        if UIImagePickerController.isSourceTypeAvailable(sourceType) {
            picker.sourceType = sourceType
        } else {
            picker.sourceType = .photoLibrary
        }
        picker.delegate = context.coordinator
        return picker
    }

    func updateUIViewController(_ uiViewController: UIImagePickerController, context: Context) {}

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    final class Coordinator: NSObject, UIImagePickerControllerDelegate, UINavigationControllerDelegate {
        let parent: CameraImagePicker
        init(_ parent: CameraImagePicker) { self.parent = parent }

        func imagePickerController(_ picker: UIImagePickerController,
                                   didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]) {
            if let img = info[.originalImage] as? UIImage {
                parent.onPick(img)
            }
            parent.dismiss()
        }

        func imagePickerControllerDidCancel(_ picker: UIImagePickerController) {
            parent.dismiss()
        }
    }
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
            VStack(alignment: .leading, spacing: Spacing.s16) {
                // Summary header
                FormCard {
                    VStack(alignment: .leading, spacing: 10) {
                        HStack {
                            Text(payment.clientName ?? "Cliente")
                                .font(.headline)
                                .foregroundStyle(Color.rdInk)
                            Spacer()
                            Text(payment.statusLabel)
                                .font(.caption.bold())
                                .padding(.horizontal, 10).padding(.vertical, 4)
                                .background(payment.statusColor.opacity(0.12))
                                .foregroundStyle(payment.statusColor)
                                .clipShape(Capsule())
                        }
                        if let title = payment.listingTitle {
                            Text(title)
                                .font(.caption)
                                .foregroundStyle(Color.rdInkSoft)
                        }
                        Divider().opacity(0.4)
                        HStack {
                            VStack(alignment: .leading, spacing: 4) {
                                Text(payment.installmentLabel ?? "Pago")
                                    .font(.caption.bold())
                                    .foregroundStyle(Color.rdInkSoft)
                                Text(payment.formattedAmount)
                                    .font(.title3.bold())
                                    .foregroundStyle(Color.rdInk)
                                    .monospacedDigit()
                            }
                            Spacer()
                            VStack(alignment: .trailing, spacing: 4) {
                                Text("Fecha")
                                    .font(.caption.bold())
                                    .foregroundStyle(Color.rdInkSoft)
                                Text(payment.formattedDueDate)
                                    .font(.subheadline.bold())
                                    .foregroundStyle(Color.rdInk)
                            }
                        }
                        if let method = payment.paymentMethod, !method.isEmpty {
                            HStack(spacing: 6) {
                                Image(systemName: "creditcard")
                                    .foregroundStyle(Color.rdInkSoft)
                                Text("Método: \(method)")
                                    .font(.caption)
                                    .foregroundStyle(Color.rdInkSoft)
                            }
                        }
                    }
                    .padding(.vertical, Spacing.s4)
                }
                .padding(.horizontal)

                // Receipt preview button
                Button(action: onViewReceipt) {
                    HStack {
                        Image(systemName: "doc.viewfinder")
                        Text("Ver comprobante")
                            .font(.subheadline.bold())
                        Spacer()
                        Image(systemName: "arrow.up.right.square")
                    }
                    .frame(minHeight: 44)
                    .padding()
                    .background(Color.rdSurface)
                    .foregroundStyle(Color.rdInk)
                    .clipShape(RoundedRectangle(cornerRadius: Radius.medium))
                }
                .buttonStyle(.plain)
                .padding(.horizontal)
                .accessibilityLabel("Ver comprobante de pago")

                // Notes field (used for rejection reason)
                if showReject {
                    VStack(alignment: .leading, spacing: 6) {
                        Text("Motivo del rechazo")
                            .font(.caption.bold())
                            .foregroundStyle(Color.rdInkSoft)
                        TextField("Describe por qué el comprobante no es válido...", text: $notes, axis: .vertical)
                            .lineLimit(3...6)
                            .padding(10)
                            .background(Color.rdSurfaceMuted)
                            .clipShape(RoundedRectangle(cornerRadius: Radius.medium))
                        if showReject && notes.trimmingCharacters(in: .whitespaces).isEmpty {
                            Text("Indica un motivo para rechazar el comprobante.")
                                .font(.caption)
                                .foregroundStyle(Color.rdRed.opacity(0.85))
                        }
                    }
                    .padding(.horizontal)
                }

                if let e = errorMsg {
                    Text(e)
                        .font(.caption)
                        .foregroundStyle(Color.rdRed)
                        .padding(.horizontal)
                }

                // Reject toggle button
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
                        Text(showReject ? "Cancelar rechazo" : "Rechazar")
                    }
                    .font(.subheadline.bold())
                    .frame(maxWidth: .infinity, minHeight: 44)
                    .padding(.vertical, Spacing.s4)
                    .background(Color.rdRed.opacity(0.12))
                    .foregroundStyle(Color.rdRed)
                    .clipShape(RoundedRectangle(cornerRadius: Radius.medium))
                }
                .buttonStyle(.plain)
                .disabled(submitting)
                .padding(.horizontal)
            }
            .padding(.vertical)
        }
        .background(Color.rdBg.ignoresSafeArea())
        .navigationTitle("Revisar pago")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .navigationBarLeading) {
                Button("Cerrar") { dismiss() }
            }
        }
        .bottomCTA(
            title: showReject ? "Confirmar rechazo" : "Aprobar pago",
            isLoading: submitting,
            action: { Task { await submit(approved: !showReject) } }
        )
    }

    private func submit(approved: Bool) async {
        guard let appId = payment.applicationId else {
            errorMsg = "ID de solicitud faltante"
            return
        }
        if !approved && notes.trimmingCharacters(in: .whitespaces).isEmpty {
            errorMsg = "Indica un motivo para rechazar el comprobante."
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

