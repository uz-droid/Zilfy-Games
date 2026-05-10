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
  { id: 'hat1', type: 'hat', name: 'Red Cap', img: '🧢', colour: '#ff0000' },
  { id: 'hat2', type: 'hat', name: 'Crown', img: '👑', colour: '#ffd700' },
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

// Room system: each room has type '2d' or '3d', players map, blockData (for 3D) or tileData (for 2D)
const activeRooms = new Map();
const default2DRoom = '2d_lobby';
const default3DRoom = '3d_lobby';
activeRooms.set(default2DRoom, { type: '2d', players: new Map(), tileData: [] });
activeRooms.set(default3DRoom, { type: '3d', players: new Map(), blockData: [] });

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
  return Array.from(activeRooms.entries()).map(([name, room]) => ({
    name,
    type: room.type,
    playerCount: room.players.size,
  }));
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

  // Launch (host) a game → create room
  socket.on('hostGame', gameId => {
    const game = db.games.find(g => g.id === gameId);
    if (!game) return;
    const roomName = game.creator + '_' + game.name.replace(/\s/g, '_');
    if (activeRooms.has(roomName)) return socket.emit('joinRoom', roomName);
    const type = game.type || '3d';
    activeRooms.set(roomName, { type, players: new Map(), blockData: [], tileData: [] });
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
      x: Math.random() * 10 + 0, y: 0, z: Math.random() * 10 + 0,
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
    });
    socket.to(roomName).emit('playerJoined', playerData);
    socket.currentRoom = roomName;
    io.emit('activeRoomsUpdate', getActiveRoomList());
  }

  // Movement (2D or 3D)
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

  // Building
  socket.on('placeBlock', ({ position, color, type: blockType }) => {
    const room = activeRooms.get(socket.currentRoom);
    if (!room || room.type !== '3d') return;
    const block = { id: Date.now() + Math.random(), position, color, type: blockType };
    room.blockData.push(block);
    io.to(socket.currentRoom).emit('blockPlaced', block);
  });
  socket.on('removeBlock', blockId => {
    const room = activeRooms.get(socket.currentRoom);
    if (!room || room.type !== '3d') return;
    room.blockData = room.blockData.filter(b => b.id !== blockId);
    io.to(socket.currentRoom).emit('blockRemoved', blockId);
  });

  socket.on('placeTile', ({ position, color }) => {
    const room = activeRooms.get(socket.currentRoom);
    if (!room || room.type !== '2d') return;
    const tile = { id: Date.now() + Math.random(), position, color };
    room.tileData.push(tile);
    io.to(socket.currentRoom).emit('tilePlaced', tile);
  });
  socket.on('removeTile', tileId => {
    const room = activeRooms.get(socket.currentRoom);
    if (!room || room.type !== '2d') return;
    room.tileData = room.tileData.filter(t => t.id !== tileId);
    io.to(socket.currentRoom).emit('tileRemoved', tileId);
  });

  // Equip
  socket.on('equipItem', itemId => {
    if (!db.users[socket.username]) return;
    if (!db.users[socket.username].equippedItems.includes(itemId)) {
      db.users[socket.username].equippedItems.push(itemId);
      socket.emit('equippedUpdate', db.users[socket.username].equippedItems);
      saveDb();
      // Update avatar in current room
      if (socket.currentRoom) {
        const room = activeRooms.get(socket.currentRoom);
        if (room) {
          const avatar = getUserAvatar(socket.username);
          const p = room.players.get(socket.id);
          if (p) { p.avatar = avatar; }
          io.to(socket.currentRoom).emit('avatarUpdate', { id: socket.id, avatar });
        }
      }
    }
  });
  socket.on('unequipItem', itemId => {
    if (!db.users[socket.username]) return;
    db.users[socket.username].equippedItems = db.users[socket.username].equippedItems.filter(i => i !== itemId);
    socket.emit('equippedUpdate', db.users[socket.username].equippedItems);
    saveDb();
    if (socket.currentRoom) {
      const room = activeRooms.get(socket.currentRoom);
      if (room) {
        const avatar = getUserAvatar(socket.username);
        const p = room.players.get(socket.id);
        if (p) p.avatar = avatar;
        io.to(socket.currentRoom).emit('avatarUpdate', { id: socket.id, avatar });
      }
    }
  });

  // Leave room
  socket.on('leaveRoom', () => {
    const room = activeRooms.get(socket.currentRoom);
    if (room) {
      room.players.delete(socket.id);
      socket.to(socket.currentRoom).emit('playerLeft', socket.id);
      if (room.players.size === 0 && socket.currentRoom !== default2DRoom && socket.currentRoom !== default3DRoom) {
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
      if (room.players.size === 0 && socket.currentRoom !== default2DRoom && socket.currentRoom !== default3DRoom) {
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