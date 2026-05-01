import SwiftUI

// MARK: - DSStatusBadge
//
// Tinted-background badge used for status pills (Aprobado, Pendiente,
// En revisión, etc). Visual: tiny caps weight on a 12% tint of the
// caller-supplied color, rounded 4pt. Replaces ~10 ad-hoc pill
// components scattered across the app.
//
// Named with a `DS` prefix to coexist with legacy `StatusBadge`
// declarations in `Views/BrokerDashboardView.swift` and similar.
// Sibling refactors (8-B/8-C/8-D/8-E/8-F) should swap the local
// duplicates for `DSStatusBadge`, then drop the prefix in a final
// follow-up once the duplicate types are gone.

struct DSStatusBadge: View {
    let label: String
    let tint: Color

    init(label: String, tint: Color) {
        self.label = label
        self.tint = tint
    }

    var body: some View {
        Text(label)
            .font(.caption2.weight(.semibold))
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(
                RoundedRectangle(cornerRadius: 4)
                    .fill(tint.opacity(0.12))
            )
            .foregroundStyle(tint)
            .accessibilityLabel(label)
    }
}

// MARK: - StatusDot
//
// Sister component to `DSStatusBadge` — used when the status is
// purely "ambient" (next to a contact name to show online state,
// etc). Just an 8pt circle in the tint color.

struct StatusDot: View {
    let tint: Color

    init(tint: Color) {
        self.tint = tint
    }

    var body: some View {
        Circle()
            .fill(tint)
            .frame(width: 8, height: 8)
            .accessibilityHidden(true)
    }
}

#Preview("DSStatusBadge / StatusDot") {
    VStack(alignment: .leading, spacing: Spacing.s12) {
        HStack(spacing: Spacing.s8) {
            DSStatusBadge(label: "Aprobado", tint: .rdGreen)
            DSStatusBadge(label: "Pendiente", tint: .rdOrange)
            DSStatusBadge(label: "Rechazado", tint: .rdRed)
        }
        HStack(spacing: Spacing.s8) {
            StatusDot(tint: .rdGreen)
            Text("En línea").font(.subheadline)
        }
    }
    .padding()
    .background(Color.rdSurface)
}
