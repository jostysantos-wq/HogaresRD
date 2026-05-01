import SwiftUI

// MARK: - ChipRow
//
// Horizontal-scrolling capsule chip selector. Active chip glides
// between positions via `matchedGeometryEffect` for a polished feel.
// Used for tab-style filters (Todas / Activas / Vencidas) and segmented
// selectors that need to show counts.
//
// Generic on `ID` so callers can use `String`, an enum's raw value, or
// any other Hashable identifier.

struct ChipRow<ID: Hashable>: View {
    /// One chip in the row. `count` is optional and rendered as a
    /// subtle pill on the right side of the label.
    struct Chip: Identifiable {
        let id: ID
        let label: String
        var count: Int? = nil
    }

    let items: [Chip]
    @Binding var selection: ID
    @Namespace private var ns

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: Spacing.s8) {
                ForEach(items) { chip in
                    chipView(for: chip)
                }
            }
            .padding(.horizontal, Spacing.s16)
            .padding(.vertical, Spacing.s4)
        }
        .accessibilityElement(children: .contain)
    }

    @ViewBuilder
    private func chipView(for chip: Chip) -> some View {
        let active = (chip.id == selection)
        Button {
            withAnimation(.spring(response: 0.35, dampingFraction: 0.85)) {
                selection = chip.id
            }
        } label: {
            HStack(spacing: 6) {
                Text(chip.label)
                    .font(.subheadline.weight(.medium))
                if let count = chip.count {
                    Text("\(count)")
                        .font(.caption2.weight(.semibold))
                        .padding(.horizontal, 6)
                        .padding(.vertical, 1)
                        .background(
                            Capsule().fill(active ? Color.white.opacity(0.25) : Color.rdInk.opacity(0.08))
                        )
                }
            }
            .padding(.horizontal, Spacing.s12)
            .padding(.vertical, Spacing.s8)
            .foregroundStyle(active ? Color.white : Color.rdInk)
            .background(
                ZStack {
                    if active {
                        Capsule()
                            .fill(Color.rdInk)
                            .matchedGeometryEffect(id: "chipBg", in: ns)
                    } else {
                        Capsule()
                            .fill(Color.rdSurfaceMuted)
                    }
                }
            )
        }
        .buttonStyle(.plain)
        .accessibilityLabel(chip.label)
        .accessibilityValue(chip.count.map { "\($0)" } ?? "")
        .accessibilityAddTraits(active ? .isSelected : [])
    }
}

#Preview("ChipRow") {
    struct Demo: View {
        @State private var sel: String = "todas"
        var body: some View {
            ChipRow(
                items: [
                    .init(id: "todas", label: "Todas", count: 24),
                    .init(id: "activas", label: "Activas", count: 6),
                    .init(id: "vencidas", label: "Vencidas", count: 2),
                    .init(id: "archivadas", label: "Archivadas")
                ],
                selection: $sel
            )
            .padding(.vertical)
            .background(Color.rdBg)
        }
    }
    return Demo()
}
