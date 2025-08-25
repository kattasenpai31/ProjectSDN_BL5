const socketIO = require("socket.io");
const jwt = require("jsonwebtoken");
const { User, Message, Conversation } = require("../models");
const logger = require("../utils/logger");

// Map to store online users: { userId: socketId }
const onlineUsers = new Map();

// Initialize Socket.IO server
const initSocketServer = (server) => {
  const io = socketIO(server, {
    cors: {
      origin: process.env.CLIENT_URL || "http://localhost:3000",
      methods: ["GET", "POST"],
      credentials: true,
    },
    transports: ["websocket", "polling"],
  });

  // Authentication middleware for Socket.IO
  io.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth.token;

      if (!token) {
        return next(new Error("Authentication error: Token not provided"));
      }

      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      socket.user = decoded;
      next();
    } catch (error) {
      logger.error("Socket authentication error:", error);
      next(new Error("Authentication error: Invalid token"));
    }
  });

  // Connection handler
  io.on("connection", (socket) => {
    const userId = socket.user.id;
    logger.info(`User connected: ${userId}`);

    // Add user to online users map
    onlineUsers.set(userId, socket.id);

    // Broadcast user online status
    io.emit("userStatus", { userId, status: "online" });

    // Handle join conversation
    socket.on("joinConversation", (conversationId) => {
      socket.join(conversationId);
      logger.info(`User ${userId} joined conversation ${conversationId}`);
    });

    // Handle leave conversation
    socket.on("leaveConversation", (conversationId) => {
      socket.leave(conversationId);
      logger.info(`User ${userId} left conversation ${conversationId}`);
    });

    // Handle new message
    socket.on("sendMessage", async (messageData) => {
      try {
        const { recipientId, content, conversationId, image } = messageData;

        // Create new message
        const messagePayload = {
          sender: userId,
          recipient: recipientId,
          conversationId,
          read: false,
        };

        // Add content if provided
        if (content) {
          messagePayload.content = content;
        }

        // Add image if provided
        if (image) {
          messagePayload.image = {
            public_id: image.public_id,
            url: image.url,
            secure_url: image.secure_url,
          };
        }

        const newMessage = new Message(messagePayload);

        await newMessage.save();
        await newMessage.populate("sender", "username fullname avatarURL");

        // Update or create conversation
        let conversation = await Conversation.findById(conversationId);

        if (!conversation) {
          // This should not happen normally, but just in case
          conversation = new Conversation({
            _id: conversationId,
            participants: [userId, recipientId],
            lastMessage: newMessage._id,
            unreadCount: new Map([[recipientId, 1]]),
          });
        } else {
          // Update last message
          conversation.lastMessage = newMessage._id;

          // Increment unread count for recipient
          const currentCount = conversation.unreadCount.get(recipientId) || 0;
          conversation.unreadCount.set(recipientId, currentCount + 1);
        }

        await conversation.save();

        // Emit message to conversation room
        io.to(conversationId).emit("newMessage", newMessage);

        // Notify recipient if they're not in the conversation room
        const recipientSocketId = onlineUsers.get(recipientId);
        if (recipientSocketId) {
          io.to(recipientSocketId).emit("messageNotification", {
            message: newMessage,
            conversationId,
          });
        }
      } catch (error) {
        logger.error("Error sending message:", error);
        socket.emit("messageError", { message: "Failed to send message" });
      }
    });

    // Handle read receipts
    socket.on("markAsRead", async ({ conversationId, messageIds }) => {
      try {
        await Message.updateMany({ _id: { $in: messageIds } }, { read: true });

        // Update conversation unread count
        const conversation = await Conversation.findById(conversationId);
        if (conversation) {
          conversation.unreadCount.set(userId, 0);
          await conversation.save();
        }

        // Emit read receipt to conversation
        io.to(conversationId).emit("messagesRead", {
          reader: userId,
          messageIds,
        });
      } catch (error) {
        logger.error("Error marking messages as read:", error);
      }
    });

    // Handle user typing status
    socket.on("typing", ({ conversationId, isTyping }) => {
      socket.to(conversationId).emit("userTyping", {
        userId,
        isTyping,
      });
    });

    socket.on("addReaction", async ({ messageId, emoji }) => {
      try {
        const message = await Message.findById(messageId);
        if (!message) {
          return socket.emit("reactionError", { message: "Message not found" });
        }

        // Check if user already reacted with this emoji
        const existingReaction = message.reactions.find(
          (r) => r.user.toString() === userId && r.emoji === emoji
        );

        if (existingReaction) {
          // Remove existing reaction
          message.reactions = message.reactions.filter(
            (r) => !(r.user.toString() === userId && r.emoji === emoji)
          );
        } else {
          // Add new reaction
          message.reactions.push({
            user: userId,
            emoji,
            createdAt: new Date(),
          });
        }

        await message.save();
        await message.populate("reactions.user", "username fullname avatarURL");

        // Emit reaction update to conversation
        io.to(message.conversationId).emit("reactionUpdate", {
          messageId,
          reactions: message.reactions,
        });
      } catch (error) {
        logger.error("Error handling reaction:", error);
        socket.emit("reactionError", { message: "Failed to add reaction" });
      }
    });

    socket.on("editMessage", async ({ messageId, content }) => {
      try {
        const message = await Message.findById(messageId);
        if (!message) {
          return socket.emit("editError", { message: "Message not found" });
        }

        if (message.sender.toString() !== userId) {
          return socket.emit("editError", {
            message: "You can only edit your own messages",
          });
        }

        message.content = content;
        message.edited = true;
        message.editedAt = new Date();
        await message.save();
        await message.populate("sender", "username fullname avatarURL");

        // Emit edited message to conversation
        io.to(message.conversationId).emit("messageEdited", message);
      } catch (error) {
        logger.error("Error editing message:", error);
        socket.emit("editError", { message: "Failed to edit message" });
      }
    });

    socket.on("deleteMessage", async ({ messageId }) => {
      try {
        const message = await Message.findById(messageId);
        if (!message) {
          return socket.emit("deleteError", { message: "Message not found" });
        }

        if (message.sender.toString() !== userId) {
          return socket.emit("deleteError", {
            message: "You can only delete your own messages",
          });
        }

        message.deleted = true;
        message.content = "This message has been deleted";
        message.image = null;
        message.file = null;
        await message.save();

        // Emit deleted message to conversation
        io.to(message.conversationId).emit("messageDeleted", {
          messageId,
          deletedBy: userId,
        });
      } catch (error) {
        logger.error("Error deleting message:", error);
        socket.emit("deleteError", { message: "Failed to delete message" });
      }
    });

    // Handle disconnect
    socket.on("disconnect", () => {
      logger.info(`User disconnected: ${userId}`);

      // Remove user from online users map
      onlineUsers.delete(userId);

      // Broadcast user offline status
      io.emit("userStatus", { userId, status: "offline" });
    });
  });

  return io;
};

module.exports = { initSocketServer };
