// backend/server.js
import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import { v4 as uuidv4 } from 'uuid';
import axios from 'axios';
import 'dotenv/config';

// --- NEW FIREBASE ADMIN IMPORTS ---
import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import serviceAccount from './serviceAccountKey.json' with { type: "json" };

// --- NEW FIREBASE ADMIN INIT ---
initializeApp({
  credential: cert(serviceAccount)
});
const db = getFirestore(); // Our Firestore database instance

const app = express();
const server = http.createServer(app);

const PORT = process.env.PORT || 4000;
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:5173';

app.use(cors({ origin: FRONTEND_URL }));

// --- API Search Endpoint (Unchanged) ---
app.get('/api/search', async (req, res) => {
  // ... (your existing search code is unchanged) ...
  const query = req.query.q;
  if (!query) return res.status(400).json({ message: 'No search query provided' });
  const API_KEY = process.env.YOUTUBE_API_KEY;
  if (!API_KEY) return res.status(500).json({ message: 'Server is missing API key' });
  const URL = `https://www.googleapis.com/youtube/v3/search`;
  const options = { params: { part: 'snippet', q: query, key: API_KEY, type: 'video', maxResults: 10 } };
  try {
    const response = await axios.get(URL, options);
    const items = response.data.items.map(item => ({
      id: item.id.videoId,
      title: item.snippet.title,
      thumbnail: item.snippet.thumbnails.default.url,
    }));
    res.json(items);
  } catch (error) {
    console.error('Error fetching from YouTube API:', error.response?.data || error.message);
    res.status(500).json({ message: 'Failed to fetch search results' });
  }
});

// --- SOCKET.IO LOGIC ---
const io = new Server(server, {
  cors: { origin: FRONTEND_URL, methods: ['GET', 'POST'] },
});

const rooms = {}; // We STILL use this for live state (queue, playback, etc.)

io.on('connection', (socket) => {
  console.log(`User connected: ${socket.id}`);

  // --- Room Management ---
  socket.on('create-room', ({ maxGuests }, callback) => {
    const roomId = uuidv4().slice(0, 6);
    rooms[roomId] = {
      hostId: socket.id,
      guests: [],
      currentVideoId: 'jfKfPfyJRdk',
      playbackState: 'PAUSED',
      lastSeekTime: 0,
      queue: [],
      // We no longer store chat here. It's in Firestore.
      lastSuggestionTime: 0,
      maxGuests: maxGuests || 10,
    };
    socket.join(roomId);
    console.log(`Room created: ${roomId} by host ${socket.id}`);
    callback({ success: true, roomId });
  });

  // --- MODIFIED join-room ---
  socket.on('join-room', async ({ roomId, user }, callback) => {
    if (!rooms[roomId]) {
      return callback({ success: false, message: 'Room not found' });
    }
    if (rooms[roomId].guests.length >= rooms[roomId].maxGuests) {
      return callback({ success: false, message: 'This room is full.' });
    }

    socket.join(roomId);
    rooms[roomId].guests.push({ id: socket.id, username: user.displayName });

    // --- NEW: Fetch chat history from Firestore ---
    let chatHistory = [];
    try {
      const chatRef = db.collection('rooms').doc(roomId).collection('chat');
      const chatSnapshot = await chatRef.orderBy('timestamp', 'asc').get();
      chatSnapshot.forEach(doc => {
        chatHistory.push({ id: doc.id, ...doc.data() });
      });
    } catch (error) {
      console.error("Error fetching chat history:", error);
    }
    // ---

    // Convert Set to vote counts
    const queueWithVoteCounts = rooms[roomId].queue.map(item => ({
      ...item,
      votes: item.votes.size,
    }));

    socket.emit('room-state', {
        ...rooms[roomId],
        queue: queueWithVoteCounts,
        chat: chatHistory, // Send persistent chat history
    });

    const joinMsg = {
      id: uuidv4(),
      user: 'System',
      text: `${user.displayName || 'Guest'} has joined the party!`,
      timestamp: new Date()
    };
    // Also save join messages to DB
    await db.collection('rooms').doc(roomId).collection('chat').add(joinMsg);

    io.to(roomId).emit('new-message', joinMsg);

    console.log(`User ${socket.id} (${user.displayName}) joined room ${roomId}`);
    callback({ success: true });
  });

  // --- Playback Sync (Unchanged) ---
  socket.on('host-action', ({ roomId, type, time }) => {
    if (rooms[roomId] && rooms[roomId].hostId === socket.id) {
      rooms[roomId].playbackState = type;
      rooms[roomId].lastSeekTime = time;
      socket.to(roomId).emit('sync-playback', { type, time });
    }
  });

  // ... (host-change-video, suggest-track, vote-track, play-top-voted are all UNCHANGED) ...
  // ... (They still use the in-memory `rooms` object for the queue) ...

  // --- MODIFIED send-message ---
  socket.on('send-message', async ({ roomId, message, user }) => {
    if (rooms[roomId]) {
      const msg = {
        id: uuidv4(),
        user: user.displayName || 'Guest',
        uid: user.uid, // Store user ID
        text: message,
        timestamp: new Date()
      };

      // --- NEW: Save chat message to Firestore ---
      try {
        await db.collection('rooms').doc(roomId).collection('chat').add(msg);
      } catch (error) {
        console.error("Error saving chat message:", error);
      }
      // ---

      io.to(roomId).emit('new-message', msg);
    }
  });

  // ... (All other events like 'host-change-video', 'suggest-track', etc. are UNCHANGED) ...

  // --- Disconnect (Unchanged) ---
  socket.on('disconnect', () => {
    // ... (This logic is unchanged, it just removes user from in-memory guest list) ...
    console.log(`User disconnected: ${socket.id}`);
    for (const roomId in rooms) {
      if (rooms[roomId].hostId === socket.id) {
        console.log(`Host left room ${roomId}. Closing room.`);
        io.to(roomId).emit('host-left', 'The host has disconnected. Room closed.');
        delete rooms[roomId];
        break;
      } else {
        const guestIndex = rooms[roomId].guests.findIndex(g => g.id === socket.id);
        if (guestIndex > -1) {
          const guest = rooms[roomId].guests.splice(guestIndex, 1)[0];
          const leaveMsg = {
            id: uuidv4(),
            user: 'System',
            text: `${guest.username || 'Guest'} has left the party.`,
            timestamp: new Date()
          };
          // Also save leave messages
          db.collection('rooms').doc(roomId).collection('chat').add(leaveMsg);
          io.to(roomId).emit('new-message', leaveMsg);
          break;
        }
      }
    }
  });
});

server.listen(PORT, () => {
  console.log(`Backend server running on http://localhost:${PORT}`);
});