const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
app.use(express.static(path.join(__dirname)));

// ---- Oyun alanı ayarları (tek oyunculu sürümle aynı) ----
const W = 400, H = 650;
const PUCK_R = 11, PADDLE_R = 26;
const GOAL_W = 130;
const FRICTION = 0.994;
const MAX_SPEED = 16;
const CHAMFER = 46;

let players = {}; // socket.id -> 'p1' | 'p2' | 'spectator'
let paddles = { p1: { x: W/2, y: H - 90 }, p2: { x: W/2, y: 90 } };
let prevPaddles = JSON.parse(JSON.stringify(paddles));
let puck = { x: W/2, y: H/2, vx: 0, vy: 0 };
let score = { p1: 0, p2: 0 };
let phase = 'menu'; // 'menu' | 'playing' | 'result'
let duration = 0;
let timeLeft = 0;
let gameTimer = null;

function resetPuck(dir) {
  puck.x = W/2; puck.y = H/2;
  const angle = (Math.random() - 0.5) * 0.7;
  const speed = 5;
  const d = dir || (Math.random() < 0.5 ? 1 : -1);
  puck.vx = Math.sin(angle) * speed;
  puck.vy = Math.cos(angle) * speed * d;
}
resetPuck();

function bothConnected() {
  const roles = Object.values(players);
  return roles.includes('p1') && roles.includes('p2');
}
function broadcastStatus() {
  io.emit('playersStatus', {
    p1: Object.values(players).includes('p1'),
    p2: Object.values(players).includes('p2'),
  });
}
function resetToMenu() {
  phase = 'menu';
  if (gameTimer) clearInterval(gameTimer);
  gameTimer = null;
}
function endGame() {
  phase = 'result';
  if (gameTimer) clearInterval(gameTimer);
  gameTimer = null;
  io.emit('gameOver', { score });
}

// ---- 45 derece köşe pahı ----
const CORNERS = [{ sx: -1, sy: -1 }, { sx: 1, sy: -1 }, { sx: -1, sy: 1 }, { sx: 1, sy: 1 }];
function applyChamfer(obj, r, bounce) {
  for (const { sx, sy } of CORNERS) {
    const ax = sx === 1 ? (W - obj.x) : obj.x;
    const ay = sy === 1 ? (H - obj.y) : obj.y;
    const f = ax + ay;
    const perp = (f - CHAMFER) / Math.SQRT2;
    if (perp < r) {
      const overlap = r - perp;
      const nx = -sx / Math.SQRT2, ny = -sy / Math.SQRT2;
      obj.x += nx * overlap; obj.y += ny * overlap;
      if (bounce) {
        const dot = obj.vx * nx + obj.vy * ny;
        if (dot < 0) {
          obj.vx -= 2 * dot * nx; obj.vy -= 2 * dot * ny;
          io.volatile.emit('sfx', { type: 'wall' });
        }
      }
    }
  }
}

function collide(px, py, pr, pvx, pvy) {
  const dx = puck.x - px, dy = puck.y - py;
  const dist = Math.sqrt(dx*dx + dy*dy);
  const minDist = PUCK_R + pr;
  if (dist < minDist) {
    const nx = dist > 0 ? dx/dist : 1;
    const ny = dist > 0 ? dy/dist : 0;
    const overlap = (minDist - dist) + 2;
    puck.x += nx * overlap; puck.y += ny * overlap;
    const rvx = puck.vx - pvx, rvy = puck.vy - pvy;
    const velAlongNormal = rvx*nx + rvy*ny;
    const restitution = 1.6;
    let impulse = -velAlongNormal * restitution;
    const MIN_IMPULSE = 7;
    if (impulse < MIN_IMPULSE) impulse = MIN_IMPULSE;
    puck.vx += impulse * nx + pvx * 0.5;
    puck.vy += impulse * ny + pvy * 0.5;
    const sp = Math.sqrt(puck.vx**2 + puck.vy**2);
    if (sp > MAX_SPEED) { puck.vx = puck.vx/sp*MAX_SPEED; puck.vy = puck.vy/sp*MAX_SPEED; }
    io.volatile.emit('sfx', { type: 'paddle', speed: sp });
  }
}

