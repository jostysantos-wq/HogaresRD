import SwiftUI

// MARK: - Pills
//
// Generic capsule "pill" components. Used everywhere small key/value
// pieces of information need to be visually compact: counts, ratings,
// inline icons + labels.
//
// The four flavours below cover the patterns currently duplicated in
// 9+ places in the app. Migrate inline pill code here as you touch
// each screen.
//
// Named with a `DS` prefix because the codebase already contains
// private `RatingPill` (FeedView.swift) and other ad-hoc pill
// definitions. Once those are removed in a sibling refactor we can
// drop the prefix.

/// Plain text pill in a tinted capsule. Foundation for the more
/// specific variants below.
struct DSPill: View {
    let label: String
    let tint: Color

    init(label: String, tint: Color = .rdInk) {
        self.label = label
        self.tint = tint
    }

    var body: some View {
        Text(label)
            .font(.caption.weight(.semibold))
            .padding(.horizontal, 8)
            .padding(.vertical, 3)
            .background(Capsule().fill(tint.opacity(0.14)))
            .foregroundStyle(tint)
            .accessibilityLabel(label)
    }
}

/// Compact number pill — used to show counts on tabs, list rows, or
/// next to category labels ("Aprobadas 6").
struct DSCountPill: View {
    let count: Int
    var tint: Color = .rdInk

    var body: some View {
        Text(count > 999 ? "999+" : "\(count)")
            .font(.caption2.weight(.bold))
            .monospacedDigit()
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(Capsule().fill(tint.opacity(0.14)))
            .foregroundStyle(tint)
            .accessibilityLabel("\(count)")
    }
}

/// Star rating pill — leading filled-star symbol + numeric value.
/// Defaults to the "amber" rdOrange tint.
struct DSRatingPill: View {
    let value: Double
    var tint: Color = .rdOrange

    var body: some View {
        HStack(spacing: 3) {
            Image(systemName: "star.fill")
                .font(.system(size: 10, weight: .semibold))
            Text(String(format: "%.1f", value))
                .font(.caption2.weight(.semibold))
                .monospacedDigit()
        }
        .padding(.horizontal, 6)
        .padding(.vertical, 2)
        .background(Capsule().fill(tint.opacity(0.14)))
        .foregroundStyle(tint)
        .accessibilityLabel("Calificación \(String(format: "%.1f", value))")
    }
}

/// Pill with an SF Symbol on the leading edge — used for "1.2km",
/// "Mascotas OK", "Estacionamiento", etc.
struct DSIconPill: View {
    let systemImage: String
    let label: String
    var tint: Color = .rdInk

    var body: some View {
        HStack(spacing: 4) {
            Image(systemName: systemImage)
                .font(.system(size: 10, weight: .semibold))
            Text(label)
                .font(.caption2.weight(.semibold))
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 3)
        .background(Capsule().fill(tint.opacity(0.14)))
        .foregroundStyle(tint)
        .accessibilityLabel("\(label)")
    }
}

#Preview("Pills") {
    VStack(alignment: .leading, spacing: Spacing.s8) {
        HStack { DSPill(label: "Activo", tint: .rdGreen); DSPill(label: "Pausado", tint: .rdOrange) }
        HStack { DSCountPill(count: 6); DSCountPill(count: 1200, tint: .rdRed) }
        HStack { DSRatingPill(value: 4.7); DSRatingPill(value: 5.0, tint: .rdGreen) }
        HStack {
            DSIconPill(systemImage: "bed.double.fill", label: "3 hab")
            DSIconPill(systemImage: "shower.fill", label: "2 baños")
            DSIconPill(systemImage: "car.fill", label: "1 estac.")
        }
    }
    .padding()
    .background(Color.rdSurface)
}
