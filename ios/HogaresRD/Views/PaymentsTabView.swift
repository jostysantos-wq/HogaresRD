import SwiftUI

// MARK: - Payments Tab (CRM — payment tracking for agents)

struct PaymentsTabView: View {
    @EnvironmentObject var api: APIService
    @State private var payments: [PaymentItem] = []
    @State private var stats: PaymentStats?
    @State private var loading = true
    @State private var selectedFilter = "all"
    @State private var sendingReminder: String? = nil

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

                    // Proof indicator
                    if p.proofUploaded == true {
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
}
