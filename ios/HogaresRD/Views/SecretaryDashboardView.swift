import SwiftUI

// MARK: - Secretary Dashboard

struct SecretaryDashboardView: View {
    @EnvironmentObject var api: APIService
    @State private var selectedTab = 0

    // Level 1 secretaries: limited tab set
    private let tabs = ["Aplicaciones", "Archivo", "Mis Propiedades"]

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
                                    Image(systemName: "doc.text.fill").font(.system(size: 10))
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

            // Content — maps to the broker dashboard tabs, skipping Ventas(2) and Contabilidad(3)
            TabView(selection: $selectedTab) {
                DashboardApplicationsTab().tag(0)    // Aplicaciones
                DashboardAnalyticsTab().tag(1)        // Analíticas
                DashboardArchiveTab().tag(2)          // Archivo
                DashboardAuditTab().tag(3)            // Auditoría
                DashboardListingAnalyticsTab().tag(4)  // Mis Propiedades
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
                        Label("Configuración", systemImage: "gearshape.fill")
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
