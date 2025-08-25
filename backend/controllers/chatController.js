const { User, Message, Conversation } = require("../models");
const logger = require("../utils/logger");

/**
 * Get all conversations for the current user
 */
const getConversations = async (req, res) => {
  try {
    const userId = req.user.id;

    const conversations = await Conversation.find({
      participants: userId,
    })
      .populate({
        path: "participants",
        select: "username fullname avatarURL",
      })
      .populate({
        path: "lastMessage",
        select: "content createdAt sender",
      })
      .sort({ updatedAt: -1 });

    // Format response to include participant details (excluding current user)
    const formattedConversations = conversations.map((conv) => {
      const otherParticipant = conv.participants.find(
        (p) => p._id.toString() !== userId
      );

      return {
        _id: conv._id,
        participant: otherParticipant,
        lastMessage: conv.lastMessage,
        unreadCount: conv.unreadCount.get(userId.toString()) || 0,
        updatedAt: conv.updatedAt,
      };
    });

    return res.status(200).json({
      success: true,
      conversations: formattedConversations,
    });
  } catch (error) {
    logger.error("Error fetching conversations:", error);
    return res.status(500).json({
      success: false,
      message: "Error fetching conversations",
    });
  }
};
// Get a specific conversation by ID
const getConversationById = async (req, res) => {
  try {
    const { conversationId } = req.params;
    const userId = req.user.id;

    const conversation = await Conversation.findById(conversationId)
      .populate("participants", "username fullname avatarURL")
      .populate("lastMessage", "content createdAt sender");

    if (!conversation) {
      return res
        .status(404)
        .json({ success: false, message: "Conversation not found" });
    }

    // Kiểm tra quyền truy cập
    if (!conversation.participants.some((p) => p._id.toString() === userId)) {
      return res
        .status(403)
        .json({ success: false, message: "You do not have access" });
    }

    return res.status(200).json({ success: true, conversation });
  } catch (error) {
    logger.error("Error fetching conversation:", error);
    return res
      .status(500)
      .json({ success: false, message: "Error fetching conversation" });
  }
};

/**
 * Get all messages for a specific conversation
 */
const getMessages = async (req, res) => {
  try {
    const { conversationId } = req.params;
    const userId = req.user.id;

    // Check if conversation exists and user is a participant
    const conversation = await Conversation.findById(conversationId);
    if (!conversation) {
      return res.status(404).json({
        success: false,
        message: "Conversation not found",
      });
    }

    if (!conversation.participants.includes(userId)) {
      return res.status(403).json({
        success: false,
        message: "You do not have access to this conversation",
      });
    }

    // Get messages paginated
    const page = Number.parseInt(req.query.page) || 1;
    const limit = Number.parseInt(req.query.limit) || 20;
    const skip = (page - 1) * limit;

    const messages = await Message.find({
      conversationId,
    })
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate({
        path: "sender",
        select: "username fullname avatarURL",
      });

    // Mark messages as read
    await Message.updateMany(
      {
        conversationId,
        recipient: userId,
        read: false,
      },
      { read: true }
    );

    // Reset unread count for this user
    conversation.unreadCount.set(userId.toString(), 0);
    await conversation.save();

    return res.status(200).json({
      success: true,
      messages: messages.reverse(),
    });
  } catch (error) {
    logger.error("Error fetching messages:", error);
    return res.status(500).json({
      success: false,
      message: "Error fetching messages",
    });
  }
};

/**
 * Find or create a conversation with another user
 */
const findOrCreateConversation = async (req, res) => {
  try {
    const userId = req.user.id;
    const { recipientId } = req.params;

    // Validate recipient exists
    const recipient = await User.findById(recipientId);
    if (!recipient) {
      return res.status(404).json({
        success: false,
        message: "Recipient user not found",
      });
    }

    // Find existing conversation
    const conversation = await Conversation.findOne({
      participants: { $all: [userId, recipientId] },
    }).populate({
      path: "participants",
      select: "username fullname avatarURL",
    });

    if (conversation) {
      return res.status(200).json({
        success: true,
        conversation,
      });
    }

    // Create new conversation
    const newConversation = await Conversation.create({
      participants: [userId, recipientId],
      unreadCount: new Map([
        [recipientId, 0],
        [userId, 0],
      ]),
    });

    await newConversation.populate({
      path: "participants",
      select: "username fullname avatarURL",
    });

    return res.status(201).json({
      success: true,
      conversation: newConversation,
    });
  } catch (error) {
    logger.error("Error creating conversation:", error);
    return res.status(500).json({
      success: false,
      message: "Error creating conversation",
    });
  }
};

