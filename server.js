const crypto = require("crypto");
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");
const { PrismaClient } = require("@prisma/client");

const app = express();
const server = http.createServer(app);
const db = new PrismaClient();
const io = new Server(server, {
  cors: { origin: "*" },
  transports: ["polling", "websocket"],
});

const PORT = process.env.PORT || 3000;

const rooms = new Map();
const users = new Map();
const DEFAULT_ROOMS = ["general", "random", "help"];

function generateKey() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.randomBytes(6);
  let key = "";
  for (let i = 0; i < 6; i += 1) {
    key += chars[bytes[i] % chars.length];
  }
  return key;
}

function identity(name) {
  return String(name || "").trim().toLowerCase();
}

function createRoom(name, locked, data = {}) {
  if (rooms.has(name)) return rooms.get(name);
  const room = {
    name,
    id: data.id || null,
    messages: data.messages || [],
    members: new Set(),
    admitted: new Set(data.admitted || []),
    locked: Boolean(locked),
    key: data.key || (locked ? generateKey() : null),
  };
  rooms.set(name, room);
  return room;
}

async function saveRoom(room) {
  const saved = await db.room.upsert({
    where: { name: room.name },
    update: { locked: room.locked, key: room.key },
    create: { name: room.name, locked: room.locked, key: room.key },
  });
  room.id = saved.id;
  return saved;
}

async function initializeDatabase() {
  for (const name of DEFAULT_ROOMS) {
    await db.room.upsert({
      where: { name },
      update: {},
      create: { name, locked: false },
    });
  }

  const savedRooms = await db.room.findMany({
    include: {
      members: true,
      messages: { orderBy: { createdAt: "asc" }, take: 200 },
    },
  });

  savedRooms.forEach((saved) => {
    createRoom(saved.name, saved.locked, {
      id: saved.id,
      key: saved.key,
      admitted: saved.members.map((member) => member.username),
      messages: saved.messages.map((message) => ({
        id: message.id,
        user: message.userName,
        text: message.text,
        time: message.createdAt.getTime(),
      })),
    });
  });
}

function publicRooms() {
  return Array.from(rooms.values()).map((room) => ({
    name: room.name,
    count: room.members.size,
    locked: Boolean(room.locked),
  }));
}

function roomMembers(name) {
  const room = rooms.get(name);
  if (!room) return [];
  return Array.from(room.members).map((id) => {
    const user = users.get(id);
    return { id, name: user ? user.name : "Unknown" };
  });
}

function notify(target, payload) {
  const note = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    time: Date.now(),
    ...payload,
  };
  if (typeof target === "string") io.to(target).emit("notify", note);
  else target.emit("notify", note);
  return note;
}

function leaveCurrentRoom(socket) {
  const previous = users.get(socket.id);
  if (!previous) return;
  const oldRoom = rooms.get(previous.room);
  socket.leave(previous.room);
  if (!oldRoom) return;
  oldRoom.members.delete(socket.id);
  io.to(previous.room).emit("system", {
    text: `${previous.name} left the room`,
    time: Date.now(),
  });
  io.to(previous.room).emit("members", roomMembers(previous.room));
  notify(previous.room, {
    type: "leave",
    title: `#${previous.room}`,
    text: `${previous.name} left the room`,
    room: previous.room,
  });
}

async function enterRoom(socket, username, room, isReturning) {
  users.set(socket.id, { name: username, room: room.name });
  room.members.add(socket.id);
  room.admitted.add(identity(username));
  await db.roomMember.upsert({
    where: { roomId_username: { roomId: room.id, username: identity(username) } },
    update: {},
    create: { roomId: room.id, username: identity(username) },
  });
  socket.join(room.name);

  socket.emit("joined", {
    name: username,
    room: room.name,
    messages: room.messages.slice(-100),
    members: roomMembers(room.name),
    key: room.key,
    locked: room.locked,
    returning: Boolean(isReturning),
    admittedRooms: Array.from(rooms.values())
      .filter((item) => item.admitted.has(identity(username)))
      .map((item) => item.name),
  });

  if (!isReturning) {
    socket.to(room.name).emit("system", {
      text: `${username} joined the room`,
      time: Date.now(),
    });
    notify(room.name, {
      type: "join",
      title: `#${room.name}`,
      text: `${username} joined the room`,
      room: room.name,
    });
  } else {
    socket.to(room.name).emit("system", {
      text: `${username} is back`,
      time: Date.now(),
    });
    notify(room.name, {
      type: "join",
      title: `#${room.name}`,
      text: `${username} is back`,
      room: room.name,
    });
  }

  io.to(room.name).emit("members", roomMembers(room.name));
  io.emit("rooms", publicRooms());
}

app.use((req, res, next) => {
  res.set("Cache-Control", "no-store, no-cache, must-revalidate");
  res.set("Pragma", "no-cache");
  next();
});

app.use(express.static(path.join(__dirname, "public"), {
  etag: false,
  lastModified: false,
  cacheControl: false,
}));

