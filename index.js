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

const baseCatalogItems = [
  { id: 'hat1', type: 'hat', name: 'Red Cap', img: '🧢', colour: '#ff0000', model: 'cap' },
  { id: 'hat2', type: 'hat', name: 'Crown', img: '👑', colour: '#ffd700', model: 'crown' },
  { id: 'face1', type: 'face', name: 'Smile', img: '😊' },
  { id: 'face2', type: 'face', name: 'Cool', img: '😎' },
  { id: 'body_red', type: 'body', name: 'Red Body', colour: '#ff4444' },
  { id: 'body_blue', type: 'body', name: 'Blue Body', colour: '#4444ff' },
  { id: 'body_green', type: 'body', name: 'Green Body', colour: '#44ff44' },
  { id: 'body_yellow', type: 'body', name: 'Yellow Body', colour: '#ffff44' },
];

Object.values(db.users).forEach(u => {
  u.friends = u.friends || [];
  u.following = u.following || [];
  u.equippedItems = u.equippedItems || [];
  u.online = false;
});

let gameIdCounter = db.games.length ? Math.max(...db.games.map(g=>g.id)) + 1 : 1;

// ========== Active rooms ==========
const activeRooms = new Map();

// Pre‑built starter 2D games (always available)
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
    ]
  },
  {
    id: 'tycoon',
    name: '🏭 Money Tycoon',
    description: 'Collect cash drops!',
    tileData: [
      { id: 't1', position: {x:200, y:300}, color: '#ffff44', width:60, height:60 },
      { id: 't2', position: {x:400, y:100}, color: '#ffff44', width:60, height:60 },
      { id: 't3', position: {x:600, y:450}, color: '#ffff44', width:60, height:60 },
      { id: 't4', position: {x:100, y:100}, color: '#ffff44', width:60, height:60 }
    ]
  },
  {
    id: 'paintball',
    name: '🎨 Paintball Arena',
    description: 'Shoot paint everywhere!',
    tileData: [
      { id: 'p1', position: {x:50, y:50}, color: '#22cc22', width:10, height:500 },
      { id: 'p2', position: {x:750, y:50}, color: '#22cc22', width:10, height:500 },
      { id: 'p3', position: {x:50, y:50}, color: '#22cc22', width:700, height:10 },
      { id: 'p4', position: {x:50, y:550}, color: '#22cc22', width:700, height:10 }
    ]
  }
];

// Lobby rooms
function ensureRoom(name, type) {
  if (!activeRooms.has(name)) {
    activeRooms.set(name, {
      type,
      players: new Map(),
      blockData: type === '3d' ? [] : undefined,
      tileData: type === '2d' ? [] : undefined
    });
  }
}
ensureRoom('lobby_2d', '2d');
ensureRoom('lobby_3d', '3d');

// Populate starter 2D games into rooms (do it once)
starter2DGames.forEach(g => {
  const roomName = 'starter_' + g.id;
  if (!activeRooms.has(roomName)) {
    activeRooms.set(roomName, {
      type: '2d',
      players: new Map(),
      tileData: JSON.parse(JSON.stringify(g.tileData))
    });
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
    return {
      name,
      type: room.type,
      playerCount: room.players.size,
      isStarter: name.startsWith('starter_')
    };
  });
}

