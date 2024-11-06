const { Server } = require("socket.io");

const connectedUsers = {}; // Tracks users in each room
const roomStates = {};     // Tracks game state in each room

const CHOICE_TIME = 1000;      // Time limit for each player to make a choice in milliseconds
const RECONNECTION_TIME = 20000; // Time allowed for reconnection after disconnection

function setupSocket(server) {
    const io = new Server(server);

    io.on('connection', (socket) => {
        socket.on('connect-to-room', (msg) => handleConnectToRoom(socket, msg, io));
        socket.on("disconnecting", () => handleDisconnecting(socket, io));
        socket.on('player-choice', (msg) => handlePlayerChoice(socket, msg, io));
    });

    return io;
}

// Handles a user connecting to a room
function handleConnectToRoom(socket, msg, io) {
    const { username, room } = msg;

    if (!username || !room || room.length <= 4) {
        socket.emit('exception', 'invalid room or username');
        return;
    }

    const ROOM_NAME = `room:${room}`;
    socket.join(ROOM_NAME);

    if (roomStates[ROOM_NAME] && roomStates[ROOM_NAME].connectedUsers[0] && roomStates[ROOM_NAME].connectedUsers[0].socketId === socket.id) {
        return;
    }

    const isReconnecting = Object.values(connectedUsers).some(
        user => user.username === username && user.room === room
    );

    if (isReconnecting) {
        const oldSocketId = Object.keys(connectedUsers).find(id => connectedUsers[id].username === username);
        if (oldSocketId) {
            delete connectedUsers[oldSocketId];
        }
        connectedUsers[socket.id] = { username, room, socketId: socket.id };
        socket.emit('room-event:reconnect', `${username} rejoined ${ROOM_NAME}`);
        roomStates[ROOM_NAME].paused = false;
    } else {
        connectedUsers[socket.id] = { username, room, socketId: socket.id };
    }

    if (!roomStates[ROOM_NAME]) {
        roomStates[ROOM_NAME] = {
            connectedUsers: [{ username, socketId: socket.id }],
            scores: { [username]: 0 },
            round: 1,
            choices: {},
            roundTimeout: null,
            paused: false
        };
    } else {
        roomStates[ROOM_NAME].connectedUsers.push({ username, socketId: socket.id });
        if (!roomStates[ROOM_NAME].scores[username]) {
            roomStates[ROOM_NAME].scores[username] = 0;

        }
    }

    io.to(ROOM_NAME).emit('room-event:join', `${username} joined ${ROOM_NAME}`);

    if (roomStates[ROOM_NAME].connectedUsers.length === 2) {
        io.to(ROOM_NAME).emit('room-event:ready', 'players are ready, waiting for choice');
        startNextRound(io, ROOM_NAME);
    }
}

// Determines the winner for a round of rock-paper-scissors
function determineRoundWinner(choice1, choice2) {
    const winMap = { rock: 'scissors', paper: 'rock', scissors: 'paper' };
    if (choice1 === choice2) return 'tie';
    return winMap[choice1] === choice2 ? 'player1' : 'player2';
}

// Handles player choices and determines round outcomes
function handlePlayerChoice(socket, msg, io) {
    const { username, room, choice } = msg;
    const roomState = roomStates[room];

    if (!roomState || !['rock', 'paper', 'scissors'].includes(choice)) {
        if (socket) {
            socket.emit('exception', 'invalid choice or room');
            return;
        }
    }

    if (username) {
        roomState.choices[username] = choice;
    }

    if (Object.keys(roomState.choices).length === 2) {
        const [player1, player2] = roomState.connectedUsers.map(user => user.username);
        const result = determineRoundWinner(roomState.choices[player1], roomState.choices[player2]);

        if (result === 'player1') roomState.scores[player1]++;
        if (result === 'player2') roomState.scores[player2]++;
        if (result === 'tie') {
            roomState.scores[player1]++;
            roomState.scores[player2]++;
        }

        io.to(room).emit('room-event:round-result', {
            round: roomState.round,
            choices: roomState.choices,
            result,
            scores: roomState.scores
        });

        roomState.choices = {};
        roomState.round++;

        if (roomState.scores[player1] === 5 || roomState.scores[player2] === 5) {
            let winner = roomState.scores[player1] === 5 ? player1 : player2;
            if (roomState.scores[player1] === roomState.scores[player2]) winner = 'tie';
            io.to(room).emit('room-event:game-over', { winner });
            cleanupGame(room);
        } else {
            startNextRound(io, room);
        }
    }
}

// Starts a new round with a countdown and pause/resume functionality
function startNextRound(io, ROOM_NAME) {
    const roomState = roomStates[ROOM_NAME];
    if (roomState.paused) return;

    let remainingTime = CHOICE_TIME / 1000; // Countdown time in seconds
    clearInterval(roomState.roundTimeout);

    roomState.roundTimeout = setInterval(() => {
        if (roomState.paused) return; // Stop the countdown if the game is paused

        io.to(ROOM_NAME).emit('room-event:round-timer', { remainingTime });
        remainingTime -= 1;

        if (remainingTime <= 0) {
            clearInterval(roomState.roundTimeout);
            const [player1, player2] = roomState.connectedUsers.map(user => user.username);

            if (!roomState.choices[player1]) roomState.choices[player1] = 'rock';
            if (!roomState.choices[player2]) roomState.choices[player2] = 'rock';

            handlePlayerChoice(null, { room: ROOM_NAME, username: null, choice: null }, io);
        }
    }, 1000);
}

// Handle player disconnections
function handleDisconnecting(socket, io) {
    const rooms = socket.rooms;

    rooms.forEach((room) => {
        const user = connectedUsers[socket.id];
        if (user) {
            io.to(room).emit('room-event:disconnect', `${user.username} disconnected from ${room}`);
            const roomState = roomStates[room];
            if (roomState) {
                roomState.paused = true;
                clearInterval(roomState.roundTimeout);
                markUserForReconnection(user.username, room, io);
            }
        }
    });
}

// Marks a user for reconnection
function markUserForReconnection(username, room, io) {
    const roomState = roomStates[room];
    if (roomState) {
        roomState.connectedUsers = roomState.connectedUsers.filter(user => user.username !== username);
    }

    setTimeout(() => {
        const roomToDisconnectFrom = roomStates[room];
        const isUserStillDisconnected = !roomToDisconnectFrom?.connectedUsers.some(user => user.username === username);

        if (isUserStillDisconnected) {
            for (const [id, user] of Object.entries(connectedUsers)) {
                if (user.username === username) delete connectedUsers[id];
            }

            if (roomToDisconnectFrom) {
                if (roomToDisconnectFrom.connectedUsers.length > 0) {
                    io.to(room).emit('room-event:game-over', { winner: roomToDisconnectFrom.connectedUsers[0].username });
                }
                cleanupGame(room);
            }
        } 
    }, RECONNECTION_TIME);
}

// Cleans up room state after a game finishes
function cleanupGame(ROOM_NAME) {
    const roomState = roomStates[ROOM_NAME];
    if (roomState) {
        clearInterval(roomState.roundTimeout);
        roomState.connectedUsers.forEach(user => {
            delete connectedUsers[user.socketId]
        })
        delete roomStates[ROOM_NAME];
    }
}

module.exports = setupSocket;