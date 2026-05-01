import SwiftUI

// MARK: - SkeletonRow
//
// Loading-state placeholder shaped like an `IconTileRow`: a 40pt
// circle on the left and two stacked text lines on the right, all
// redacted and shimmering. Used while a screen waits for its initial
// data so the layout doesn't pop in.

struct SkeletonRow: View {
    var body: some View {
        HStack(spacing: Spacing.s12) {
            Circle()
                .fill(Color.rdMuted.opacity(0.25))
                .frame(width: 40, height: 40)

            VStack(alignment: .leading, spacing: Spacing.s8) {
                RoundedRectangle(cornerRadius: 4)
                    .fill(Color.rdMuted.opacity(0.25))
                    .frame(height: 12)
                    .frame(maxWidth: .infinity, alignment: .leading)
                RoundedRectangle(cornerRadius: 4)
                    .fill(Color.rdMuted.opacity(0.18))
                    .frame(height: 10)
                    .frame(maxWidth: 160, alignment: .leading)
            }
            Spacer(minLength: 0)
        }
        .padding(.vertical, Spacing.s8)
        .redacted(reason: .placeholder)
        .shimmer()
        .accessibilityHidden(true)
    }
}

// MARK: - Skeleton stack helper
//
// `.skeleton(rows: 5)` produces a `VStack` of `SkeletonRow`s — the
// most common usage when bootstrapping a list-style screen.
extension View {
    /// Replace `self` with a stack of skeleton rows when `condition`
    /// is true (typically `isLoading`). Useful pattern:
    /// `MyList().skeleton(rows: 5, when: viewModel.isLoading)`.
    @ViewBuilder
    func skeleton(rows: Int, when condition: Bool = true) -> some View {
        if condition {
            VStack(spacing: 0) {
                ForEach(0..<rows, id: \.self) { _ in
                    SkeletonRow()
                    Divider().opacity(0.4)
                }
            }
        } else {
            self
        }
    }
}

#Preview("SkeletonRow") {
    VStack(spacing: 0) {
        ForEach(0..<4, id: \.self) { _ in
            SkeletonRow()
            Divider().opacity(0.4)
        }
    }
    .padding()
    .background(Color.rdSurface)
}
