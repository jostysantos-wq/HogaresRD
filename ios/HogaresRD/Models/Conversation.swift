import Foundation

// MARK: - Message

struct ConvMessage: Codable, Identifiable {
    let id:           String
    let senderId:     String
    let senderRole:   String
    let senderName:   String
    let senderAvatar: String?
    let text:         String
    let timestamp:    String

    /// Resolved avatar URL (handles relative server paths)
    var senderAvatarURL: URL? {
        guard let av = senderAvatar, !av.isEmpty else { return nil }
        if av.hasPrefix("http") { return URL(string: av) }
        return URL(string: "\(APIService.baseURL)\(av)")
    }
}

// MARK: - Conversation

struct Conversation: Codable, Identifiable {
    let id:            String
    let propertyId:    String
    let propertyTitle: String
    let propertyImage: String?
    let clientId:      String
    let clientName:    String
    let clientAvatar:  String?
    let brokerId:      String?
    let brokerName:    String?
    let brokerAvatar:  String?
    let createdAt:     String
    let updatedAt:     String
    let lastMessage:   String?
    let unreadBroker:  Int?
    let unreadClient:  Int?
    let messageCount:  Int?
    let messages:      [ConvMessage]?
    let closed:        Bool?
    let closedAt:      String?
    let closedBy:      String?
    let closedByName:  String?
    let closedByRole:  String?
    let closedReason:  String?
    let archived:       Bool?
    let archivedAt:     String?
    let archivedBy:     String?
    let claimRequired:  Bool?
    let inmobiliariaId: String?

    /// Avatar URL of the other party (for the current user to display)
    func otherPartyAvatarURL(myId: String) -> URL? {
        let av = clientId == myId ? brokerAvatar : clientAvatar
        guard let av, !av.isEmpty else { return nil }
        if av.hasPrefix("http") { return URL(string: av) }
        return URL(string: "\(APIService.baseURL)\(av)")
    }
}

// MARK: - Response wrappers

struct ConversationResponse: Decodable {
    let conversation: Conversation
}

struct SendMessageResponse: Decodable {
    let message: ConvMessage
}