io.on('connection', (socket) => {
  const taken = Object.values(players);
  let role;
  if (!taken.includes('p1')) role = 'p1';
  else if (!taken.includes('p2')) role = 'p2';
  else role = 'spectator';
  players[socket.id] = role;

  socket.emit('role', role);
  socket.emit('phase', phase);
  broadcastStatus();

  socket.on('paddleMove', (pos) => {
    if (role === 'p1') {
      paddles.p1.x = Math.max(PADDLE_R, Math.min(W - PADDLE_R, pos.x));
      paddles.p1.y = Math.max(H/2 + PADDLE_R, Math.min(H - PADDLE_R, pos.y));
      applyChamfer(paddles.p1, PADDLE_R, false);
    } else if (role === 'p2') {
      paddles.p2.x = Math.max(PADDLE_R, Math.min(W - PADDLE_R, pos.x));
      paddles.p2.y = Math.max(PADDLE_R, Math.min(H/2 - PADDLE_R, pos.y));
      applyChamfer(paddles.p2, PADDLE_R, false);
    }
  });

  socket.on('startGame', (opts) => {
    if (role !== 'p1' || !bothConnected()) return;
    duration = (opts && opts.duration) || 0;
    score = { p1: 0, p2: 0 };
    paddles.p1 = { x: W/2, y: H - 90 };
    paddles.p2 = { x: W/2, y: 90 };
    resetPuck();
    phase = 'playing';
    if (gameTimer) clearInterval(gameTimer);
    if (duration > 0) {
      timeLeft = duration;
      gameTimer = setInterval(() => {
        timeLeft--;
        io.emit('timer', timeLeft);
        if (timeLeft <= 0) endGame();
      }, 1000);
    } else {
      timeLeft = 0;
    }
    io.emit('gameStarted', { duration });
  });

  socket.on('exitGame', () => {
    resetToMenu();
    io.emit('opponentLeft', role);
  });

  socket.on('disconnect', () => {
    delete players[socket.id];
    broadcastStatus();
    if (phase === 'playing') {
      resetToMenu();
      io.emit('opponentLeft', role);
    }
  });
});

setInterval(() => {
  if (phase !== 'playing') return;

  const p1vx = paddles.p1.x - prevPaddles.p1.x, p1vy = paddles.p1.y - prevPaddles.p1.y;
  const p2vx = paddles.p2.x - prevPaddles.p2.x, p2vy = paddles.p2.y - prevPaddles.p2.y;

  puck.x += puck.vx; puck.y += puck.vy;
  puck.vx *= FRICTION; puck.vy *= FRICTION;

  applyChamfer(puck, PUCK_R, true);

  if (puck.x - PUCK_R < 0) { puck.x = PUCK_R; puck.vx *= -1; io.volatile.emit('sfx', { type: 'wall' }); }
  if (puck.x + PUCK_R > W) { puck.x = W - PUCK_R; puck.vx *= -1; io.volatile.emit('sfx', { type: 'wall' }); }

  const goalL = W/2 - GOAL_W/2, goalR = W/2 + GOAL_W/2;

  if (puck.y - PUCK_R < 0) {
    if (puck.x > goalL && puck.x < goalR) {
      score.p1++;
      io.emit('goal', { who: 'p1' });
      resetPuck(1);
    } else { puck.y = PUCK_R; puck.vy *= -1; io.volatile.emit('sfx', { type: 'wall' }); }
  }
  if (puck.y + PUCK_R > H) {
    if (puck.x > goalL && puck.x < goalR) {
      score.p2++;
      io.emit('goal', { who: 'p2' });
      resetPuck(-1);
    } else { puck.y = H - PUCK_R; puck.vy *= -1; io.volatile.emit('sfx', { type: 'wall' }); }
  }

  collide(paddles.p1.x, paddles.p1.y, PADDLE_R, p1vx, p1vy);
  collide(paddles.p2.x, paddles.p2.y, PADDLE_R, p2vx, p2vy);

  prevPaddles.p1 = { ...paddles.p1 };
  prevPaddles.p2 = { ...paddles.p2 };

  io.emit('state', { puck, paddles, score, timeLeft, phase });
}, 1000 / 60);

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Sunucu çalışıyor, port: ${PORT}`);
});


