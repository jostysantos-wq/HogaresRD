import SwiftUI

// MARK: - Brand Colors
extension Color {
    static let rdBlue  = Color(red: 0/255,  green: 56/255,  blue: 168/255)
    static let rdRed   = Color(red: 207/255, green: 20/255,  blue: 43/255)
    static let rdGreen = Color(red: 27/255,  green: 122/255, blue: 62/255)
    static let rdBg    = Color(red: 242/255, green: 246/255, blue: 255/255)
}

// MARK: - Root Tab View

struct ContentView: View {
    @EnvironmentObject var api:   APIService
    @EnvironmentObject var saved: SavedStore

    @State private var selectedTab = 0
    @State private var showPost    = false

    init() {
        // Hide the native tab bar — replaced entirely by HogaresTabBar
        UITabBar.appearance().isHidden = true
    }

    var body: some View {
        TabView(selection: $selectedTab) {
            FeedView()    .tag(0)
            HomeView()    .tag(1)
            BrowseView()  .tag(2)
            ProfileView() .tag(3)
        }
        // Attach our custom tab bar below the content, safe-area-aware
        .safeAreaInset(edge: .bottom, spacing: 0) {
            HogaresTabBar(selected: $selectedTab, showPost: $showPost)
        }
        .sheet(isPresented: $showPost) {
            SubmitListingView().environmentObject(api)
        }
    }
}

// MARK: - Custom Tab Bar

private struct HogaresTabBar: View {
    @Binding var selected: Int
    @Binding var showPost: Bool

    /// Read bottom safe-area from UIKit so we don't need a GeometryReader
    private var bottomInset: CGFloat {
        UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .first?.windows.first?.safeAreaInsets.bottom ?? 0
    }

    var body: some View {
        HStack(spacing: 0) {

            tabBtn(icon: "newspaper.fill",     label: "Feed",    tag: 0)
            tabBtn(icon: "house.fill",         label: "Inicio",  tag: 1)

            // ── Exact-centre publish button ───────────────────────
            Button { showPost = true } label: {
                ZStack {
                    Circle()
                        .fill(Color.rdBlue)
                        .frame(width: 52, height: 52)
                        .shadow(color: Color.rdBlue.opacity(0.35), radius: 8, y: 3)
                    Image(systemName: "plus")
                        .font(.system(size: 23, weight: .bold))
                        .foregroundStyle(.white)
                }
                .offset(y: -8)   // lift slightly above the bar line
            }
            .buttonStyle(.plain)
            .frame(maxWidth: .infinity)

            tabBtn(icon: "magnifyingglass",    label: "Explorar", tag: 2)
            tabBtn(icon: "person.circle.fill", label: "Perfil",   tag: 3)
        }
        .frame(height: 52)
        .padding(.top, 8)
        .padding(.bottom, bottomInset > 0 ? bottomInset : 12)
        .background(.regularMaterial)
        .overlay(alignment: .top) {
            Rectangle().fill(Color(.separator)).frame(height: 0.5)
        }
    }

    @ViewBuilder
    private func tabBtn(icon: String, label: String, tag: Int) -> some View {
        let active = selected == tag
        Button { selected = tag } label: {
            VStack(spacing: 3) {
                Image(systemName: icon)
                    .font(.system(size: 20, weight: active ? .semibold : .regular))
                Text(label)
                    .font(.system(size: 10, weight: .medium))
            }
            .foregroundStyle(active ? Color.rdBlue : Color(.secondaryLabel))
            .frame(maxWidth: .infinity)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
}