io.on("connection", (socket) => {
  socket.emit("rooms", publicRooms());

  socket.on("join", async ({ name, room, key }) => {
    const username = String(name || "").trim().slice(0, 24);
    const roomName = String(room || "general").trim().slice(0, 32) || "general";
    if (!username) {
      socket.emit("error_message", "Please enter a name.");
      return;
    }

    const current = rooms.get(roomName);
    if (!current) {
      socket.emit("error_message", "Room does not exist.");
      return;
    }

    const alreadyMember = current.admitted.has(identity(username));
    if (current.locked && !alreadyMember) {
      const provided = String(key || "").trim().toUpperCase();
      if (provided !== current.key) {
        socket.emit("error_message", "New members need the room key. Ask a current member.");
        return;
      }
    }

    leaveCurrentRoom(socket);
    await enterRoom(socket, username, current, alreadyMember);
  });

  socket.on("message", async (text) => {
    const user = users.get(socket.id);
    if (!user) return;
    const body = String(text || "").trim().slice(0, 2000);
    if (!body) return;
    const message = {
      id: `${Date.now()}-${socket.id}`,
      user: user.name,
      selfId: socket.id,
      text: body,
      time: Date.now(),
    };
    const room = rooms.get(user.room);
    if (room) {
      room.messages.push(message);
      if (room.messages.length > 200) room.messages.shift();
      await db.message.create({
        data: {
          id: message.id,
          roomId: room.id,
          userName: message.user,
          text: message.text,
          createdAt: new Date(message.time),
        },
      });
    }
    io.to(user.room).emit("message", message);
    notify(user.room, {
      type: "message",
      title: `${user.name} in #${user.room}`,
      text: body,
      room: user.room,
      from: user.name,
    });
  });

  socket.on("typing", (isTyping) => {
    const user = users.get(socket.id);
    if (!user) return;
    socket.to(user.room).emit("typing", {
      name: user.name,
      typing: Boolean(isTyping),
    });
  });

  socket.on("create_room", async ({ name, room }) => {
    const existing = users.get(socket.id);
    const username = existing
      ? existing.name
      : String(name || "").trim().slice(0, 24);
    const roomName = String(room || "").trim().slice(0, 32);

    if (!username) {
      socket.emit("error_message", "Please enter a name first.");
      return;
    }
    if (!roomName) {
      socket.emit("error_message", "Enter a room name.");
      return;
    }
    if (rooms.has(roomName)) {
      socket.emit("error_message", "A room with that name already exists.");
      return;
    }

    const created = createRoom(roomName, true);
    await saveRoom(created);
    created.admitted.add(identity(username));
    await db.roomMember.upsert({
      where: { roomId_username: { roomId: created.id, username: identity(username) } },
      update: {},
      create: { roomId: created.id, username: identity(username) },
    });
    leaveCurrentRoom(socket);
    await enterRoom(socket, username, created, false);
    notify(socket, {
      type: "room",
      title: `Room #${roomName} created`,
      text: `Share this key with new members: ${created.key}`,
      room: roomName,
    });
  });

  socket.on("delete_room", async (name) => {
    const user = users.get(socket.id);
    if (!user) {
      socket.emit("error_message", "Join a room before deleting it.");
      return;
    }

    const roomName = String(name || user.room).trim();
    const room = rooms.get(roomName);
    if (!room) {
      socket.emit("error_message", "Room does not exist.");
      return;
    }
    if (!room.members.has(socket.id) && !room.admitted.has(identity(user.name))) {
      socket.emit("error_message", "Only members can delete this room.");
      return;
    }

    const memberIds = Array.from(room.members);
    rooms.delete(roomName);
    await db.room.delete({ where: { name: roomName } });
    memberIds.forEach((id) => {
      const memberSocket = io.sockets.sockets.get(id);
      if (memberSocket) memberSocket.leave(roomName);
      users.delete(id);
      io.to(id).emit("room_deleted", {
        name: roomName,
        text: `${user.name} deleted room #${roomName}`,
      });
      io.to(id).emit("notify", {
        id: `${Date.now()}-${id}`,
        type: "delete",
        title: `Room #${roomName} deleted`,
        text: `${user.name} deleted this room`,
        room: roomName,
        time: Date.now(),
      });
    });

    if (rooms.size === 0) createRoom("general", false);
    io.emit("rooms", publicRooms());
  });

  socket.on("disconnect", () => {
    const user = users.get(socket.id);
    if (!user) return;
    const room = rooms.get(user.room);
    if (room) {
      room.members.delete(socket.id);
      io.to(user.room).emit("system", {
        text: `${user.name} left the room`,
        time: Date.now(),
      });
      io.to(user.room).emit("members", roomMembers(user.room));
      notify(user.room, {
        type: "leave",
        title: `#${user.room}`,
        text: `${user.name} left the room`,
        room: user.room,
      });
    }
    users.delete(socket.id);
    io.emit("rooms", publicRooms());
  });
});

initializeDatabase()
  .then(() => {
    server.listen(PORT, "0.0.0.0", () => {
      console.log(`Chat app running on http://localhost:${PORT}`);
    });
  })
  .catch((error) => {
    console.error("Unable to initialize the database", error);
    process.exitCode = 1;
  });