const addMessage = async (req, res) => {
  try {
    const { conversationId, content, image } = req.body;
    const userId = req.user.id;

    // Validate: ít nhất phải có content hoặc image
    if ((!content || content.trim().length === 0) && !image) {
      return res.status(400).json({
        success: false,
        message: "Message must have text or an image",
      });
    }

    // Tìm conversation
    const conversation = await Conversation.findById(conversationId);
    if (!conversation) {
      return res
        .status(404)
        .json({ success: false, message: "Conversation not found" });
    }

    if (!conversation.participants.includes(userId)) {
      return res
        .status(403)
        .json({ success: false, message: "No access to this conversation" });
    }

    // Xác định recipient
    const recipientId = conversation.participants.find(
      (p) => p.toString() !== userId
    );

    // Tạo message mới
    const message = await Message.create({
      sender: userId,
      recipient: recipientId,
      conversationId,
      content: content?.trim() || "",
      image: image || null, // image là object {public_id, url, secure_url}
      createdAt: new Date(),
    });

    // Cập nhật lastMessage & unreadCount
    conversation.lastMessage = message._id;
    conversation.participants.forEach((p) => {
      if (p.toString() !== userId) {
        conversation.unreadCount.set(
          p.toString(),
          (conversation.unreadCount.get(p.toString()) || 0) + 1
        );
      }
    });
    await conversation.save();

    await message.populate("sender", "username fullname avatarURL");

    return res.status(201).json({ success: true, message });
  } catch (error) {
    logger.error("Error adding message:", error);
    return res
      .status(500)
      .json({ success: false, message: "Error adding message" });
  }
};

/**
 * Delete a message (soft delete - mark as deleted)
 */
const deleteMessage = async (req, res) => {
  try {
    const { messageId } = req.params;
    const userId = req.user.id;

    const message = await Message.findById(messageId);
    if (!message) {
      return res.status(404).json({
        success: false,
        message: "Message not found",
      });
    }

    // Only sender can delete their message
    if (message.sender.toString() !== userId) {
      return res.status(403).json({
        success: false,
        message: "You can only delete your own messages",
      });
    }

    message.deleted = true;
    message.content = "This message has been deleted";
    message.image = null;
    await message.save();

    return res.status(200).json({
      success: true,
      message: "Message deleted successfully",
    });
  } catch (error) {
    logger.error("Error deleting message:", error);
    return res.status(500).json({
      success: false,
      message: "Error deleting message",
    });
  }
};

/**
 * Edit a message
 */
const editMessage = async (req, res) => {
  try {
    const { messageId } = req.params;
    const { content } = req.body;
    const userId = req.user.id;

    if (!content || content.trim().length === 0) {
      return res.status(400).json({
        success: false,
        message: "Message content cannot be empty",
      });
    }

    const message = await Message.findById(messageId);
    if (!message) {
      return res.status(404).json({
        success: false,
        message: "Message not found",
      });
    }

    // Only sender can edit their message
    if (message.sender.toString() !== userId) {
      return res.status(403).json({
        success: false,
        message: "You can only edit your own messages",
      });
    }

    message.content = content.trim();
    message.edited = true;
    message.editedAt = new Date();
    await message.save();

    await message.populate("sender", "username fullname avatarURL");

    return res.status(200).json({
      success: true,
      message: message,
    });
  } catch (error) {
    logger.error("Error editing message:", error);
    return res.status(500).json({
      success: false,
      message: "Error editing message",
    });
  }
};

/**
 * Search messages in a conversation
 */
const searchMessages = async (req, res) => {
  try {
    const { conversationId } = req.params;
    const { query } = req.query;
    const userId = req.user.id;

    if (!query || query.trim().length === 0) {
      return res.status(400).json({
        success: false,
        message: "Search query is required",
      });
    }

    // Check if user has access to this conversation
    const conversation = await Conversation.findById(conversationId);
    if (!conversation || !conversation.participants.includes(userId)) {
      return res.status(403).json({
        success: false,
        message: "You do not have access to this conversation",
      });
    }

    const messages = await Message.find({
      conversationId,
      content: { $regex: query, $options: "i" },
      deleted: { $ne: true },
    })
      .sort({ createdAt: -1 })
      .limit(20)
      .populate("sender", "username fullname avatarURL");

    return res.status(200).json({
      success: true,
      messages,
    });
  } catch (error) {
    logger.error("Error searching messages:", error);
    return res.status(500).json({
      success: false,
      message: "Error searching messages",
    });
  }
};

/**
 * Delete a conversation
 */
const deleteConversation = async (req, res) => {
  try {
    const { conversationId } = req.params;
    const userId = req.user.id;

    const conversation = await Conversation.findById(conversationId);
    if (!conversation) {
      return res.status(404).json({
        success: false,
        message: "Conversation not found",
      });
    }

    if (!conversation.participants.includes(userId)) {
      return res.status(403).json({
        success: false,
        message: "You do not have access to this conversation",
      });
    }

    await Message.deleteMany({ conversationId });
    await Conversation.findByIdAndDelete(conversationId);

    return res.status(200).json({
      success: true,
      message: "Conversation deleted successfully",
    });
  } catch (error) {
    logger.error("Error deleting conversation:", error);
    return res.status(500).json({
      success: false,
      message: "Error deleting conversation",
    });
  }
};

module.exports = {
  getConversations,
  getConversationById,
  addMessage,
  getMessages,
  findOrCreateConversation,
  deleteMessage,
  editMessage,
  searchMessages,
  deleteConversation,
};