io.on('connection', (socket) => {
  console.log('Connected:', socket.id);

  // Auth
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
      games: db.games,
      catalogItems: allCatalog,
      equipped: db.users[username].equippedItems || [],
      activeRooms: getActiveRoomList(),
      starter2D: starter2DGames.map(g => ({ id: g.id, name: g.name, description: g.description }))
    });
    notifyFriends(username, 'friendOnline');
    saveDb();
  });

  socket.on('signup', ({ username, password }) => {
    if (db.users[username]) return socket.emit('signupError', 'Username taken');
    db.users[username] = {
      password, online: true, socketId: socket.id,
      friends: [], equippedItems: ['body_red']
    };
    socket.username = username;
    const allCatalog = [...baseCatalogItems, ...db.customItems];
    socket.emit('loginSuccess', {
      username,
      friends: [],
      games: db.games,
      catalogItems: allCatalog,
      equipped: ['body_red'],
      activeRooms: getActiveRoomList(),
      starter2D: starter2DGames.map(g => ({ id: g.id, name: g.name, description: g.description }))
    });
    saveDb();
  });

  // Friends
  socket.on('searchUser', term => {
    const results = Object.keys(db.users).filter(u => u.includes(term) && u !== socket.username);
    socket.emit('searchResults', results);
  });
  socket.on('addFriend', friendName => {
    const user = db.users[socket.username], friend = db.users[friendName];
    if (!user || !friend) return;
    if (!user.friends.includes(friendName)) {
      user.friends.push(friendName);
      if (!friend.friends.includes(socket.username)) friend.friends.push(socket.username);
      if (friend.online) io.to(friend.socketId).emit('friendAdded', socket.username);
      socket.emit('friendAdded', friendName);
      saveDb();
    }
  });

  // Game creation
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

  // Host a game from creation
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

  // Join any room
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
      x: room.type==='2d' ? 400 : Math.random()*10,
      y: room.type==='2d' ? 300 : 0,
      z: room.type==='3d' ? Math.random()*10 : undefined,
      dir: 'down',
      avatar
    };
    room.players.set(socket.id, playerData);
    socket.emit('roomJoined', {
      roomName,
      type: room.type,
      players: Array.from(room.players.values()),
      blockData: room.blockData || [],
      tileData: room.tileData || [],
      isStarter: roomName.startsWith('starter_')
    });
    socket.to(roomName).emit('playerJoined', playerData);
    socket.currentRoom = roomName;
    io.emit('activeRoomsUpdate', getActiveRoomList());
  }

  // Movement
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

  // Building (2D tiles / 3D blocks)
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

  socket.on('placeTile', ({ position, color, width=20, height=20 }) => {
    const room = activeRooms.get(socket.currentRoom);
    if (!room || room.type !== '2d') return;
    const tile = { id: Date.now() + Math.random(), position, color, width, height };
    room.tileData.push(tile);
    io.to(socket.currentRoom).emit('tilePlaced', tile);
  });
  socket.on('removeTile', tileId => {
    const room = activeRooms.get(socket.currentRoom);
    if (!room || room.type !== '2d') return;
    room.tileData = room.tileData.filter(t => t.id !== tileId);
    io.to(socket.currentRoom).emit('tileRemoved', tileId);
  });

  // Chat
  socket.on('chatMessage', ({ message, roomName }) => {
    if (!roomName || !activeRooms.has(roomName)) return;
    io.to(roomName).emit('chatMessage', {
      sender: socket.username,
      message,
      timestamp: Date.now()
    });
  });

  // Equip
  socket.on('equipItem', itemId => {
    if (!db.users[socket.username]) return;
    if (!db.users[socket.username].equippedItems.includes(itemId)) {
      db.users[socket.username].equippedItems.push(itemId);
      socket.emit('equippedUpdate', db.users[socket.username].equippedItems);
      saveDb();
      // Broadcast avatar update in room
      const room = activeRooms.get(socket.currentRoom);
      if (room) {
        const avatar = getUserAvatar(socket.username);
        const p = room.players.get(socket.id);
        if (p) p.avatar = avatar;
        io.to(socket.currentRoom).emit('avatarUpdate', { id: socket.id, avatar });
      }
    }
  });
  socket.on('unequipItem', itemId => {
    if (!db.users[socket.username]) return;
    db.users[socket.username].equippedItems = db.users[socket.username].equippedItems.filter(i => i !== itemId);
    socket.emit('equippedUpdate', db.users[socket.username].equippedItems);
    saveDb();
    const room = activeRooms.get(socket.currentRoom);
    if (room) {
      const avatar = getUserAvatar(socket.username);
      const p = room.players.get(socket.id);
      if (p) p.avatar = avatar;
      io.to(socket.currentRoom).emit('avatarUpdate', { id: socket.id, avatar });
    }
  });

  // Leave room
  socket.on('leaveRoom', () => {
    const room = activeRooms.get(socket.currentRoom);
    if (room) {
      room.players.delete(socket.id);
      socket.to(socket.currentRoom).emit('playerLeft', socket.id);
      if (room.players.size === 0 && !socket.currentRoom.startsWith('lobby_') && !socket.currentRoom.startsWith('starter_')) {
        activeRooms.delete(socket.currentRoom);
      }
      socket.leave(socket.currentRoom);
      socket.currentRoom = null;
      io.emit('activeRoomsUpdate', getActiveRoomList());
    }
  });

  // Disconnect
  socket.on('disconnect', () => {
    const room = activeRooms.get(socket.currentRoom);
    if (room) {
      room.players.delete(socket.id);
      socket.to(socket.currentRoom).emit('playerLeft', socket.id);
      if (room.players.size === 0 && !socket.currentRoom.startsWith('lobby_') && !socket.currentRoom.startsWith('starter_')) {
        activeRooms.delete(socket.currentRoom);
      }
    }
    if (socket.username && db.users[socket.username]) {
      db.users[socket.username].online = false;
      notifyFriends(socket.username, 'friendOffline');
      saveDb();
    }
    io.emit('activeRoomsUpdate', getActiveRoomList());
  });
});

function notifyFriends(username, event) {
  const user = db.users[username];
  if (!user) return;
  user.friends.forEach(friend => {
    if (db.users[friend]?.online) io.to(db.users[friend].socketId).emit(event, username);
  });
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server on port ${PORT}`));
