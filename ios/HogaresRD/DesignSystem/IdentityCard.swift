import SwiftUI

// MARK: - IdentityCard
//
// Wallet-style profile card used at the top of Profile, Subscription,
// and account-management screens. Avatar leading, name + email
// trailing, and a role pill anchored to the top-trailing corner.
//
// Designed to be tappable — wrap in a `Button { } label: { IdentityCard(...) }`
// when you want it to navigate.
struct IdentityCard: View {
    let user: User
    var avatarSize: CGFloat = 56
    var subtitleOverride: String?

    var body: some View {
        ZStack(alignment: .topTrailing) {
            HStack(spacing: Spacing.s12) {
                AvatarView(user: user, size: avatarSize, editable: false)
                    .frame(width: avatarSize, height: avatarSize)
                    .accessibilityHidden(true)

                VStack(alignment: .leading, spacing: 2) {
                    Text(user.name)
                        .font(.headline)
                        .foregroundStyle(Color.rdInk)
                        .lineLimit(1)
                    Text(subtitleOverride ?? user.email)
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
                Spacer(minLength: Spacing.s8)
            }
            .padding(Spacing.s16)
            .frame(maxWidth: .infinity, alignment: .leading)

            DSRoleBadge(role: user.role)
                .padding(.top, Spacing.s12)
                .padding(.trailing, Spacing.s12)
        }
        .background(
            RoundedRectangle(cornerRadius: Radius.large, style: .continuous)
                .fill(Color.rdSurface)
        )
        .contentShape(RoundedRectangle(cornerRadius: Radius.large, style: .continuous))
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(user.name), \(user.role)")
        .accessibilityHint(user.email)
    }
}

#Preview("IdentityCard") {
    VStack(spacing: Spacing.s16) {
        IdentityCard(user: .designSystemPreview)
        IdentityCard(user: .designSystemPreview, subtitleOverride: "Suscripción activa")
    }
    .padding()
    .background(Color.rdBg)
}

extension User {
    /// Lightweight fixture used only by `#Preview` blocks in DesignSystem
    /// components. Real screens always pass a server-fetched `User`.
    static var designSystemPreview: User {
        User(
            id: "u1",
            name: "Maria del Carmen",
            email: "maria@example.com",
            role: "cliente",
            phone: nil,
            agencyName: nil,
            marketingOptIn: nil,
            twoFAEnabled: nil,
            twoFAMethod: nil,
            avatarUrl: nil,
            refToken: nil,
            access_level: nil,
            team_title: nil,
            emailVerified: true,
            createdAt: nil,
            subscriptionStatus: nil,
            trialEndsAt: nil
        )
    }
}
