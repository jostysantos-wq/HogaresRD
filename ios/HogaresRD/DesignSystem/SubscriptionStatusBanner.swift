import SwiftUI

// MARK: - SubscriptionStatusBanner
//
// Capsule banner used at the top of the Profile / Subscription screens
// to communicate the user's billing state at a glance. Three variants
// keyed off the Stripe-style status string:
//
//   • .active   — subscription in good standing.
//   • .trialing — free trial; show days-remaining if available.
//   • .pastDue  — payment failed; needs action.
//
// Tap target included via `onTap` — pass nil to render as a static
// banner.

struct SubscriptionStatusBanner: View {
    enum Status {
        case active
        case trialing(daysRemaining: Int?)
        case pastDue
    }

    let status: Status
    var onTap: (() -> Void)? = nil

    var body: some View {
        Group {
            if let onTap {
                Button(action: onTap) { content }
                    .buttonStyle(.plain)
            } else {
                content
            }
        }
    }

    private var content: some View {
        HStack(spacing: Spacing.s12) {
            ZStack {
                Circle()
                    .fill(tint.opacity(0.18))
                    .frame(width: 32, height: 32)
                Image(systemName: systemImage)
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(tint)
            }
            .accessibilityHidden(true)

            VStack(alignment: .leading, spacing: 2) {
                Text(headline)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(Color.rdInk)
                Text(subheadline)
                    .font(.caption2)
                    .foregroundStyle(Color.rdInkSoft)
            }
            Spacer(minLength: Spacing.s8)
            Image(systemName: "chevron.right")
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(Color.rdInkSoft)
                .accessibilityHidden(true)
        }
        .padding(.horizontal, Spacing.s16)
        .padding(.vertical, Spacing.s12)
        .background(
            Capsule(style: .continuous).fill(tint.opacity(0.12))
        )
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(headline). \(subheadline)")
    }

    // ── Per-status copy + tint ──

    private var tint: Color {
        switch status {
        case .active:   return .rdGreen
        case .trialing: return .rdBlue
        case .pastDue:  return .rdRed
        }
    }

    private var systemImage: String {
        switch status {
        case .active:   return "checkmark.seal.fill"
        case .trialing: return "clock.fill"
        case .pastDue:  return "exclamationmark.triangle.fill"
        }
    }

    private var headline: String {
        switch status {
        case .active:   return "Suscripción activa"
        case .trialing: return "Período de prueba"
        case .pastDue:  return "Pago atrasado"
        }
    }

    private var subheadline: String {
        switch status {
        case .active:
            return "Tu plan se renueva automáticamente."
        case .trialing(let days):
            if let days {
                return "Quedan \(days) día\(days == 1 ? "" : "s") de prueba."
            }
            return "Estás en período de prueba."
        case .pastDue:
            return "Actualiza tu método de pago para continuar."
        }
    }
}

#Preview("SubscriptionStatusBanner") {
    VStack(spacing: Spacing.s12) {
        SubscriptionStatusBanner(status: .active)
        SubscriptionStatusBanner(status: .trialing(daysRemaining: 5))
        SubscriptionStatusBanner(status: .pastDue)
    }
    .padding()
    .background(Color.rdBg)
}
