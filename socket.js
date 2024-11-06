// socket.js

const { Server } = require("socket.io");

const connectedUsers = {};
const roomStates = {};

function setupSocket(server) {
    const io = new Server(server);

    io.on('connection', (socket) => {
        socket.on('connect-to-room', (msg) => handleConnectToRoom(socket, msg, io));
        socket.on("disconnecting", () => handleDisconnecting(socket, io));
    });

    return io;
}

function handleConnectToRoom(socket, msg, io) {
    if (!msg.username || msg.room.length <= 4) {
        socket.emit('exception', 'something went wrong');
        return;
    }

    const ROOM_NAME = `room:${msg.room}`;

    if (connectedUsers[socket.id]) {
        socket.emit('exception', 'already in a room');
        return;
    }

    if (roomStates[ROOM_NAME]?.connected_users.length >= 2) {
        socket.emit('exception', 'room full');
        return;
    }

    socket.join(ROOM_NAME);
    connectedUsers[socket.id] = { username: msg.username, room: msg.room };
    roomStates[ROOM_NAME] = roomStates[ROOM_NAME] || { connected_users: [] };
    roomStates[ROOM_NAME].connected_users.push(socket.id);

    io.to(ROOM_NAME).emit('room-event:join', `${msg.username} joined ${ROOM_NAME}`);

    if (roomStates[ROOM_NAME].connected_users.length === 2) {
        io.to(ROOM_NAME).emit('room-event:ready', 'players are ready, waiting for choice');
    }
}

function handleDisconnecting(socket, io) {
    const rooms = socket.rooms;

    rooms.forEach((room) => {
        const user = connectedUsers[socket.id];
        if (user) {
            io.to(room).emit('room-event:disconnect', `${user.username} left ${room}`);
            removeUserFromRoom(socket.id, room);
        }
    });

    delete connectedUsers[socket.id];
}

function removeUserFromRoom(socketId, room) {
    const roomState = roomStates[room];

    if (roomState) {
        roomState.connected_users = roomState.connected_users.filter(id => id !== socketId);
        if (roomState.connected_users.length === 0) delete roomStates[room];
    }
}

module.exports = setupSocket;