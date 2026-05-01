import SwiftUI

// MARK: - Typography modifiers
//
// A small palette of common text styles, expressed as `View` modifiers
// rather than raw `.system(size:)` calls. Using semantic Dynamic Type
// styles (`.headline`, `.subheadline`, `.caption2`) means the text
// scales correctly when users bump up their accessibility text size —
// `.system(size:)` does not.
//
// If you find yourself reaching for a specific point size for body
// content, add a new modifier here instead of leaking the literal into
// a view.

extension View {
    /// Section header above a list/card group. Sentence case, semibold,
    /// no auto-uppercasing (we're not a legacy iOS settings bundle).
    func sectionHeader() -> some View {
        self
            .font(.subheadline.weight(.semibold))
            .textCase(nil)
            .foregroundStyle(Color.rdInk)
    }

    /// Page-level eyebrow — small, all caps, used to label the screen
    /// above an h1 (e.g. "Tu cuenta" above the user's name).
    func eyebrow() -> some View {
        self
            .font(.caption.weight(.semibold))
            .textTransform(uppercase: true)
            .foregroundStyle(Color.rdInkSoft)
            .tracking(0.6)
    }

    /// Card title — appears at the top of a `FormCard` or
    /// `IdentityCard`. Slightly heavier than body, still compatible
    /// with Dynamic Type.
    func cardTitle() -> some View {
        self
            .font(.headline)
            .foregroundStyle(Color.rdInk)
    }

    /// Secondary copy under a title — captions, helper text, the email
    /// line on an identity card.
    func metadata() -> some View {
        self
            .font(.caption2)
            .foregroundStyle(Color.rdInkSoft)
    }

    /// Numeric/value emphasis — table values, prices, counts.
    func valueText() -> some View {
        self
            .font(.body.weight(.semibold))
            .foregroundStyle(Color.rdInk)
            .monospacedDigit()
    }
}

// MARK: - Text-case helper
//
// SwiftUI's `.textCase(.uppercase)` works at the `Text` level only.
// This trivial modifier wraps it so the API reads naturally on
// arbitrary views (`.eyebrow()` above).
private extension View {
    @ViewBuilder
    func textTransform(uppercase: Bool) -> some View {
        if uppercase {
            self.textCase(.uppercase)
        } else {
            self.textCase(nil)
        }
    }
}

#Preview("Typography") {
    VStack(alignment: .leading, spacing: Spacing.s16) {
        Text("Tu cuenta").eyebrow()
        Text("Maria del Carmen").cardTitle()
        Text("maria@example.com").metadata()
        Text("Resumen").sectionHeader()
        Text("RD$ 1,250,000").valueText()
    }
    .padding()
    .background(Color.rdSurface)
}
