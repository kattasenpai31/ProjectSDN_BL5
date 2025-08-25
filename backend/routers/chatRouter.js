const express = require("express");
const { authMiddleware } = require("../middlewares/auth.middleware");
const chatController = require("../controllers/chatController");

const chatRouter = express.Router();

// Apply authentication middleware to all chat routes
chatRouter.use(authMiddleware);

// Get all conversations for the current user
chatRouter.get("/conversations", chatController.getConversations);

chatRouter.get(
  "/conversations/:conversationId",
  chatController.getConversationById
);

// Get messages for a specific conversation
chatRouter.get(
  "/conversations/:conversationId/messages",
  chatController.getMessages
);

// Find or create a conversation with another user
chatRouter.get(
  "/conversations/user/:recipientId",
  chatController.findOrCreateConversation
);

// Add a new message to a conversation
chatRouter.post("/messages", chatController.addMessage);
// Delete a message
chatRouter.delete("/messages/:messageId", chatController.deleteMessage);

// Edit a message
chatRouter.put("/messages/:messageId", chatController.editMessage);

// Search messages in a conversation
chatRouter.get(
  "/conversations/:conversationId/search",
  chatController.searchMessages
);

// Delete a conversation
chatRouter.delete(
  "/conversations/:conversationId",
  chatController.deleteConversation
);

module.exports = chatRouter;
