const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
app.use(express.static(__dirname));

const DB_FILE = './db.json';
let db = { users: {}, games: [], customItems: [] };
if (fs.existsSync(DB_FILE)) {
  try { db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch(e) {}
}

function saveDb() { fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2)); }

// Expanded Base Catalog
const baseCatalogItems = [
  // Hats
  { id: 'hat1', type: 'hat', name: 'Red Cap', img: '🧢', colour: '#ff0000' },
  { id: 'hat2', type: 'hat', name: 'Crown', img: '👑', colour: '#ffd700' },
  { id: 'hat3', type: 'hat', name: 'Top Hat', img: '🎩', colour: '#111111' },
  { id: 'hat4', type: 'hat', name: 'Wizard Hat', img: '🧙', colour: '#4b0082' },
  { id: 'hat5', type: 'hat', name: 'Beanie', img: '🧣', colour: '#008080' },
  // Faces
  { id: 'face1', type: 'face', name: 'Smile', img: '😊' },
  { id: 'face2', type: 'face', name: 'Cool', img: '😎' },
  { id: 'face3', type: 'face', name: 'Happy', img: '😄' },
  { id: 'face4', type: 'face', name: 'Surprised', img: '😮' },
  { id: 'face5', type: 'face', name: 'Wink', img: '😉' },
  // Body Colours
  { id: 'body_red', type: 'body', name: 'Really Red', colour: '#ff4444' },
  { id: 'body_blue', type: 'body', name: 'Bright Blue', colour: '#4444ff' },
  { id: 'body_green', type: 'body', name: 'Lime Green', colour: '#44ff44' },
  { id: 'body_yellow', type: 'body', name: 'New Yeller', colour: '#ffff44' },
  { id: 'body_purple', type: 'body', name: 'Royal Purple', colour: '#aa44ff' },
  { id: 'body_orange', type: 'body', name: 'Neon Orange', colour: '#ff8800' },
  { id: 'body_black', type: 'body', name: 'Midnight Black', colour: '#222222' },
  { id: 'body_white', type: 'body', name: 'Ice White', colour: '#f0f0f0' },
];

// Normalize users
Object.values(db.users).forEach(u => {
  u.friends = u.friends || [];
  u.friendRequests = u.friendRequests || [];
  u.equippedItems = u.equippedItems || [];
  u.online = false;
});

let gameIdCounter = db.games.length ? Math.max(...db.games.map(g=>g.id)) + 1 : 1;

// Active rooms
const activeRooms = new Map();

// Starter 2D games (same as before)
const starter2DGames = [
  {
    id: 'obby',
    name: '🎯 Classic Obby',
    description: 'Jump on platforms!',
    tileData: [
      { id: '1', position: {x:100, y:500}, color: '#44ff44', width:200, height:20 },
      { id: '2', position: {x:300, y:350}, color: '#ff44ff', width:20, height:150 },
      { id: '3', position: {x:500, y:400}, color: '#ffaa00', width:20, height:50 },
      { id: '4', position: {x:600, y:200}, color: '#ff4444', width:200, height:20 }
    ],
  },
  {
    id: 'tycoon',
    name: '🏭 Money Tycoon',
    description: 'Collect cash drops!',
    tileData: [
      { id: 't1', position: {x:200, y:300}, color: '#ffff44', width:60, height:60 },
      { id: 't2', position: {x:400, y:100}, color: '#ffff44', width:60, height:60 },
      { id: 't3', position: {x:600, y:450}, color: '#ffff44', width:60, height:60 },
      { id: 't4', position: {x:100, y:100}, color: '#ffff44', width:60, height:60 },
    ],
  },
  {
    id: 'paintball',
    name: '🎨 Paintball Arena',
    description: 'Shoot paint everywhere!',
    tileData: [
      { id: 'p1', position: {x:50, y:50}, color: '#22cc22', width:10, height:500 },
      { id: 'p2', position: {x:750, y:50}, color: '#22cc22', width:10, height:500 },
      { id: 'p3', position: {x:50, y:50}, color: '#22cc22', width:700, height:10 },
      { id: 'p4', position: {x:50, y:550}, color: '#22cc22', width:700, height:10 },
    ],
  },
];

// Ensure lobbies
function ensureRoom(name, type) {
  if (!activeRooms.has(name)) {
    activeRooms.set(name, { type, players: new Map(), blockData: type==='3d'?[]:undefined, tileData: type==='2d'?[]:undefined });
  }
}
ensureRoom('lobby_2d', '2d');
ensureRoom('lobby_3d', '3d');

starter2DGames.forEach(g => {
  const roomName = 'starter_' + g.id;
  if (!activeRooms.has(roomName)) {
    activeRooms.set(roomName, { type: '2d', players: new Map(), tileData: JSON.parse(JSON.stringify(g.tileData)) });
  }
});

