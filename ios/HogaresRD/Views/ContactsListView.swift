import SwiftUI

// MARK: - Contacts List (CRM — all contacts for this agent)

struct ContactsListView: View {
    @EnvironmentObject var api: APIService
    @State private var contacts: [ContactSummary] = []
    @State private var loading = true
    @State private var searchText = ""

    private var filtered: [ContactSummary] {
        guard !searchText.isEmpty else { return contacts }
        let q = searchText.lowercased()
        return contacts.filter {
            $0.name.lowercased().contains(q) ||
            ($0.email ?? "").lowercased().contains(q) ||
            ($0.phone ?? "").contains(q)
        }
    }

    var body: some View {
        VStack(spacing: 0) {
            // Search bar
            HStack(spacing: 10) {
                Image(systemName: "magnifyingglass")
                    .foregroundStyle(.secondary)
                TextField("Buscar contacto...", text: $searchText)
                    .font(.subheadline)
                if !searchText.isEmpty {
                    Button { searchText = "" } label: {
                        Image(systemName: "xmark.circle.fill")
                            .foregroundStyle(.secondary)
                    }
                }
            }
            .padding(10)
            .background(Color(.secondarySystemBackground))
            .clipShape(RoundedRectangle(cornerRadius: 10))
            .padding(.horizontal)
            .padding(.vertical, 8)

            if loading {
                VStack(spacing: 16) {
                    Spacer()
                    ProgressView()
                    Text("Cargando contactos...")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                    Spacer()
                }
            } else if filtered.isEmpty {
                VStack(spacing: 16) {
                    Spacer()
                    Image(systemName: "person.2.slash")
                        .font(.system(size: 48))
                        .foregroundStyle(.secondary)
                    Text(searchText.isEmpty ? "No hay contactos aun" : "Sin resultados")
                        .font(.headline)
                    Text(searchText.isEmpty ? "Los clientes que interactuen contigo apareceran aqui." : "Intenta con otro termino de busqueda.")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                    Spacer()
                }
                .padding(.horizontal)
            } else {
                // Stats bar
                HStack(spacing: 16) {
                    Label("\(contacts.count) contactos", systemImage: "person.2.fill")
                        .font(.caption.bold())
                        .foregroundStyle(.secondary)
                    Spacer()
                }
                .padding(.horizontal)
                .padding(.bottom, 6)

                ScrollView {
                    LazyVStack(spacing: 0) {
                        ForEach(filtered) { contact in
                            NavigationLink {
                                ContactTimelineView(contactId: contact.id, contactName: contact.name)
                                    .environmentObject(api)
                            } label: {
                                contactRow(contact)
                            }
                            .buttonStyle(.plain)
                            Divider().padding(.leading, 72)
                        }
                    }
                }
            }
        }
        .task { await load() }
        .refreshable { await load() }
    }

    private func load() async {
        loading = true
        do {
            contacts = try await api.getContacts()
        } catch {
            contacts = []
        }
        loading = false
    }

    // MARK: - Contact Row

    private func contactRow(_ c: ContactSummary) -> some View {
        HStack(spacing: 14) {
            // Avatar
            ZStack {
                Circle()
                    .fill(avatarColor(c.id))
                    .frame(width: 48, height: 48)
                Text(c.initials)
                    .font(.system(size: 16, weight: .bold))
                    .foregroundStyle(.white)
            }

            VStack(alignment: .leading, spacing: 3) {
                Text(c.name.isEmpty ? (c.email ?? "Contacto") : c.name)
                    .font(.subheadline.bold())
                    .lineLimit(1)
                if let email = c.email, !email.isEmpty {
                    Text(email)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
                if let phone = c.phone, !phone.isEmpty {
                    Text(phone)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }

            Spacer()

            VStack(alignment: .trailing, spacing: 4) {
                Text(c.lastInteractionAgo)
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                HStack(spacing: 4) {
                    Image(systemName: "arrow.left.arrow.right")
                        .font(.system(size: 9))
                    Text("\(c.interactions ?? 0)")
                        .font(.caption2.bold())
                }
                .foregroundStyle(.secondary)
                .padding(.horizontal, 8).padding(.vertical, 3)
                .background(Color(.tertiarySystemFill))
                .clipShape(Capsule())
            }

            Image(systemName: "chevron.right")
                .font(.caption2)
                .foregroundStyle(.tertiary)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
    }

    private func avatarColor(_ id: String) -> Color {
        let colors: [Color] = [.rdBlue, .rdGreen, Color(red: 0.4, green: 0.1, blue: 0.6), Color(red: 0.7, green: 0.35, blue: 0.04), .rdRed]
        return colors[abs(id.hashValue) % colors.count]
    }
}
