import SwiftUI

// MARK: - Secretary Dashboard

struct SecretaryDashboardView: View {
    @EnvironmentObject var api: APIService
    @State private var selectedTab = 0

    private let tabs = ["Inicio", "Aplicaciones", "Contactos", "Pagos", "Archivo", "Propiedades"]

    var body: some View {
        VStack(spacing: 0) {
            // Tab bar — design-system ChipRow
            ChipRow(
                items: tabs.enumerated().map { idx, title in
                    ChipRow<Int>.Chip(id: idx, label: title)
                },
                selection: $selectedTab
            )
            .padding(.vertical, Spacing.s8)
            .background(Color(.systemBackground))

            Divider()

            TabView(selection: $selectedTab) {
                DashboardHomeView(
                    showSalesMetrics: false,
                    onTapTab: { tab in
                        // Map: 0=Applications→1, 4=Archive→4
                        if tab == 0 { selectedTab = 1 }
                        else if tab == 4 { selectedTab = 4 }
                    },
                    onTapMessages: {},
                    onTapTours: {}
                ).tag(0)
                DashboardApplicationsTab().tag(1)
                ContactsListView().tag(2)
                PaymentsTabView().tag(3)
                DashboardArchiveTab().tag(4)
                DashboardListingAnalyticsTab().tag(5)
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
                        .accessibilityLabel("Más opciones")
                }
            }
        }
    }
}
