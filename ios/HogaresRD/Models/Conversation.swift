import Foundation

// MARK: - Message

struct ConvMessage: Codable, Identifiable {
    let id:         String
    let senderId:   String
    let senderRole: String
    let senderName: String
    let text:       String
    let timestamp:  String
}

// MARK: - Conversation

struct Conversation: Codable, Identifiable {
    let id:            String
    let propertyId:    String
    let propertyTitle: String
    let propertyImage: String?
    let clientId:      String
    let clientName:    String
    let brokerId:      String?
    let brokerName:    String?
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
    let archived:      Bool?
    let archivedAt:    String?
    let archivedBy:    String?
}

// MARK: - Response wrappers

struct ConversationResponse: Decodable {
    let conversation: Conversation
}

struct SendMessageResponse: Decodable {
    let message: ConvMessage
}
