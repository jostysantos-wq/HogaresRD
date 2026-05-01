import SwiftUI

// MARK: - DSRoleBadge
//
// Single source of truth for role pills. Maps the server `role` string
// (cliente / broker / inmobiliaria / constructora / secretary / admin)
// to the brand palette so the colour stays consistent everywhere a
// role is shown.
//
// Replaces ~10 ad-hoc raw-RGB role colour literals scattered across
// the codebase. Add new roles here, never inline.
//
// Named with a `DS` prefix to coexist with the legacy `RoleBadge`
// declared in `Views/AuthView.swift`. Sibling refactors should swap
// the legacy occurrences for `DSRoleBadge`, then drop the prefix in a
// final follow-up.

struct DSRoleBadge: View {
    let role: String
    var size: Size = .regular

    enum Size {
        case compact
        case regular

        var horizontalPadding: CGFloat {
            switch self {
            case .compact: return 6
            case .regular: return 8
            }
        }
        var verticalPadding: CGFloat {
            switch self {
            case .compact: return 2
            case .regular: return 3
            }
        }
        var font: Font {
            switch self {
            case .compact: return .caption2.weight(.semibold)
            case .regular: return .caption.weight(.semibold)
            }
        }
    }

    var body: some View {
        Text(displayName)
            .font(size.font)
            .padding(.horizontal, size.horizontalPadding)
            .padding(.vertical, size.verticalPadding)
            .background(
                Capsule().fill(tint.opacity(0.15))
            )
            .foregroundStyle(tint)
            .accessibilityLabel("Rol \(displayName)")
    }

    // ── Mapping ──

    private var normalised: String {
        role.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    }

    var tint: Color {
        switch normalised {
        case "cliente", "client", "buyer":            return .rdGreen
        case "broker", "agency", "agent":             return .rdBlue
        case "inmobiliaria", "agency_owner":          return .rdPurple
        case "constructora", "builder", "developer":  return .rdOrange
        case "secretary", "secretaria":               return .rdTeal
        case "admin", "superadmin":                   return .rdInk
        default:                                      return .rdInkSoft
        }
    }

    var displayName: String {
        switch normalised {
        case "cliente", "client", "buyer":            return "Cliente"
        case "broker", "agency", "agent":             return "Broker"
        case "inmobiliaria", "agency_owner":          return "Inmobiliaria"
        case "constructora", "builder", "developer":  return "Constructora"
        case "secretary", "secretaria":               return "Secretaria"
        case "admin", "superadmin":                   return "Admin"
        default:                                      return role.capitalized
        }
    }
}

#Preview("DSRoleBadge") {
    VStack(alignment: .leading, spacing: Spacing.s8) {
        ForEach(["cliente", "broker", "inmobiliaria", "constructora", "secretary", "admin"], id: \.self) { r in
            HStack {
                DSRoleBadge(role: r)
                Spacer()
                DSRoleBadge(role: r, size: .compact)
            }
        }
    }
    .padding()
    .background(Color.rdSurface)
}
