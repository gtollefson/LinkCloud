const path = require('path');
const fs = require('fs');
const http = require('http');
const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const { randomUUID } = require('crypto');
const Database = require('better-sqlite3');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, 'data');
const DB_PATH = path.join(DATA_DIR, 'concepts.db');

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

const DEFAULT_SESSION_CODE = 'demo-room';

const tableHasColumn = (table, column) => {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();
  return columns.some((col) => col.name === column);
};

const migrateSchema = () => {
  const migrateEdges = () => {
    if (tableHasColumn('edges', 'session_code')) return;

    db.transaction(() => {
      db.exec('ALTER TABLE edges RENAME TO edges_legacy;');
      db.exec(`
        CREATE TABLE edges (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          session_code TEXT NOT NULL,
          concept_a TEXT NOT NULL,
          concept_b TEXT NOT NULL,
          edge_key TEXT NOT NULL,
          weight INTEGER NOT NULL DEFAULT 0,
          UNIQUE(session_code, edge_key)
        );
      `);

      const legacyRows = db.prepare('SELECT concept_a, concept_b, edge_key, weight FROM edges_legacy').all();
      const insert = db.prepare(`
        INSERT INTO edges (session_code, concept_a, concept_b, edge_key, weight)
        VALUES (@session_code, @concept_a, @concept_b, @edge_key, @weight)
      `);

      legacyRows.forEach((row) => {
        insert.run({ ...row, session_code: DEFAULT_SESSION_CODE });
      });

      db.exec('DROP TABLE edges_legacy;');
    })();
  };

  const migrateSessionEdges = () => {
    if (tableHasColumn('session_edges', 'session_code')) return;

    db.transaction(() => {
      db.exec('ALTER TABLE session_edges RENAME TO session_edges_legacy;');
      db.exec(`
        CREATE TABLE session_edges (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          session_id TEXT NOT NULL,
          session_code TEXT NOT NULL,
          edge_key TEXT NOT NULL,
          UNIQUE(session_id, session_code, edge_key)
        );
      `);

      const legacyRows = db.prepare('SELECT session_id, edge_key FROM session_edges_legacy').all();
      const insert = db.prepare(`
        INSERT INTO session_edges (session_id, session_code, edge_key)
        VALUES (@session_id, @session_code, @edge_key)
      `);

      legacyRows.forEach((row) => {
        insert.run({ ...row, session_code: DEFAULT_SESSION_CODE });
      });

      db.exec('DROP TABLE session_edges_legacy;');
    })();
  };

  migrateEdges();
  migrateSessionEdges();
};

db.prepare(`
  CREATE TABLE IF NOT EXISTS sessions (
    code TEXT PRIMARY KEY,
    name TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`).run();

db.prepare(`
  CREATE TABLE IF NOT EXISTS edges (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_code TEXT NOT NULL,
    concept_a TEXT NOT NULL,
    concept_b TEXT NOT NULL,
    edge_key TEXT NOT NULL,
    weight INTEGER NOT NULL DEFAULT 0,
    UNIQUE(session_code, edge_key)
  )
`).run();

db.prepare(`
  CREATE TABLE IF NOT EXISTS session_edges (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    session_code TEXT NOT NULL,
    edge_key TEXT NOT NULL,
    UNIQUE(session_id, session_code, edge_key)
  )
`).run();

migrateSchema();

const createSessionStmt = db.prepare(`
  INSERT INTO sessions (code, name)
  VALUES (@code, @name)
`);

const getSessionStmt = db.prepare(`
  SELECT code, name, created_at FROM sessions WHERE code = ?
`);

const upsertEdge = db.prepare(`
  INSERT INTO edges (session_code, concept_a, concept_b, edge_key, weight)
  VALUES (@session_code, @concept_a, @concept_b, @edge_key, 1)
  ON CONFLICT(session_code, edge_key) DO UPDATE SET weight = weight + 1
  RETURNING concept_a, concept_b, edge_key, weight
`);

const recordSessionEdge = db.prepare(`
  INSERT INTO session_edges (session_id, session_code, edge_key)
  VALUES (@session_id, @session_code, @edge_key)
`);

const hasSessionEdge = db.prepare(`
  SELECT 1 FROM session_edges WHERE session_id = ? AND session_code = ? AND edge_key = ? LIMIT 1
`);

const listEdges = db.prepare(`
  SELECT concept_a, concept_b, weight
  FROM edges
  WHERE session_code = ?
  ORDER BY weight DESC, concept_a ASC
`);

const ensureSessionExists = (code, name = null) => {
  const trimmedName = name?.toString().trim() || null;
  const session = getSessionStmt.get(code);
  if (session) return session;

  createSessionStmt.run({ code, name: trimmedName });
  return getSessionStmt.get(code);
};

const resetDemoData = () => {
  const count = db.prepare('SELECT COUNT(*) as total FROM edges').get().total;
  if (count > 0) return;

  ensureSessionExists(DEFAULT_SESSION_CODE, 'Demo Session');

  const samples = [
    ['pain', 'distrust'],
    ['conflict', 'violence'],
    ['distrust', 'conflict'],
    ['distrust', 'tension'],
    ['empathy', 'understanding'],
    ['trust', 'cooperation'],
    ['cooperation', 'resolution'],
    ['violence', 'trauma']
  ];

  const demoSession = 'demo-seed';
  const insertSession = db.prepare(`
    INSERT OR IGNORE INTO session_edges (session_id, session_code, edge_key) VALUES (?, ?, ?)
  `);

  samples.forEach(([from, to]) => {
    const edgeKey = buildEdgeKey(from, to);
    upsertEdge.run({
      session_code: DEFAULT_SESSION_CODE,
      concept_a: from,
      concept_b: to,
      edge_key: edgeKey
    });
    insertSession.run(demoSession, DEFAULT_SESSION_CODE, edgeKey);
  });
};

