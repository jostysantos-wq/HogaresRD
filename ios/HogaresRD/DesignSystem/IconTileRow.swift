import SwiftUI

// MARK: - IconTileRow
//
// Reusable list row pattern: a 28×28 rounded-rect tile with an SF
// Symbol icon, a label, and an optional trailing accessory. Used
// throughout settings menus, dashboards, and "list of links" screens
// to give every row the same visual rhythm.
//
// The trailing slot is rendered via `accessory: () -> Content` so
// callers can pass anything — a chevron, a value `Text`, a `Toggle`, a
// `StatusBadge`, etc.

struct IconTileRow<Accessory: View>: View {
    let systemImage: String
    let label: String
    var tileFill: Color? = nil
    var iconColor: Color? = nil
    @ViewBuilder var accessory: () -> Accessory

    var body: some View {
        HStack(spacing: Spacing.s12) {
            ZStack {
                RoundedRectangle(cornerRadius: Radius.small, style: .continuous)
                    .fill(tileFill ?? Color.rdInk.opacity(0.08))
                Image(systemName: systemImage)
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(iconColor ?? Color.rdInk)
            }
            .frame(width: 28, height: 28)
            .accessibilityHidden(true)

            Text(label)
                .font(.body)
                .foregroundStyle(Color.rdInk)
                .lineLimit(1)

            Spacer(minLength: Spacing.s8)

            accessory()
        }
        .padding(.vertical, Spacing.s8)
        .contentShape(Rectangle())
    }
}

// MARK: - Convenience initialisers
//
// Two of the three trailing slots (chevron, plain value text) appear
// often enough to deserve their own constructor. The generic `accessory`
// constructor above still covers everything else.

extension IconTileRow where Accessory == ChevronAccessory {
    /// Default disclosure-style row — chevron on the right.
    init(
        systemImage: String,
        label: String,
        tileFill: Color? = nil,
        iconColor: Color? = nil
    ) {
        self.init(
            systemImage: systemImage,
            label: label,
            tileFill: tileFill,
            iconColor: iconColor,
            accessory: { ChevronAccessory() }
        )
    }
}

extension IconTileRow where Accessory == ValueAccessory {
    /// Row that shows a value string on the right (e.g. "Activo",
    /// "RD$1,250"). Renders the value in `rdInkSoft` for hierarchy.
    init(
        systemImage: String,
        label: String,
        value: String,
        tileFill: Color? = nil,
        iconColor: Color? = nil
    ) {
        self.init(
            systemImage: systemImage,
            label: label,
            tileFill: tileFill,
            iconColor: iconColor,
            accessory: { ValueAccessory(text: value) }
        )
    }
}

/// Trailing chevron used by the disclosure-style `IconTileRow`. Lives
/// at top level (not nested) so the conditional `where Accessory ==`
/// extensions can name it without generic gymnastics.
struct ChevronAccessory: View {
    var body: some View {
        Image(systemName: "chevron.right")
            .font(.system(size: 13, weight: .semibold))
            .foregroundStyle(Color.rdInkSoft)
            .accessibilityHidden(true)
    }
}

/// Trailing value text used by the value-style `IconTileRow`.
struct ValueAccessory: View {
    let text: String
    var body: some View {
        Text(text)
            .font(.body)
            .foregroundStyle(Color.rdInkSoft)
            .lineLimit(1)
    }
}

#Preview("IconTileRow") {
    VStack(spacing: 0) {
        IconTileRow(systemImage: "person.fill", label: "Mi cuenta")
        Divider().opacity(0.4)
        IconTileRow(systemImage: "creditcard.fill", label: "Suscripción", value: "Activa")
        Divider().opacity(0.4)
        IconTileRow(
            systemImage: "bell.fill",
            label: "Notificaciones",
            accessory: { Toggle("", isOn: .constant(true)).labelsHidden() }
        )
    }
    .padding()
    .background(Color.rdSurface)
}
