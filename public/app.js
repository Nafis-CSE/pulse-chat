const socket = io({
  transports: ["polling", "websocket"],
});

const STORAGE_NAME = "pulse.displayName";
const STORAGE_ROOMS = "pulse.admittedRooms";

const gate = document.getElementById("gate");
const app = document.getElementById("app");
const joinForm = document.getElementById("join-form");
const nameInput = document.getElementById("name-input");
const roomSelect = document.getElementById("room-select");
const keyField = document.getElementById("key-field");
const keyInput = document.getElementById("key-input");
const memberHint = document.getElementById("member-hint");
const roomList = document.getElementById("room-list");
const memberList = document.getElementById("member-list");
const messagesEl = document.getElementById("messages");
const typingEl = document.getElementById("typing");
const composer = document.getElementById("composer");
const messageInput = document.getElementById("message-input");
const roomTitle = document.getElementById("room-title");
const roomMeta = document.getElementById("room-meta");
const youLabel = document.getElementById("you-label");
const newRoomForm = document.getElementById("new-room-form");
const newRoomInput = document.getElementById("new-room-input");
const gateCreateForm = document.getElementById("gate-create-form");
const gateRoomInput = document.getElementById("gate-room-input");
const roomKeyChip = document.getElementById("room-key");
const roomKeyValue = document.getElementById("room-key-value");
const copyKeyBtn = document.getElementById("copy-key");
const deleteRoomBtn = document.getElementById("delete-room");
const toastEl = document.getElementById("toast");
const modal = document.getElementById("modal");
const modalTitle = document.getElementById("modal-title");
const modalText = document.getElementById("modal-text");
const modalInput = document.getElementById("modal-input");
const modalOk = document.getElementById("modal-ok");
const modalCancel = document.getElementById("modal-cancel");
const notifyToggle = document.getElementById("notify-toggle");
const notifyCount = document.getElementById("notify-count");
const notifyPanel = document.getElementById("notify-panel");
const notifyList = document.getElementById("notify-list");
const enableDesktop = document.getElementById("enable-desktop");
const clearNotifs = document.getElementById("clear-notifs");

let me = { name: localStorage.getItem(STORAGE_NAME) || "", room: "", id: "" };
const typingUsers = new Map();
let roomsCache = [];
let admittedRooms = loadAdmitted();
let notifications = [];
let unreadCount = 0;
let toastTimer;
let modalResolver;

if (me.name) nameInput.value = me.name;

function loadAdmitted() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_ROOMS) || "[]");
    return Array.isArray(raw) ? raw : [];
  } catch (error) {
    return [];
  }
}

function saveAdmitted() {
  localStorage.setItem(STORAGE_ROOMS, JSON.stringify(admittedRooms));
}

function rememberRoom(roomName) {
  if (!roomName) return;
  if (!admittedRooms.includes(roomName)) {
    admittedRooms.push(roomName);
    saveAdmitted();
  }
}

function forgetRoom(roomName) {
  admittedRooms = admittedRooms.filter((name) => name !== roomName);
  saveAdmitted();
}

function isAdmitted(roomName) {
  return admittedRooms.includes(roomName);
}

function timeLabel(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function showToast(text) {
  toastEl.textContent = text;
  toastEl.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.add("hidden"), 3200);
}

function closeModal(result) {
  modal.classList.add("hidden");
  modalInput.classList.add("hidden");
  modalInput.value = "";
  if (modalResolver) {
    const resolve = modalResolver;
    modalResolver = null;
    resolve(result);
  }
}

function openModal({ title, text, input, okLabel, showCancel }) {
  return new Promise((resolve) => {
    closeModal(null);
    modalResolver = resolve;
    modalTitle.textContent = title || "Notice";
    modalText.textContent = text || "";
    modalOk.textContent = okLabel || "Continue";
    modalCancel.classList.toggle("hidden", !showCancel);
    modalInput.classList.toggle("hidden", !input);
    modalInput.placeholder = input || "";
    modal.classList.remove("hidden");
    if (input) modalInput.focus();
    else modalOk.focus();
  });
}

function selectedRoom() {
  return roomsCache.find((room) => room.name === roomSelect.value);
}

function needsKey(room) {
  return Boolean(room && room.locked && !isAdmitted(room.name));
}

function toggleKeyField() {
  const room = selectedRoom();
  const lockedNew = needsKey(room);
  const returning = Boolean(room && room.locked && isAdmitted(room.name));
  keyField.classList.toggle("hidden", !lockedNew);
  keyInput.required = lockedNew;
  memberHint.classList.toggle("hidden", !returning);
  if (!lockedNew) keyInput.value = "";
}

