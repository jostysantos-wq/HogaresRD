// CommissionHistoryView.swift
//
// Shows the audit trail for a single application's commission —
// every submit / adjust / reject / approve, with by-name + at +
// note + the snapshot at the time of the action. Mirrors the web's
// commission history surface available off the broker dashboard
// commission row.

import SwiftUI

struct CommissionHistoryView: View {
    let applicationId: String

    @EnvironmentObject var api: APIService

    @State private var status:   String?
    @State private var entries:  [CommissionHistoryEntry] = []
    @State private var loading:  Bool = false
    @State private var errorMsg: String?

    var body: some View {
        Group {
            if loading && entries.isEmpty {
                ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if entries.isEmpty {
                VStack(spacing: 8) {
                    Image(systemName: "clock.arrow.circlepath")
                        .font(.system(size: 36))
                        .foregroundStyle(.secondary)
                    Text("Sin historial todavía.")
                        .font(.callout)
                        .foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                List {
                    if let s = status {
                        Section {
                            HStack {
                                Text("Estado actual")
                                Spacer()
                                Text(statusLabel(s))
                                    .font(.subheadline.bold())
                                    .foregroundStyle(statusColor(s))
                            }
                        }
                    }
                    Section("Historial") {
                        ForEach(entries.sorted { $0.at > $1.at }) { e in
                            historyRow(e)
                        }
                    }
                }
                .listStyle(.insetGrouped)
            }
        }
        .navigationTitle("Historial de comisión")
        .navigationBarTitleDisplayMode(.inline)
        .task { await load() }
        .refreshable { await load() }
        .alert(errorMsg ?? "", isPresented: .constant(errorMsg != nil)) {
            Button("OK") { errorMsg = nil }
        }
    }

    @ViewBuilder
    private func historyRow(_ e: CommissionHistoryEntry) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                actionBadge(e.action)
                Text(e.byName ?? "—")
                    .font(.subheadline.bold())
                Spacer()
                Text(formatRel(e.at))
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
            if let note = e.note, !note.isEmpty {
                Text(note)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .padding(.top, 2)
            }
            if let snap = e.snapshot {
                snapshotGrid(snap)
                    .padding(.top, 4)
            }
        }
        .padding(.vertical, 4)
    }

    private func actionBadge(_ action: String) -> some View {
        let pair = actionLabel(action)
        return Text(pair.0)
            .font(.caption2.bold())
            .foregroundStyle(pair.1)
            .padding(.horizontal, 8).padding(.vertical, 2)
            .background(pair.1.opacity(0.12))
            .clipShape(Capsule())
    }

    private func actionLabel(_ action: String) -> (String, Color) {
        switch action {
        case "submitted":   return ("Registrada", Color.rdBlue)
        case "resubmitted": return ("Re-enviada", .orange)
        case "approve":     return ("Aprobada", .green)
        case "adjust":      return ("Ajustada", .orange)
        case "reject":      return ("Rechazada", .red)
        default:            return (action.capitalized, .gray)
        }
    }

    @ViewBuilder
    private func snapshotGrid(_ s: CommissionSnapshot) -> some View {
        VStack(spacing: 4) {
            if let v = s.sale_amount, v > 0 {
                snapRow("Venta", money(v))
            }
            if let p = s.agent_percent, let a = s.agent_amount {
                snapRow("Agente", "\(percent(p))% · \(money(a))")
            }
            if let p = s.inmobiliaria_percent, let a = s.inmobiliaria_amount, p > 0 || a > 0 {
                snapRow("Inmobiliaria", "\(percent(p))% · \(money(a))")
            }
            if let p = s.referral_percent, let a = s.referral_amount, p > 0 || a > 0 {
                snapRow("Referido", "\(percent(p))% · \(money(a))")
            }
            if let n = s.agent_net {
                snapRow("Neto", money(n), bold: true)
            }
        }
    }

    private func snapRow(_ label: String, _ value: String, bold: Bool = false) -> some View {
        HStack {
            Text(label).font(.caption).foregroundStyle(.secondary)
            Spacer()
            Text(value).font(bold ? .caption.bold() : .caption)
        }
    }

    private func money(_ v: Double) -> String {
        let f = NumberFormatter()
        f.numberStyle = .currency
        f.currencyCode = "USD"
        f.maximumFractionDigits = 0
        return f.string(from: NSNumber(value: v)) ?? "$\(Int(v))"
    }
    private func percent(_ v: Double) -> String {
        v.truncatingRemainder(dividingBy: 1) == 0 ? "\(Int(v))" : String(format: "%.1f", v)
    }

    private func statusLabel(_ s: String) -> String {
        switch s {
        case "pending_review": return "Pendiente de revisión"
        case "approved":       return "Aprobada"
        case "rejected":       return "Rechazada"
        case "voided":         return "Anulada"
        default: return s.capitalized
        }
    }
    private func statusColor(_ s: String) -> Color {
        switch s {
        case "approved": return .green
        case "rejected", "voided": return .red
        case "pending_review": return .orange
        default: return .gray
        }
    }

    private func formatRel(_ iso: String) -> String {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        var d = f.date(from: iso)
        if d == nil { f.formatOptions = [.withInternetDateTime]; d = f.date(from: iso) }
        guard let date = d else { return iso }
        let df = DateFormatter()
        df.dateFormat = "d MMM yyyy · HH:mm"
        df.locale = Locale(identifier: "es_DO")
        return df.string(from: date)
    }

    private func load() async {
        loading = true
        errorMsg = nil
        defer { loading = false }
        do {
            let h = try await api.getCommissionHistory(applicationId: applicationId)
            await MainActor.run {
                entries = h.history
                status  = h.status
            }
        } catch {
            await MainActor.run { errorMsg = (error as? LocalizedError)?.errorDescription ?? "No se pudo cargar." }
        }
    }
}