function getUserAvatar(username) {
  const user = db.users[username];
  if (!user) return { bodyColour: '#cccccc', hat: null, face: null };
  const equipped = user.equippedItems || [];
  let bodyColour = '#cccccc', hat = null, face = null;
  const allItems = [...baseCatalogItems, ...db.customItems];
  equipped.forEach(id => {
    const item = allItems.find(i => i.id === id);
    if (!item) return;
    if (item.type === 'body') bodyColour = item.colour;
    else if (item.type === 'hat') hat = item;
    else if (item.type === 'face') face = item;
  });
  return { bodyColour, hat, face };
}

function getActiveRoomList() {
  return Array.from(activeRooms.keys()).map(name => {
    const room = activeRooms.get(name);
    return { name, type: room.type, playerCount: room.players.size, isStarter: name.startsWith('starter_') };
  });
}

io.on('connection', (socket) => {
  console.log('Connected:', socket.id);

  // –– AUTH ––
  socket.on('login', ({ username, password }) => {
    if (!db.users[username]) return socket.emit('loginError', 'User not found');
    if (db.users[username].password !== password) return socket.emit('loginError', 'Wrong password');
    db.users[username].online = true;
    db.users[username].socketId = socket.id;
    socket.username = username;
    const allCatalog = [...baseCatalogItems, ...db.customItems];
    socket.emit('loginSuccess', {
      username,
      friends: db.users[username].friends,
      friendRequests: db.users[username].friendRequests,
      games: db.games,
      catalogItems: allCatalog,
      equipped: db.users[username].equippedItems || [],
      activeRooms: getActiveRoomList(),
      starter2D: starter2DGames.map(g => ({ id: g.id, name: g.name, description: g.description })),
    });
    notifyFriends(username, 'friendOnline');
    saveDb();
  });

  socket.on('signup', ({ username, password }) => {
    if (db.users[username]) return socket.emit('signupError', 'Username taken');
    db.users[username] = {
      password, online: true, socketId: socket.id,
      friends: [], friendRequests: [], equippedItems: ['body_red'],
    };
    socket.username = username;
    const allCatalog = [...baseCatalogItems, ...db.customItems];
    socket.emit('loginSuccess', {
      username,
      friends: [],
      friendRequests: [],
      games: db.games,
      catalogItems: allCatalog,
      equipped: ['body_red'],
      activeRooms: getActiveRoomList(),
      starter2D: starter2DGames.map(g => ({ id: g.id, name: g.name, description: g.description })),
    });
    saveDb();
  });

  // –– FRIENDS ––
  socket.on('sendFriendRequest', toUser => {
    if (!socket.username) return;
    if (db.users[toUser]) {
      if (db.users[toUser].friendRequests.find(r => r.from === socket.username)) return;
      db.users[toUser].friendRequests.push({ from: socket.username, timestamp: Date.now() });
      if (db.users[toUser].online) {
        io.to(db.users[toUser].socketId).emit('friendRequestReceived', { from: socket.username });
      }
      saveDb();
    }
  });
  socket.on('acceptFriendRequest', fromUser => {
    if (!socket.username) return;
    const user = db.users[socket.username];
    if (!user) return;
    user.friendRequests = user.friendRequests.filter(r => r.from !== fromUser);
    if (!user.friends.includes(fromUser)) user.friends.push(fromUser);
    const other = db.users[fromUser];
    if (other && !other.friends.includes(socket.username)) other.friends.push(socket.username);
    socket.emit('friendAdded', fromUser);
    if (other && other.online) io.to(other.socketId).emit('friendAdded', socket.username);
    socket.emit('friendRequestsUpdate', user.friendRequests);
    saveDb();
  });
  socket.on('declineFriendRequest', fromUser => {
    if (!socket.username) return;
    const user = db.users[socket.username];
    if (!user) return;
    user.friendRequests = user.friendRequests.filter(r => r.from !== fromUser);
    socket.emit('friendRequestsUpdate', user.friendRequests);
    saveDb();
  });
  socket.on('searchUser', term => {
    const results = Object.keys(db.users).filter(u => u.includes(term) && u !== socket.username);
    socket.emit('searchResults', results);
  });
  socket.on('getProfile', username => {
    const user = db.users[username];
    if (!user) return;
    const avatar = getUserAvatar(username);
    socket.emit('profileData', { username, online: user.online, friends: user.friends, equipped: user.equippedItems, avatar, friendCount: user.friends.length });
  });

  // –– GAMES ––
  socket.on('createGame', ({ name, code, type }) => {
    const game = { id: gameIdCounter++, creator: socket.username, name, code, type, created: Date.now() };
    db.games.push(game);
    io.emit('newGame', game);
    saveDb();
  });
  socket.on('deleteGame', gameId => {
    const idx = db.games.findIndex(g => g.id === gameId && g.creator === socket.username);
    if (idx !== -1) { db.games.splice(idx, 1); io.emit('gameDeleted', gameId); saveDb(); }
  });
  socket.on('hostGame', gameId => {
    const game = db.games.find(g => g.id === gameId);
    if (!game) return;
    const roomName = game.creator + '_' + game.name.replace(/\s/g, '_');
    if (activeRooms.has(roomName)) return socket.emit('joinRoom', roomName);
    const type = game.type || '3d';
    activeRooms.set(roomName, { type, players: new Map(), blockData: type==='3d'?[]:undefined, tileData: type==='2d'?[]:undefined });
    io.emit('activeRoomsUpdate', getActiveRoomList());
    socket.join(roomName);
    joinRoom(socket, roomName);
  });
  socket.on('joinRoom', roomName => {
    if (!activeRooms.has(roomName)) return;
    socket.join(roomName);
    joinRoom(socket, roomName);
  });

  function joinRoom(socket, roomName) {
    const room = activeRooms.get(roomName);
    if (!room) return;
    const avatar = getUserAvatar(socket.username);
    const playerData = {
      id: socket.id,
      username: socket.username,
      x: room.type==='2d' ? 400 : (Math.random()*5+2),
      y: room.type==='2d' ? 300 : 3,   // start slightly above ground
      z: room.type==='3d' ? (Math.random()*5+2) : undefined,
      dir: 'down',
      avatar,
    };
    room.players.set(socket.id, playerData);
    socket.emit('roomJoined', {
      roomName,
      type: room.type,
      players: Array.from(room.players.values()),
      blockData: room.blockData || [],
      tileData: room.tileData || [],
      isStarter: roomName.startsWith('starter_'),
    });
    socket.to(roomName).emit('playerJoined', playerData);
    socket.currentRoom = roomName;
    io.emit('activeRoomsUpdate', getActiveRoomList());
  }

  // –– MOVEMENT ––
  socket.on('move3D', ({ x, y, z, dir }) => {
    const room = activeRooms.get(socket.currentRoom);
    if (!room || room.type !== '3d') return;
    const p = room.players.get(socket.id);
    if (!p) return;
    Object.assign(p, { x, y, z, dir });
    socket.to(socket.currentRoom).emit('playerMoved3D', { id: socket.id, x, y, z, dir });
  });
  socket.on('move2D', ({ x, y, dir }) => {
    const room = activeRooms.get(socket.currentRoom);
    if (!room || room.type !== '2d') return;
    const p = room.players.get(socket.id);
    if (!p) return;
    Object.assign(p, { x, y, dir });
    socket.to(socket.currentRoom).emit('playerMoved2D', { id: socket.id, x, y, dir });
  });

  // –– BUILDING ––
  socket.on('placeBlock', ({ position, color, type: bType }) => {
    const room = activeRooms.get(socket.currentRoom);
    if (!room || room.type !== '3d') return;
    const block = { id: Date.now() + Math.random(), position, color, type: bType };
    room.blockData.push(block);
    io.to(socket.currentRoom).emit('blockPlaced', block);
  });
  socket.on('removeBlock', blockId => {
    const room = activeRooms.get(socket.currentRoom);
    if (!room || room.type !== '3d') return;
    room.blockData = room.blockData.filter(b => b.id !== blockId);
    io.to(socket.currentRoom).emit('blockRemoved', blockId);
  });
  socket.on('placeTile', ({ position, color, width, height }) => {
    const room = activeRooms.get(socket.currentRoom);
    if (!room || room.type !== '2d') return;
    const tile = { id: Date.now() + Math.random(), position, color, width: width||20, height: height||20 };
    room.tileData.push(tile);
    io.to(socket.currentRoom).emit('tilePlaced', tile);
  });
  socket.on('removeTile', tileId => {
    const room = activeRooms.get(socket.currentRoom);
    if (!room || room.type !== '2d') return;
    room.tileData = room.tileData.filter(t => t.id !== tileId);
    io.to(socket.currentRoom).emit('tileRemoved', tileId);
  });

  // –– CHAT ––
  socket.on('chatMessage', ({ message, roomName }) => {
    if (!roomName || !activeRooms.has(roomName)) return;
    io.to(roomName).emit('chatMessage', { sender: socket.username, message, timestamp: Date.now() });
  });

  // –– EQUIP ––
  socket.on('equipItem', itemId => { /* ... unchanged ... */ });
  socket.on('unequipItem', itemId => { /* ... unchanged ... */ });

  // –– LEAVE / DISCONNECT ––
  socket.on('leaveRoom', () => { /* ... unchanged ... */ });
  socket.on('disconnect', () => { /* ... unchanged ... */ });
});

function notifyFriends(username, event) {
  const user = db.users[username];
  if (!user) return;
  user.friends.forEach(friend => {
    if (db.users[friend]?.online) io.to(db.users[friend].socketId).emit(event, username);
  });
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`ZILFYGAMES on port ${PORT}`));