const buildEdgeKey = (conceptA, conceptB) => {
  const a = conceptA.trim().toLowerCase();
  const b = conceptB.trim().toLowerCase();
  return a < b ? `${a}::${b}` : `${b}::${a}`;
};

const getGraph = (sessionCode) => {
  const rows = listEdges.all(sessionCode);
  const nodesMap = new Map();

  rows.forEach(({ concept_a, concept_b }) => {
    const a = concept_a.trim();
    const b = concept_b.trim();
    if (!nodesMap.has(a)) nodesMap.set(a, { id: a, label: a });
    if (!nodesMap.has(b)) nodesMap.set(b, { id: b, label: b });
  });

  const nodes = Array.from(nodesMap.values());
  const edges = rows.map(({ concept_a, concept_b, weight }) => ({
    from: concept_a.trim(),
    to: concept_b.trim(),
    weight
  }));

  return { nodes, edges };
};

resetDemoData();

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(cors());
app.use(express.json());
app.use(cookieParser());

app.use(express.static(path.join(__dirname, 'public')));

app.use((req, res, next) => {
  if (!req.cookies.session_id) {
    const sessionId = randomUUID();
    res.cookie('session_id', sessionId, {
      maxAge: 1000 * 60 * 60 * 24,
      httpOnly: true,
      sameSite: 'lax'
    });
    req.sessionId = sessionId;
  } else {
    req.sessionId = req.cookies.session_id;
  }
  next();
});

const generateSessionCode = () => {
  const adjectives = ['bright', 'calm', 'clever', 'fresh', 'kind', 'lively', 'mighty', 'swift', 'bold', 'brave'];
  const nouns = ['river', 'forest', 'sun', 'orbit', 'horizon', 'globe', 'bridge', 'ocean', 'spark', 'canvas'];

  let candidate = '';
  do {
    const adj = adjectives[Math.floor(Math.random() * adjectives.length)];
    const noun = nouns[Math.floor(Math.random() * nouns.length)];
    const suffix = Math.floor(Math.random() * 900 + 100);
    candidate = `${adj}-${noun}-${suffix}`;
  } while (getSessionStmt.get(candidate));

  return candidate;
};

const validateSessionCode = (code) => {
  if (!code) return null;
  const normalized = code.toString().trim().toLowerCase();
  if (!normalized || normalized.length > 64) return null;
  return normalized;
};

app.get('/api/session/:code/graph', (req, res) => {
  const sessionCode = validateSessionCode(req.params.code);
  if (!sessionCode) {
    return res.status(400).json({ error: 'Invalid session code.' });
  }

  const session = getSessionStmt.get(sessionCode);
  if (!session) {
    return res.status(404).json({ error: 'Session not found.' });
  }

  res.json({ session, graph: getGraph(sessionCode) });
});

app.post('/api/session', (req, res) => {
  const { name } = req.body || {};
  const code = generateSessionCode();
  const session = ensureSessionExists(code, name);
  res.status(201).json({ session });
});

app.post('/api/session/:code/submit', (req, res) => {
  const { source, target } = req.body || {};
  const sessionCode = validateSessionCode(req.params.code);
  const sessionId = req.sessionId;

  if (!sessionCode) {
    return res.status(400).json({ error: 'Invalid session code.' });
  }

  const session = getSessionStmt.get(sessionCode);
  if (!session) {
    return res.status(404).json({ error: 'Session not found.' });
  }

  if (!source || !target) {
    return res.status(400).json({ error: 'Both source and target concepts are required.' });
  }

  const normalizedSource = source.trim().toLowerCase();
  const normalizedTarget = target.trim().toLowerCase();

  if (!normalizedSource || !normalizedTarget || normalizedSource === normalizedTarget) {
    return res.status(400).json({ error: 'Concepts must be non-empty and distinct.' });
  }

  const edgeKey = buildEdgeKey(normalizedSource, normalizedTarget);

  const alreadySubmitted = hasSessionEdge.get(sessionId, sessionCode, edgeKey);
  if (alreadySubmitted) {
    return res.status(200).json({ status: 'duplicate', graph: getGraph(sessionCode) });
  }

  recordSessionEdge.run({ session_id: sessionId, session_code: sessionCode, edge_key: edgeKey });
  const updated = upsertEdge.run({
    session_code: sessionCode,
    concept_a: normalizedSource,
    concept_b: normalizedTarget,
    edge_key: edgeKey
  });

  const graph = getGraph(sessionCode);
  io.to(sessionCode).emit('graph:update', graph);

  res.status(201).json({ status: 'ok', edge: updated, graph });
});

io.on('connection', (socket) => {
  socket.on('session:join', (code) => {
    const sessionCode = validateSessionCode(code);
    if (!sessionCode) return;

    const session = getSessionStmt.get(sessionCode);
    if (!session) return;

    for (const room of socket.rooms) {
      if (room !== socket.id && room !== sessionCode) {
        socket.leave(room);
      }
    }

    socket.join(sessionCode);
    socket.emit('graph:update', getGraph(sessionCode));
  });

  socket.on('session:leave', (code) => {
    const sessionCode = validateSessionCode(code);
    if (!sessionCode) return;
    if (socket.rooms.has(sessionCode)) {
      socket.leave(sessionCode);
    }
  });
});

server.listen(PORT, () => {
  console.log(`Concept network app running on http://localhost:${PORT}`);
});

