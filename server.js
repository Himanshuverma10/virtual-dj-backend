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
// import serviceAccount from './serviceAccountKey.json' ... <-- YEH LINE DELETE KAR DI

// --- NEW FIREBASE ADMIN INIT ---
// Render ke environment variable se key ko padho
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);

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
      currentVideoId: 'iwncGYFPxmU',
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

  // --- Queue (Cooldown + Voting) ---
    socket.on('suggest-track', ({ roomId, videoId, title }, callback) => {
      console.log(`[Backend] Received suggest-track for room ${roomId}, video ${videoId}`); // <-- DEBUG LOG

      if (!rooms[roomId]) {
        return callback({ success: false, message: 'Room not found.' });
      }

      // Check if track is already in queue
      if (rooms[roomId].queue.find(v => v.id === videoId)) {
        return callback({ success: false, message: 'Track is already in the queue.' });
      }

      const totalUsers = rooms[roomId].guests.length + 1;
      let cooldownActive = false;
      console.log(`[Backend] Total users in room ${roomId}: ${totalUsers}`);

      if (totalUsers >= 5) {
        console.log(`[Backend] Cooldown check needed (>= 5 users)`);
          const COOLDOWN_MS = 60000;
          const now = Date.now();

          if (now - rooms[roomId].lastSuggestionTime < COOLDOWN_MS) {
            const timeLeft = Math.ceil((COOLDOWN_MS - (now - rooms[roomId].lastSuggestionTime)) / 1000);
            console.log(`[Backend] Cooldown active! Wait ${timeLeft}s.`);
            return callback({ success: false, message: `Please wait ${timeLeft} seconds.` });
          }
          console.log(`[Backend] Cooldown passed. Allowing suggestion.`);
          cooldownActive = true; 
      }else {
      console.log(`[Backend] Cooldown skipped (< 5 users)`); // <-- ADD THIS
      }

      const suggestion = { 
        id: videoId, 
        title: title || videoId,
        suggestedBy: rooms[roomId].guests.find(g => g.id === socket.id)?.username || 'Host',
        votes: new Set(), // Initialize votes Set
      };

      rooms[roomId].queue.push(suggestion);
      rooms[roomId].lastSuggestionTime = Date.now(); 

      // Send queue with vote counts
      const queueWithVoteCounts = rooms[roomId].queue.map(item => ({
        ...item,
        // Make sure item.votes exists before accessing size
        votes: item.votes ? item.votes.size : 0, 
      }));

      console.log(`[Backend] Emitting update-queue. Cooldown active: ${cooldownActive}`);
      io.to(roomId).emit('update-queue', queueWithVoteCounts);
      callback({ success: true, cooldownActive: cooldownActive });
    });

    // --- ADD NEW EVENT FOR VOTING ---
    socket.on('vote-track', ({ roomId, videoId }) => {
      console.log(`[Backend] Received vote-track for room ${roomId}, video ${videoId}`); // <-- DEBUG LOG
      if (!rooms[roomId]) return;
      
      const track = rooms[roomId].queue.find(item => item.id === videoId);
      if (track) {
        // Ensure 'votes' Set exists, create if not (safety check)
        if (!track.votes) {
            track.votes = new Set();
        }
          
        const userId = socket.id;
        const hadVote = track.votes.has(userId); // Check before changing
        
        if (hadVote) {
          track.votes.delete(userId);
          console.log(`[Backend] User ${userId} removed vote.`); // <-- DEBUG LOG
        } else {
          track.votes.add(userId);
          console.log(`[Backend] User ${userId} added vote.`); // <-- DEBUG LOG
        }
        
        const newVoteCount = track.votes.size;
        console.log(`[Backend] New vote count for ${videoId}: ${newVoteCount}`); // <-- DEBUG LOG
        
        // Send the updated queue with new vote counts
        const queueWithVoteCounts = rooms[roomId].queue.map(item => ({
          ...item,
          votes: item.votes ? item.votes.size : 0, // Safety check for votes Set
        }));
        
        console.log(`[Backend] Emitting update-queue after vote.`); // <-- DEBUG LOG
        io.to(roomId).emit('update-queue', queueWithVoteCounts);
      } else {
        console.log(`[Backend] Vote failed: Track ${videoId} not found in queue.`); // <-- DEBUG LOG
      }
    });

    // --- ADD NEW EVENT FOR HOST TO PLAY TOP VOTED ---
    socket.on('play-top-voted', ({ roomId }) => {
      console.log(`[Backend] Received play-top-voted for room ${roomId} from host ${socket.id}`); // <-- DEBUG LOG
      if (!rooms[roomId] || rooms[roomId].hostId !== socket.id) {
          console.log(`[Backend] Play top voted rejected (not host or room not found).`); // <-- DEBUG LOG
          return; 
      }
      
      const queue = rooms[roomId].queue;
      if (queue.length === 0) {
          console.log(`[Backend] Play top voted rejected (queue empty).`); // <-- DEBUG LOG
          return;
      }

      // Ensure 'votes' Set exists on tracks before sorting (safety check)
      queue.forEach(track => {
        if (!track.votes) {
          track.votes = new Set();
        }
      });

      console.log(`[Backend] Current queue before sort:`, JSON.stringify(queue.map(t => ({id: t.id, votes: t.votes.size})))); // <-- DEBUG LOG

      // Find the track with the most votes
      const topTrack = [...queue].sort((a, b) => b.votes.size - a.votes.size)[0];
      console.log(`[Backend] Top voted track: ${topTrack.id} with ${topTrack.votes.size} votes.`); // <-- DEBUG LOG
      
      // Now, play this track 
      rooms[roomId].currentVideoId = topTrack.id;
      rooms[roomId].playbackState = 'PLAYING';
      rooms[roomId].lastSeekTime = 0;

      // Remove it from the queue
      rooms[roomId].queue = queue.filter(v => v.id !== topTrack.id);

      // Send the new video and the updated queue
      const queueWithVoteCounts = rooms[roomId].queue.map(item => ({
        ...item,
        votes: item.votes ? item.votes.size : 0, // Safety check
      }));

      console.log(`[Backend] Emitting set-video for top voted: ${topTrack.id}`); // <-- DEBUG LOG
      io.to(roomId).emit('set-video', { 
        videoId: topTrack.id, 
        queue: queueWithVoteCounts 
      });
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