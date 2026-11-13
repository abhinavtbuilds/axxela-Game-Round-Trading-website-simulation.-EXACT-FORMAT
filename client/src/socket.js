import { io } from 'socket.io-client';

// Use VITE_SERVER_URL env var when set (e.g. on Render), otherwise
// default to localhost:5000 for local dev or same-origin for production build.
const SOCKET_URL = import.meta.env.VITE_SERVER_URL
  || (window.location.hostname === 'localhost' && window.location.port === '3000'
    ? 'http://localhost:5000'
    : '/');

export const socket = io(SOCKET_URL, {
  autoConnect: true,
  reconnection: true,
  reconnectionAttempts: 10,
  reconnectionDelay: 1000
});
