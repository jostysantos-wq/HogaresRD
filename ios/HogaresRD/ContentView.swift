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

    var body: some View {
        ZStack(alignment: .bottom) {

            // ── 4 real tabs — no dummy placeholder ─────────────────
            TabView(selection: $selectedTab) {
                FeedView()
                    .tabItem { Label("Feed",    systemImage: "newspaper.fill") }
                    .tag(0)
                HomeView()
                    .tabItem { Label("Inicio",  systemImage: "house.fill") }
                    .tag(1)
                BrowseView()
                    .tabItem { Label("Explorar", systemImage: "magnifyingglass") }
                    .tag(2)
                ProfileView()
                    .tabItem { Label("Perfil",  systemImage: "person.circle.fill") }
                    .tag(3)
            }
            .tint(Color.rdBlue)

            // ── Floating publish button centred above the tab bar ──
            // Sits in the visual gap between "Inicio" and "Explorar"
            Button { showPost = true } label: {
                ZStack {
                    Circle()
                        .fill(Color.rdBlue)
                        .frame(width: 56, height: 56)
                        .shadow(color: Color.rdBlue.opacity(0.4), radius: 10, x: 0, y: 4)
                    Image(systemName: "plus")
                        .font(.system(size: 24, weight: .bold))
                        .foregroundStyle(.white)
                }
            }
            // Raise it so the bottom of the circle sits flush with the tab bar top
            .padding(.bottom, 30)
        }
        .sheet(isPresented: $showPost) {
            SubmitListingView()
                .environmentObject(api)
        }
    }
}
