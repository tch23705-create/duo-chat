const socket = io();
const $ = (id) => document.getElementById(id);

const chat = $("chat");
const modal = $("modal");
const nameInput = $("name");
const roomInput = $("roomCode");
const passInput = $("password");
const joinBtn = $("join");

const roomInfo = $("roomInfo");
const members = $("members");

const text = $("text");
const sendBtn = $("send");

const btnImage = $("btnImage");
const pickImage = $("pickImage");
const btnRecord = $("btnRecord");

let state = {
  joined: false,
  roomCode: "",
  password: "",
  name: "",
};

function loadLocal() {
  state.name = localStorage.getItem("duo_name") || "";
  state.roomCode = localStorage.getItem("duo_room") || "";
  state.password = localStorage.getItem("duo_pass") || "";
  nameInput.value = state.name;
  roomInput.value = state.roomCode;
  passInput.value = state.password;
}
loadLocal();

function saveLocal() {
  localStorage.setItem("duo_name", state.name);
  localStorage.setItem("duo_room", state.roomCode);
  localStorage.setItem("duo_pass", state.password);
}

function fmtTime(ts) {
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function escapeHtml(str) {
  return String(str)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function isMine(msg) {
  return msg.name === state.name;
}

function appendMsg(msg) {
  const wrap = document.createElement("div");
  wrap.className = `row ${isMine(msg) ? "mine" : "theirs"}`;

  const bubble = document.createElement("div");
  bubble.className = "bubble";

  const meta = document.createElement("div");
  meta.className = "meta";
  meta.textContent = `${msg.name} · ${fmtTime(msg.ts)}`;

  const body = document.createElement("div");
  body.className = "body";

  if (msg.type === "text") {
    body.innerHTML = escapeHtml(msg.text).replace(/\n/g, "<br>");
  } else if (msg.type === "image") {
    body.innerHTML = `<img class="img" src="${msg.url}" alt="image" />`;
  } else if (msg.type === "audio") {
    body.innerHTML = `<audio class="audio" controls src="${msg.url}"></audio>`;
  }

  bubble.appendChild(meta);
  bubble.appendChild(body);
  wrap.appendChild(bubble);
  chat.appendChild(wrap);

  chat.scrollTop = chat.scrollHeight;
}

function clearChat() {
  chat.innerHTML = "";
}

function openModal() {
  modal.classList.add("show");
}

function closeModal() {
  modal.classList.remove("show");
}

function joinRoom() {
  state.name = (nameInput.value || "").trim().slice(0, 20);
  state.roomCode = (roomInput.value || "").trim().toUpperCase().slice(0, 20);
  state.password = (passInput.value || "").trim().slice(0, 64);

  if (!state.name || !state.roomCode || !state.password) {
    alert("请填写昵称、房间码、房间密码");
    return;
  }

  saveLocal();

  socket.emit("join_room", {
    name: state.name,
    roomCode: state.roomCode,
    password: state.password,
  });
}

joinBtn.addEventListener("click", joinRoom);

socket.on("join_result", (r) => {
  if (!r.ok) {
    alert(r.reason || "加入失败");
    return;
  }
  state.joined = true;
  roomInfo.textContent = `房间：${state.roomCode}`;
  closeModal();
});

socket.on("history", (history) => {
  clearChat();
  (history || []).forEach(appendMsg);
});

socket.on("new_message", (msg) => {
  appendMsg(msg);
});

socket.on("presence", ({ members: list }) => {
  const count = (list || []).length;
  members.textContent = `${count}/2`;
});

// 发送文本
function sendText() {
  if (!state.joined) return openModal();
  const t = (text.value || "").trim();
  if (!t) return;
  socket.emit("send_text", { text: t });
  text.value = "";
  text.style.height = "auto";
}

sendBtn.addEventListener("click", sendText);

text.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendText();
  }
});

text.addEventListener("input", () => {
  text.style.height = "auto";
  text.style.height = Math.min(text.scrollHeight, 120) + "px";
});

// 图片上传
btnImage.addEventListener("click", () => pickImage.click());

pickImage.addEventListener("change", async () => {
  if (!state.joined) return openModal();
  const file = pickImage.files && pickImage.files[0];
  if (!file) return;

  if (!file.type.startsWith("image/")) {
    alert("请选择图片文件");
    return;
  }

  const url = await uploadFile(file, "image");
  if (url) socket.emit("send_media", { type: "image", url });

  pickImage.value = "";
});

// 语音录制
let mediaRecorder = null;
let chunks = [];
let recording = false;

btnRecord.addEventListener("click", async () => {
  if (!state.joined) return openModal();

  if (!recording) {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      chunks = [];
      mediaRecorder = new MediaRecorder(stream);

      mediaRecorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) chunks.push(e.data);
      };

      mediaRecorder.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());

        const blob = new Blob(chunks, { type: mediaRecorder.mimeType || "audio/webm" });
        const file = new File([blob], `voice_${Date.now()}.webm`, { type: blob.type });

        const url = await uploadFile(file, "audio");
        if (url) socket.emit("send_media", { type: "audio", url });
      };

      mediaRecorder.start();
      recording = true;
      btnRecord.classList.add("recording");
      btnRecord.textContent = "⏹️";
    } catch (e) {
      alert("无法使用麦克风：请允许权限，并确保是 HTTPS 环境");
    }
    return;
  }

  if (mediaRecorder && mediaRecorder.state !== "inactive") {
    mediaRecorder.stop();
  }
  recording = false;
  btnRecord.classList.remove("recording");
  btnRecord.textContent = "🎙️";
});

async function uploadFile(file, type) {
  try {
    const fd = new FormData();
    fd.append("file", file);
    fd.append("type", type);
    fd.append("roomCode", state.roomCode);
    fd.append("password", state.password);
    fd.append("name", state.name);

    const resp = await fetch("/api/upload", {
      method: "POST",
      body: fd,
    });

    const data = await resp.json().catch(() => ({}));
    if (!resp.ok || !data.ok) {
      alert(`上传失败：${data.error || resp.status}`);
      return null;
    }
    return data.url;
  } catch (e) {
    alert("上传失败：网络或服务器错误");
    return null;
  }
}
