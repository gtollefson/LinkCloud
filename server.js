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

db.prepare(`
  CREATE TABLE IF NOT EXISTS edges (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    concept_a TEXT NOT NULL,
    concept_b TEXT NOT NULL,
    edge_key TEXT NOT NULL UNIQUE,
    weight INTEGER NOT NULL DEFAULT 0
  )
`).run();

db.prepare(`
  CREATE TABLE IF NOT EXISTS session_edges (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    edge_key TEXT NOT NULL,
    UNIQUE(session_id, edge_key)
  )
`).run();

const upsertEdge = db.prepare(`
  INSERT INTO edges (concept_a, concept_b, edge_key, weight)
  VALUES (@concept_a, @concept_b, @edge_key, 1)
  ON CONFLICT(edge_key) DO UPDATE SET weight = weight + 1
  RETURNING concept_a, concept_b, edge_key, weight
`);

const recordSessionEdge = db.prepare(`
  INSERT INTO session_edges (session_id, edge_key)
  VALUES (@session_id, @edge_key)
`);

const hasSessionEdge = db.prepare(`
  SELECT 1 FROM session_edges WHERE session_id = ? AND edge_key = ? LIMIT 1
`);

const listEdges = db.prepare(`
  SELECT concept_a, concept_b, weight FROM edges ORDER BY weight DESC, concept_a ASC
`);

const resetDemoData = () => {
  const count = db.prepare('SELECT COUNT(*) as total FROM edges').get().total;
  if (count > 0) return;

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
    INSERT OR IGNORE INTO session_edges (session_id, edge_key) VALUES (?, ?)
  `);

  samples.forEach(([from, to]) => {
    const edgeKey = buildEdgeKey(from, to);
    upsertEdge.run({ concept_a: from, concept_b: to, edge_key: edgeKey });
    insertSession.run(demoSession, edgeKey);
  });
};

const buildEdgeKey = (conceptA, conceptB) => {
  const a = conceptA.trim().toLowerCase();
  const b = conceptB.trim().toLowerCase();
  return a < b ? `${a}::${b}` : `${b}::${a}`;
};

const getGraph = () => {
  const rows = listEdges.all();
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

app.get('/api/graph', (_req, res) => {
  res.json(getGraph());
});

app.post('/api/submit', (req, res) => {
  const { source, target } = req.body || {};
  const sessionId = req.sessionId;

  if (!source || !target) {
    return res.status(400).json({ error: 'Both source and target concepts are required.' });
  }

  const normalizedSource = source.trim().toLowerCase();
  const normalizedTarget = target.trim().toLowerCase();

  if (!normalizedSource || !normalizedTarget || normalizedSource === normalizedTarget) {
    return res.status(400).json({ error: 'Concepts must be non-empty and distinct.' });
  }

  const edgeKey = buildEdgeKey(normalizedSource, normalizedTarget);

  const alreadySubmitted = hasSessionEdge.get(sessionId, edgeKey);
  if (alreadySubmitted) {
    return res.status(200).json({ status: 'duplicate', graph: getGraph() });
  }

  recordSessionEdge.run({ session_id: sessionId, edge_key: edgeKey });
  const updated = upsertEdge.run({
    concept_a: normalizedSource,
    concept_b: normalizedTarget,
    edge_key: edgeKey
  });

  const graph = getGraph();
  io.emit('graph:update', graph);

  res.status(201).json({ status: 'ok', edge: updated, graph });
});

io.on('connection', (socket) => {
  socket.emit('graph:update', getGraph());
});

server.listen(PORT, () => {
  console.log(`Concept network app running on http://localhost:${PORT}`);
});