function renderRooms(rooms) {
  roomsCache = rooms;
  const previous = roomSelect.value;
  roomSelect.innerHTML = rooms
    .map((room) => {
      let mark = "";
      if (room.locked && isAdmitted(room.name)) mark = " (member)";
      else if (room.locked) mark = " (needs key)";
      return `<option value="${escapeHtml(room.name)}">${escapeHtml(room.name)}${mark} · ${room.count}</option>`;
    })
    .join("");
  if (me.room && rooms.some((room) => room.name === me.room)) {
    roomSelect.value = me.room;
  } else if (rooms.some((room) => room.name === previous)) {
    roomSelect.value = previous;
  }
  toggleKeyField();
  roomList.innerHTML = rooms
    .map((room) => {
      const active = room.name === me.room ? "active" : "";
      let lock = "";
      if (room.locked && isAdmitted(room.name)) lock = '<span class="lock">member</span>';
      else if (room.locked) lock = '<span class="lock">key</span>';
      return `<li class="room ${active}" data-room="${escapeHtml(room.name)}" data-locked="${room.locked ? "1" : "0"}"><span># ${escapeHtml(room.name)} ${lock}</span><span class="count">${room.count}</span></li>`;
    })
    .join("");
}

function renderMembers(members) {
  memberList.innerHTML = members
    .map((member) => `<li class="member"><span>${escapeHtml(member.name)}</span><span class="dot">online</span></li>`)
    .join("");
  roomMeta.textContent = `${members.length} ${members.length === 1 ? "person" : "people"}`;
}

function addMessage(message) {
  const el = document.createElement("div");
  el.className = "bubble" + (message.user === me.name ? " me" : "");
  el.innerHTML = `
    <div class="author">${escapeHtml(message.user)}</div>
    <div>${escapeHtml(message.text)}</div>
    <div class="meta">${timeLabel(message.time)}</div>
  `;
  messagesEl.appendChild(el);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function addSystem(text, time) {
  const el = document.createElement("div");
  el.className = "bubble system";
  el.textContent = `${text} · ${timeLabel(time)}`;
  messagesEl.appendChild(el);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function updateTyping() {
  const names = Array.from(typingUsers.keys());
  if (!names.length) {
    typingEl.textContent = "";
    return;
  }
  typingEl.textContent = names.length === 1
    ? `${names[0]} is typing...`
    : `${names.join(", ")} are typing...`;
}

function showRoomKey(key, locked) {
  if (locked && key) {
    roomKeyChip.classList.remove("hidden");
    roomKeyValue.textContent = key;
  } else {
    roomKeyChip.classList.add("hidden");
    roomKeyValue.textContent = "";
  }
}

function renderNotifications() {
  notifyCount.textContent = String(unreadCount);
  notifyCount.classList.toggle("hidden", unreadCount === 0);
  if (!notifications.length) {
    notifyList.innerHTML = '<li class="notify-empty">No notifications yet</li>';
    return;
  }
  notifyList.innerHTML = notifications
    .slice(0, 40)
    .map((item) => `
      <li class="notify-item ${item.type}">
        <strong>${escapeHtml(item.title || "Pulse")}</strong>
        <span>${escapeHtml(item.text || "")}</span>
        <em>${timeLabel(item.time)}</em>
      </li>
    `)
    .join("");
}

function pushNotification(note, options = {}) {
  if (!note) return;
  if (note.from && note.from === me.name && note.type === "message") return;
  notifications.unshift(note);
  if (notifyPanel.classList.contains("hidden")) unreadCount += 1;
  renderNotifications();
  if (options.toast !== false && note.type !== "message") showToast(note.text || note.title);
  maybeDesktop(note);
}

function maybeDesktop(note) {
  if (!("Notification" in window)) return;
  if (Notification.permission !== "granted") return;
  if (document.hasFocus() && note.type === "message") return;
  try {
    const popup = new Notification(note.title || "Pulse Chat", {
      body: note.text || "",
      tag: note.id || String(note.time),
    });
    setTimeout(() => popup.close(), 4000);
  } catch (error) {
    // ignore desktop notification failures
  }
}

function resetToGate(message) {
  me = { name: me.name, room: "", id: "" };
  app.classList.add("hidden");
  gate.classList.remove("hidden");
  notifyPanel.classList.add("hidden");
  messagesEl.innerHTML = "";
  typingEl.textContent = "";
  showRoomKey("", false);
  renderRooms(roomsCache);
  if (message) showToast(message);
}

function join(name, room, key) {
  socket.emit("join", { name, room, key });
}

function createRoom(name, room) {
  socket.emit("create_room", { name, room });
}

modalOk.addEventListener("click", () => {
  const value = modalInput.classList.contains("hidden") ? true : modalInput.value.trim();
  closeModal(value);
});

modalCancel.addEventListener("click", () => closeModal(null));

modalInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    closeModal(modalInput.value.trim());
  }
});

nameInput.addEventListener("input", () => {
  localStorage.setItem(STORAGE_NAME, nameInput.value.trim());
});

joinForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const room = selectedRoom();
  const key = needsKey(room) ? keyInput.value.trim().toUpperCase() : "";
  join(nameInput.value, roomSelect.value || "general", key);
});

roomSelect.addEventListener("change", toggleKeyField);

roomList.addEventListener("click", async (event) => {
  const item = event.target.closest(".room");
  if (!item) return;
  const roomName = item.dataset.room;
  if (roomName === me.room) return;
  const locked = item.dataset.locked === "1";
  let key = "";
  if (locked && !isAdmitted(roomName)) {
    key = await openModal({
      title: `Join #${roomName}`,
      text: "New members need the room key. Returning members can join with the same name, no key.",
      input: "Room key",
      okLabel: "Join",
      showCancel: true,
    });
    if (!key) return;
    key = String(key).toUpperCase();
  }
  join(me.name || nameInput.value, roomName, key);
});

gateCreateForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const username = nameInput.value.trim();
  const roomName = gateRoomInput.value.trim();
  if (!username) {
    showToast("Enter a display name first.");
    nameInput.focus();
    return;
  }
  if (!roomName) {
    showToast("Enter a new room name.");
    gateRoomInput.focus();
    return;
  }
  createRoom(username, roomName);
});

newRoomForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const roomName = newRoomInput.value.trim();
  if (!roomName) return;
  createRoom(me.name || nameInput.value, roomName);
  newRoomInput.value = "";
});

deleteRoomBtn.addEventListener("click", async () => {
  if (!me.room) return;
  const ok = await openModal({
    title: `Delete #${me.room}?`,
    text: "Everyone inside will be removed and this room will disappear.",
    okLabel: "Delete",
    showCancel: true,
  });
  if (!ok) return;
  socket.emit("delete_room", me.room);
});

copyKeyBtn.addEventListener("click", async () => {
  const key = roomKeyValue.textContent.trim();
  if (!key) return;
  try {
    await navigator.clipboard.writeText(key);
    showToast("Room key copied");
  } catch (error) {
    showToast(`Room key: ${key}`);
  }
});

notifyToggle.addEventListener("click", () => {
  notifyPanel.classList.toggle("hidden");
  if (!notifyPanel.classList.contains("hidden")) {
    unreadCount = 0;
    renderNotifications();
  }
});

clearNotifs.addEventListener("click", () => {
  notifications = [];
  unreadCount = 0;
  renderNotifications();
});

enableDesktop.addEventListener("click", async () => {
  if (!("Notification" in window)) {
    showToast("Desktop alerts are not available here.");
    return;
  }
  const permission = await Notification.requestPermission();
  showToast(permission === "granted" ? "Desktop alerts enabled" : "Desktop alerts blocked");
});

composer.addEventListener("submit", (event) => {
  event.preventDefault();
  const text = messageInput.value.trim();
  if (!text) return;
  socket.emit("message", text);
  socket.emit("typing", false);
  messageInput.value = "";
});

let typingTimer;
messageInput.addEventListener("input", () => {
  socket.emit("typing", true);
  clearTimeout(typingTimer);
  typingTimer = setTimeout(() => socket.emit("typing", false), 900);
});

socket.on("rooms", renderRooms);

socket.on("joined", (payload) => {
  me = { name: payload.name, room: payload.room, id: socket.id };
  localStorage.setItem(STORAGE_NAME, payload.name);
  nameInput.value = payload.name;
  if (Array.isArray(payload.admittedRooms)) {
    admittedRooms = payload.admittedRooms;
    saveAdmitted();
  } else {
    rememberRoom(payload.room);
  }
  gate.classList.add("hidden");
  app.classList.remove("hidden");
  roomTitle.textContent = payload.room;
  youLabel.textContent = `You · ${payload.name}`;
  messagesEl.innerHTML = "";
  payload.messages.forEach(addMessage);
  renderMembers(payload.members);
  showRoomKey(payload.key, payload.locked);
  renderRooms(roomsCache);
  if (payload.locked && payload.key && !payload.returning) {
    showToast(`Saved as member of #${payload.room}. Key: ${payload.key}`);
  } else if (payload.returning) {
    showToast(`Welcome back to #${payload.room}`);
  }
  messageInput.focus();
});

socket.on("room_deleted", (payload) => {
  forgetRoom(payload.name);
  resetToGate(payload.text || `Room #${payload.name} was deleted.`);
});

socket.on("notify", (note) => {
  pushNotification(note);
});

socket.on("message", addMessage);
socket.on("system", (payload) => addSystem(payload.text, payload.time));
socket.on("members", renderMembers);
socket.on("error_message", (text) => showToast(text));

socket.on("typing", ({ name, typing }) => {
  if (name === me.name) return;
  if (typing) typingUsers.set(name, true);
  else typingUsers.delete(name);
  updateTyping();
});

renderNotifications();
