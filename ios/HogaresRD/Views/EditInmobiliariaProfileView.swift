// EditInmobiliariaProfileView.swift
//
// Mirrors the web's /equipo-empresa.html "Perfil de Empresa" form.
// Lets an inmobiliaria/constructora owner edit the public-facing
// profile that appears on their agency page and on every listing.
// Backed by GET / PATCH /api/inmobiliaria/profile.

import SwiftUI

struct EditInmobiliariaProfileView: View {
    @EnvironmentObject var api: APIService
    @Environment(\.dismiss) private var dismiss

    @State private var loading = true
    @State private var saving  = false
    @State private var errorMsg: String?
    @State private var savedAt: Date?

    // Form fields
    @State private var tagline:            String = ""
    @State private var companyDescription: String = ""
    @State private var coverImage:         String = ""
    @State private var website:            String = ""
    @State private var yearsInBusiness:    Int    = 0
    @State private var officeAddress:      String = ""
    @State private var officeHours:        String = ""
    @State private var facebook:           String = ""
    @State private var instagram:          String = ""
    @State private var linkedin:           String = ""
    @State private var whatsapp:           String = ""

    var body: some View {
        Form {
            if loading {
                Section { ProgressView() }
            } else {
                Section("Información de la empresa") {
                    TextField("Eslogan / Tagline", text: $tagline)
                        .textInputAutocapitalization(.sentences)
                    TextField("Descripción de la empresa", text: $companyDescription, axis: .vertical)
                        .lineLimit(3...8)
                    Stepper(value: $yearsInBusiness, in: 0...100) {
                        HStack {
                            Text("Años de experiencia")
                            Spacer()
                            Text("\(yearsInBusiness)").foregroundStyle(.secondary)
                        }
                    }
                    TextField("Sitio web (https://…)", text: $website)
                        .textContentType(.URL)
                        .keyboardType(.URL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                }

                Section("Oficina") {
                    TextField("Dirección", text: $officeAddress)
                    TextField("Horario (Lun-Vie 9-6, Sáb 9-1)", text: $officeHours)
                }

                Section("Imagen de portada") {
                    TextField("URL pública de la imagen", text: $coverImage)
                        .textContentType(.URL)
                        .keyboardType(.URL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                    Text("Foto del equipo, oficina o un proyecto destacado. Aparece como banner en tu página pública. Recomendado: 1200×400 px.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }

                Section("Redes sociales") {
                    socialField(label: "Facebook",  systemImage: "f.circle.fill", text: $facebook)
                    socialField(label: "Instagram", systemImage: "camera.circle.fill", text: $instagram)
                    socialField(label: "LinkedIn",  systemImage: "link.circle.fill", text: $linkedin)
                    socialField(label: "WhatsApp",  systemImage: "bubble.right.fill", text: $whatsapp,
                                placeholder: "+1 809 000 0000",
                                contentType: .telephoneNumber,
                                keyboard: .phonePad)
                }

                if let savedAt {
                    Section {
                        Label("Guardado \(savedAt.formatted(date: .omitted, time: .shortened))",
                              systemImage: "checkmark.circle.fill")
                            .foregroundStyle(.green)
                    }
                }

                if let errorMsg {
                    Section {
                        Label(errorMsg, systemImage: "exclamationmark.triangle.fill")
                            .foregroundStyle(.red)
                            .font(.callout)
                    }
                }
            }
        }
        .navigationTitle("Perfil de empresa")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .navigationBarTrailing) {
                Button("Guardar") { Task { await save() } }
                    .disabled(saving || loading)
            }
        }
        .task { await load() }
    }

    @ViewBuilder
    private func socialField(
        label: String, systemImage: String, text: Binding<String>,
        placeholder: String? = nil,
        contentType: UITextContentType? = nil,
        keyboard: UIKeyboardType = .URL
    ) -> some View {
        HStack {
            Image(systemName: systemImage)
                .foregroundStyle(Color.rdBlue)
                .frame(width: 24)
            VStack(alignment: .leading, spacing: 2) {
                Text(label).font(.caption).foregroundStyle(.secondary)
                TextField(placeholder ?? (label == "Facebook" ? "https://facebook.com/…" :
                                          label == "Instagram" ? "https://instagram.com/…" :
                                          label == "LinkedIn" ? "https://linkedin.com/company/…" : ""),
                          text: text)
                    .textContentType(contentType)
                    .keyboardType(keyboard)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
            }
        }
    }

    private func load() async {
        loading = true
        errorMsg = nil
        defer { loading = false }
        do {
            let p = try await api.getInmobiliariaProfile()
            await MainActor.run {
                tagline            = p.tagline ?? ""
                companyDescription = p.companyDescription ?? ""
                coverImage         = p.coverImage ?? ""
                website            = p.website ?? ""
                yearsInBusiness    = p.yearsInBusiness ?? 0
                officeAddress      = p.officeAddress ?? ""
                officeHours        = p.officeHours ?? ""
                facebook           = p.social?.facebook  ?? ""
                instagram          = p.social?.instagram ?? ""
                linkedin           = p.social?.linkedin  ?? ""
                whatsapp           = p.social?.whatsapp  ?? ""
            }
        } catch {
            await MainActor.run { errorMsg = (error as? LocalizedError)?.errorDescription ?? "No se pudo cargar el perfil." }
        }
    }

    private func save() async {
        saving = true
        errorMsg = nil
        defer { saving = false }
        do {
            _ = try await api.updateInmobiliariaProfile(
                tagline:            tagline,
                companyDescription: companyDescription,
                coverImage:         coverImage,
                website:            website,
                yearsInBusiness:    yearsInBusiness,
                officeAddress:      officeAddress,
                officeHours:        officeHours,
                social: InmobiliariaSocial(
                    facebook:  facebook,
                    instagram: instagram,
                    linkedin:  linkedin,
                    whatsapp:  whatsapp
                )
            )
            await MainActor.run { savedAt = Date() }
        } catch {
            await MainActor.run { errorMsg = (error as? LocalizedError)?.errorDescription ?? "No se pudo guardar." }
        }
    }
}
