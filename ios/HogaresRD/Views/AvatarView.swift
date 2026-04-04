import SwiftUI
import UIKit

/// Reusable avatar view — shows photo if available, initials fallback.
/// When `editable` is true, tapping opens the photo library.
struct AvatarView: View {
    let user: User
    var size: CGFloat = 56
    var editable: Bool = false
    var color: Color = .rdBlue

    @EnvironmentObject var api: APIService
    @State private var uploading = false
    @State private var showPicker = false
    @State private var showError = false
    @State private var errorMsg = ""

    var body: some View {
        ZStack(alignment: .bottomTrailing) {
            if editable {
                Button { showPicker = true } label: {
                    avatarContent
                }
                .buttonStyle(.plain)

                ZStack {
                    Circle()
                        .fill(Color.rdBlue)
                        .frame(width: size * 0.32, height: size * 0.32)
                    if uploading {
                        ProgressView().scaleEffect(0.5).tint(.white)
                    } else {
                        Image(systemName: "camera.fill")
                            .font(.system(size: size * 0.13))
                            .foregroundStyle(.white)
                    }
                }
                .offset(x: 2, y: 2)
            } else {
                avatarContent
            }
        }
        .sheet(isPresented: $showPicker) {
            ImagePicker { image in
                Task { await upload(image) }
            }
            .ignoresSafeArea()
        }
        .alert("Error", isPresented: $showError) {
            Button("OK") {}
        } message: {
            Text(errorMsg)
        }
    }

    @ViewBuilder
    private var avatarContent: some View {
        if let url = user.avatarImageURL {
            AsyncImage(url: url) { phase in
                switch phase {
                case .success(let img):
                    img.resizable().scaledToFill()
                        .frame(width: size, height: size)
                        .clipShape(Circle())
                        .overlay(Circle().stroke(.white.opacity(0.3), lineWidth: 2))
                default:
                    initialsFallback
                }
            }
        } else {
            initialsFallback
        }
    }

    private var initialsFallback: some View {
        ZStack {
            Circle()
                .fill(LinearGradient(
                    colors: [color, color.opacity(0.7)],
                    startPoint: .topLeading, endPoint: .bottomTrailing
                ))
                .frame(width: size, height: size)
            Text(user.initials)
                .font(.system(size: size * 0.35, weight: .bold))
                .foregroundStyle(.white)
        }
    }

    private func upload(_ image: UIImage) async {
        uploading = true
        defer { uploading = false }

        // Center-crop to square and downscale to 600px
        let cropped = image.squareCenterCrop(outputSize: 600)
        guard let jpegData = cropped.jpegData(compressionQuality: 0.8) else {
            errorMsg = "Error al procesar la imagen"
            showError = true
            return
        }

        do {
            _ = try await api.uploadAvatar(imageData: jpegData)
        } catch {
            errorMsg = error.localizedDescription
            showError = true
        }
    }
}

// MARK: - UIImagePickerController wrapper (reliable for ALL photo formats)

struct ImagePicker: UIViewControllerRepresentable {
    var onPick: (UIImage) -> Void

    func makeUIViewController(context: Context) -> UIImagePickerController {
        let picker = UIImagePickerController()
        picker.sourceType = .photoLibrary
        picker.allowsEditing = true  // Built-in square crop editor
        picker.delegate = context.coordinator
        return picker
    }

    func updateUIViewController(_ vc: UIImagePickerController, context: Context) {}

    func makeCoordinator() -> Coordinator { Coordinator(onPick: onPick) }

    class Coordinator: NSObject, UIImagePickerControllerDelegate, UINavigationControllerDelegate {
        let onPick: (UIImage) -> Void
        init(onPick: @escaping (UIImage) -> Void) { self.onPick = onPick }

        func imagePickerController(_ picker: UIImagePickerController,
                                   didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]) {
            // Prefer the edited (cropped) image, fall back to original
            let image = (info[.editedImage] as? UIImage) ?? (info[.originalImage] as? UIImage)
            picker.dismiss(animated: true)
            if let image { onPick(image) }
        }

        func imagePickerControllerDidCancel(_ picker: UIImagePickerController) {
            picker.dismiss(animated: true)
        }
    }
}

// MARK: - UIImage center crop

extension UIImage {
    func squareCenterCrop(outputSize: CGFloat) -> UIImage {
        let side = min(size.width, size.height)
        let x = (size.width - side) / 2
        let y = (size.height - side) / 2
        let outSide = min(outputSize, side)

        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        return UIGraphicsImageRenderer(
            size: CGSize(width: outSide, height: outSide), format: format
        ).image { _ in
            // draw() normalizes orientation automatically
            draw(in: CGRect(
                x: -x * (outSide / side),
                y: -y * (outSide / side),
                width: size.width * (outSide / side),
                height: size.height * (outSide / side)
            ))
        }
    }
}
