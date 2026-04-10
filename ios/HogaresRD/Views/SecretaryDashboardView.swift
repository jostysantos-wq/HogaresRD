import SwiftUI

// MARK: - Secretary Dashboard

struct SecretaryDashboardView: View {
    @EnvironmentObject var api: APIService
    @State private var selectedTab = 0

    private let tabs = ["Inicio", "Aplicaciones", "Contactos", "Archivo", "Propiedades"]

    var body: some View {
        VStack(spacing: 0) {
            // Tab bar
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 6) {
                    ForEach(Array(tabs.enumerated()), id: \.offset) { i, title in
                        Button {
                            withAnimation(.easeInOut(duration: 0.2)) { selectedTab = i }
                        } label: {
                            HStack(spacing: 4) {
                                if i == 0 {
                                    Image(systemName: "house.fill").font(.system(size: 10))
                                }
                                Text(title)
                            }
                            .font(.caption).bold()
                            .padding(.horizontal, 14).padding(.vertical, 8)
                            .background(selectedTab == i ? Color(red: 0.18, green: 0.55, blue: 0.34) : Color(.secondarySystemFill))
                            .foregroundStyle(selectedTab == i ? .white : .primary)
                            .clipShape(Capsule())
                        }
                        .buttonStyle(.plain)
                    }
                }
                .padding(.horizontal)
                .padding(.vertical, 10)
            }
            .background(Color(.systemBackground))

            Divider()

            TabView(selection: $selectedTab) {
                DashboardHomeView(
                    showSalesMetrics: false,
                    onTapTab: { tab in
                        // Map: 0=Applications→1, 4=Archive→3
                        if tab == 0 { selectedTab = 1 }
                        else if tab == 4 { selectedTab = 3 }
                    },
                    onTapMessages: {},
                    onTapTours: {}
                ).tag(0)
                DashboardApplicationsTab().tag(1)
                ContactsListView().tag(2)
                DashboardArchiveTab().tag(3)
                DashboardListingAnalyticsTab().tag(4)
            }
            .tabViewStyle(.page(indexDisplayMode: .never))
            .environmentObject(api)
        }
        .navigationTitle("Panel Secretaria")
        .navigationBarTitleDisplayMode(.large)
        .toolbar {
            ToolbarItem(placement: .navigationBarTrailing) {
                Menu {
                    NavigationLink {
                        ChatIAView().environmentObject(api)
                    } label: {
                        Label("Chat IA", systemImage: "brain.head.profile.fill")
                    }
                    NavigationLink {
                        ConversationsView().environmentObject(api)
                    } label: {
                        Label("Mensajes", systemImage: "bubble.left.and.bubble.right.fill")
                    }
                    NavigationLink {
                        DashboardSettingsView().environmentObject(api)
                    } label: {
                        Label("Configuracion", systemImage: "gearshape.fill")
                    }
                    Link(destination: URL(string: "https://hogaresrd.com/broker")!) {
                        Label("Abrir en web", systemImage: "safari.fill")
                    }
                } label: {
                    Image(systemName: "ellipsis.circle")
                        .font(.title3)
                }
            }
        }
    }
}
