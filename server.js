const express = require("express");
const http = require("http");
const path = require("path");
const fs = require("fs");
const multer = require("multer");
const { Server } = require("socket.io");
const { v4: uuidv4 } = require("uuid");

const PORT = process.env.PORT || 3000;

const DATA_DIR = path.join(__dirname, "data");
const ROOMS_FILE = path.join(DATA_DIR, "rooms.json");
const UPLOAD_DIR = path.join(__dirname, "uploads");
const PUBLIC_DIR = path.join(__dirname, "public");

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

function safeReadRooms() {
  try {
    const raw = fs.readFileSync(ROOMS_FILE, "utf-8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}
function safeWriteRooms(rooms) {
  try {
    fs.writeFileSync(ROOMS_FILE, JSON.stringify(rooms, null, 2), "utf-8");
  } catch (e) {
    console.error("write rooms failed:", e);
  }
}

const app = express();
app.use(express.json());
app.use(express.static(PUBLIC_DIR));
app.use("/uploads", express.static(UPLOAD_DIR));

const server = http.createServer(app);
const io = new Server(server);

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname || "");
    cb(null, `${Date.now()}_${uuidv4()}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 15 * 1024 * 1024 }, // 15MB
});

let rooms = safeReadRooms();
// rooms结构：
// {
//   "ROOMCODE": {
//     password: "xxx",
//     messages: [{id,type,name,text,url,ts}],
//     createdAt: 123
//   }
// }

function normalizeRoomCode(code) {
  return String(code || "").trim().toUpperCase().slice(0, 20);
}
function cleanText(s, max = 500) {
  return String(s || "").trim().slice(0, max);
}
function canJoinRoom(roomCode) {
  const room = io.sockets.adapter.rooms.get(roomCode);
  const size = room ? room.size : 0;
  return size < 2;
}

app.post("/api/upload", upload.single("file"), (req, res) => {
  try {
    const roomCode = normalizeRoomCode(req.body.roomCode);
    const password = cleanText(req.body.password, 64);
    const name = cleanText(req.body.name, 20);
    const type = cleanText(req.body.type, 10); // "image" | "audio"

    if (!roomCode || !password || !name) return res.status(400).json({ ok: false, error: "missing_fields" });
    if (!req.file) return res.status(400).json({ ok: false, error: "no_file" });
    if (!["image", "audio"].includes(type)) return res.status(400).json({ ok: false, error: "bad_type" });

    if (!rooms[roomCode]) return res.status(404).json({ ok: false, error: "room_not_found" });
    if (rooms[roomCode].password !== password) return res.status(403).json({ ok: false, error: "bad_password" });

    const url = `/uploads/${req.file.filename}`;
    return res.json({ ok: true, url });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: "upload_failed" });
  }
});

io.on("connection", (socket) => {
  socket.on("join_room", ({ roomCode, password, name }) => {
    const code = normalizeRoomCode(roomCode);
    const pass = cleanText(password, 64);
    const nick = cleanText(name, 20);

    if (!code || !pass || !nick) {
      socket.emit("join_result", { ok: false, reason: "请输入房间码/密码/昵称" });
      return;
    }

    // 第一个人进入 => 创建房间并设置密码
    if (!rooms[code]) {
      rooms[code] = { password: pass, messages: [], createdAt: Date.now() };
      safeWriteRooms(rooms);
    }

    // 密码不一致 => 拒绝
    if (rooms[code].password !== pass) {
      socket.emit("join_result", { ok: false, reason: "密码不正确" });
      return;
    }

    // 只允许2个人在线
    if (!canJoinRoom(code)) {
      socket.emit("join_result", { ok: false, reason: "房间已满（最多2人）" });
      return;
    }

    socket.data.roomCode = code;
    socket.data.name = nick;
    socket.join(code);

    socket.emit("join_result", { ok: true, roomCode: code, name: nick });

    const history = rooms[code].messages.slice(-200);
    socket.emit("history", history);

    io.to(code).emit("presence", { members: getRoomMembers(code) });
  });

  socket.on("send_text", ({ text }) => {
    const code = socket.data.roomCode;
    const name = socket.data.name;
    if (!code || !name) return;

    const t = cleanText(text, 500);
    if (!t) return;

    const msg = {
      id: uuidv4(),
      type: "text",
      name,
      text: t,
      ts: Date.now(),
    };

    rooms[code].messages.push(msg);
    if (rooms[code].messages.length > 500) rooms[code].messages = rooms[code].messages.slice(-500);
    safeWriteRooms(rooms);

    io.to(code).emit("new_message", msg);
  });

  socket.on("send_media", ({ type, url }) => {
    const code = socket.data.roomCode;
    const name = socket.data.name;
    if (!code || !name) return;

    if (!["image", "audio"].includes(type)) return;
    const u = cleanText(url, 300);
    if (!u.startsWith("/uploads/")) return;

    const msg = {
      id: uuidv4(),
      type,
      name,
      url: u,
      ts: Date.now(),
    };

    rooms[code].messages.push(msg);
    if (rooms[code].messages.length > 500) rooms[code].messages = rooms[code].messages.slice(-500);
    safeWriteRooms(rooms);

    io.to(code).emit("new_message", msg);
  });

  socket.on("disconnect", () => {
    const code = socket.data.roomCode;
    if (code) io.to(code).emit("presence", { members: getRoomMembers(code) });
  });
});

function getRoomMembers(roomCode) {
  const room = io.sockets.adapter.rooms.get(roomCode);
  if (!room) return [];
  const ids = Array.from(room);
  return ids
    .map((id) => io.sockets.sockets.get(id))
    .filter(Boolean)
    .map((s) => s.data.name || "匿名");
}

server.listen(PORT, () => {
  console.log(`✅ running: http://localhost:${PORT}`);
});
