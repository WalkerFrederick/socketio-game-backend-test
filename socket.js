// socket.js

const { Server } = require("socket.io");

// Track connected users in each room
const connectedUsers = {}; // { socketId: { username, room, socketId } }
const roomStates = {};     // { roomName: { connectedUsers, scores, round, choices, roundTimeout } }

// Constants for game timing
const CHOICE_TIME = 20000;      // Time limit for each player to make a choice in milliseconds
const RECONNECTION_TIME = 20000; // Time allowed for reconnection after disconnection

// Initialize and set up socket server
function setupSocket(server) {
    const io = new Server(server);

    // Handle new connections and relevant events
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

    // Validate username and room
    if (!username || !room || room.length <= 4) {
        socket.emit('exception', 'invalid room or username');
        return;
    }

    const ROOM_NAME = `room:${room}`;
    socket.join(ROOM_NAME);

    // Prevent duplicate connection by the same user/socket
    if (roomStates[ROOM_NAME] && roomStates[ROOM_NAME].connectedUsers[0].socketId === socket.id) {
        return;
    }

    // Check if the user is reconnecting
    const isReconnecting = Object.values(connectedUsers).some(
        user => user.username === username && user.room === room
    );

    if (isReconnecting) {
        const oldSocketId = Object.keys(connectedUsers).find(id => connectedUsers[id].username === username);
        if (oldSocketId) {
            delete connectedUsers[oldSocketId]; // Remove old connection
        }
        connectedUsers[socket.id] = { username, room, socketId: socket.id };
        socket.emit('room-event:reconnect', `${username} rejoined ${ROOM_NAME}`);
    } else {
        // New connection
        connectedUsers[socket.id] = { username, room, socketId: socket.id };
    }

    // Initialize room state if it doesn't exist
    if (!roomStates[ROOM_NAME]) {
        roomStates[ROOM_NAME] = {
            connectedUsers: [{ username, socketId: socket.id }],
            scores: { [username]: 0 },
            round: 1,
            choices: {},
            roundTimeout: null
        };
    } else {
        // Add user to existing room state
        roomStates[ROOM_NAME].connectedUsers.push({ username, socketId: socket.id });
        roomStates[ROOM_NAME].scores[username] = 0;
    }

    // Notify all users in the room
    io.to(ROOM_NAME).emit('room-event:join', `${username} joined ${ROOM_NAME}`);

    // If the room has 2 players, start the game
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

    // Validate choice and room state
    if (!roomState || !['rock', 'paper', 'scissors'].includes(choice)) {
        if (socket) {
            socket.emit('exception', 'invalid choice or room');
            return;
        }
    }

    // Register player's choice
    if (username) {
        roomState.choices[username] = choice;
    }

    // Process round results when both players have chosen
    if (Object.keys(roomState.choices).length === 2) {
        const [player1, player2] = roomState.connectedUsers.map(user => user.username);
        const result = determineRoundWinner(roomState.choices[player1], roomState.choices[player2]);

        // Update scores based on the result
        if (result === 'player1') roomState.scores[player1]++;
        if (result === 'player2') roomState.scores[player2]++;
        if (result === 'tie') {
            roomState.scores[player1]++;
            roomState.scores[player2]++;
        }

        // Emit round results to room
        io.to(room).emit('round-result', {
            round: roomState.round,
            choices: roomState.choices,
            result,
            scores: roomState.scores
        });

        roomState.choices = {}; // Reset choices for next round
        roomState.round++;

        // Check if any player has won the game
        if (roomState.scores[player1] === 5 || roomState.scores[player2] === 5) {
            let winner = roomState.scores[player1] === 5 ? player1 : player2;
            if (roomState.scores[player1] === roomState.scores[player2]) winner = 'tie';
            io.to(room).emit('game-over', { winner });
            cleanupGame(room);
        } else {
            startNextRound(io, room); // Start next round if game continues
        }
    }
}

// Starts a new round with a timer
function startNextRound(io, ROOM_NAME) {
    const roomState = roomStates[ROOM_NAME];
    clearTimeout(roomState.roundTimeout);

    // Set up round timer
    roomState.roundTimeout = setTimeout(() => {
        const [player1, player2] = roomState.connectedUsers.map(user => user.username);

        // Default choice to "rock" if no selection was made
        if (!roomState.choices[player1]) roomState.choices[player1] = 'rock';
        if (!roomState.choices[player2]) roomState.choices[player2] = 'rock';

        handlePlayerChoice(null, { room: ROOM_NAME, username: null, choice: null }, io);
    }, CHOICE_TIME);

    // Notify players of the new round
    io.to(ROOM_NAME).emit('start-round', { round: roomState.round, timer: CHOICE_TIME / 1000 });
}

// Handle player disconnections
function handleDisconnecting(socket, io) {
    const rooms = socket.rooms;

    // Notify others in the room of the disconnection
    rooms.forEach((room) => {
        const user = connectedUsers[socket.id];
        if (user) {
            io.to(room).emit('room-event:disconnect', `${user.username} disconnected from ${room}`);
            markUserForReconnection(user.username, room, io);
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
        if (!roomToDisconnectFrom?.connectedUsers.some(user => user.username === username)) {
            for (const [id, user] of Object.entries(connectedUsers)) {
                if (user.username === username) delete connectedUsers[id];
            }

            // End game if no other players are left
            if (roomToDisconnectFrom) {
                if (roomToDisconnectFrom.connectedUsers.length > 0) {
                    io.to(room).emit('game-over', { winner: roomToDisconnectFrom.connectedUsers[0].username });
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
        clearTimeout(roomState.roundTimeout);
        delete roomStates[ROOM_NAME];
    }
}

module.exports = setupSocket;