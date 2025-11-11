const form = document.getElementById('concept-form');
const feedback = document.getElementById('feedback');
const graphContainer = document.getElementById('graph');
const viewToggle = document.querySelector('.view-toggle');
const createSessionForm = document.getElementById('create-session-form');
const joinSessionForm = document.getElementById('join-session-form');
const joinFeedback = document.getElementById('join-feedback');
const showExampleBtn = document.getElementById('show-example');
const sessionShell = document.getElementById('session-shell');
const exampleBanner = document.getElementById('example-banner');
const introSection = document.getElementById('intro');
const launchSection = document.querySelector('.launch');
const sessionTitle = document.getElementById('session-title');
const sessionSubtitle = document.getElementById('session-subtitle');
const sessionPill = document.getElementById('session-pill');
const shareLinkInput = document.getElementById('share-link');
const copyShareLinkBtn = document.getElementById('copy-share-link');
const closeSessionBtn = document.getElementById('close-session');
const shareContainer = document.querySelector('.session-share');

const socket = io();

const palette = ['#3f8cff', '#22c55e', '#f97316', '#8b5cf6', '#ef4444', '#14b8a6'];
const DEMO_SESSION = 'demo-room';

const baseOptions = {
  autoResize: true,
  layout: {
    randomSeed: 42,
    improvedLayout: true
  },
  nodes: {
    shape: 'dot',
    size: 20,
    font: {
      color: '#0f172a',
      size: 16,
      face: 'Inter',
      strokeWidth: 0
    },
    borderWidth: 2,
    color: {
      border: '#3f8cff',
      background: '#e8efff',
      highlight: {
        border: '#1d4ed8',
        background: '#ffffff'
      }
    },
    shadow: {
      enabled: true,
      color: 'rgba(30, 64, 175, 0.16)',
      size: 18,
      x: 0,
      y: 4
    }
  },
  edges: {
    smooth: {
      type: 'continuous',
      roundness: 0.25
    },
    color: {
      color: '#cbd5e1',
      highlight: '#3f8cff',
      hover: '#64748b'
    },
    selectionWidth: 1.4,
    hoverWidth: 1.6,
    width: 1
  },
  interaction: {
    hover: true,
    tooltipDelay: 120,
    dragNodes: false,
    zoomView: true
  },
  physics: {
    enabled: true,
    solver: 'forceAtlas2Based',
    springConstant: 0.025,
    springLength: 150,
    damping: 0.36,
    stabilization: {
      enabled: true,
      iterations: 240
    }
  }
};

const freeModeOptions = {
  physics: {
    enabled: true,
    solver: 'forceAtlas2Based',
    springConstant: 0.025,
    springLength: 150,
    damping: 0.36,
    stabilization: {
      enabled: true,
      iterations: 240
    }
  },
  interaction: {
    dragNodes: true
  }
};

const staticModeOptions = {
  physics: false,
  interaction: {
    dragNodes: false
  }
};

const networkData = {
  nodes: new vis.DataSet([]),
  edges: new vis.DataSet([])
};

const network = new vis.Network(graphContainer, networkData, baseOptions);

const state = {
  graph: { nodes: [], edges: [] },
  metrics: {
    degrees: new Map(),
    adjacency: new Map(),
    hubId: null,
    distances: new Map()
  },
  session: null,
  isExample: false
};

let activeView = 'free';
let activeSessionCode = null;

const setFeedback = (message, type = '') => {
  feedback.textContent = message;
  feedback.className = `feedback ${type}`.trim();
};

const setJoinFeedback = (message, type = '') => {
  joinFeedback.textContent = message;
  joinFeedback.className = `feedback ${type}`.trim();
};

const formatConcept = (text) =>
  text.replace(/\b\w/g, (char) => char.toUpperCase());

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

const scaleEdgeWidth = (weight, maxWeight) => {
  if (maxWeight <= 1) return 2;
  const minWidth = 1.6;
  const maxWidth = 26;
  const normalized = Math.log(weight + 1) / Math.log(maxWeight + 1);
  return minWidth + Math.pow(normalized, 0.9) * (maxWidth - minWidth);
};

const scaleEdgeFont = (weight, maxWeight) => {
  if (maxWeight <= 1) return 13;
  const minSize = 13;
  const maxSize = 26;
  const normalized = Math.log(weight + 1) / Math.log(maxWeight + 1);
  return minSize + Math.pow(normalized, 0.85) * (maxSize - minSize);
};

const scaleNodeSize = (degree, maxDegree) => {
  const minSize = 18;
  const maxSize = 42;
  if (maxDegree <= 1) return minSize + degree * 4;
  const normalized = degree / maxDegree;
  return minSize + Math.pow(normalized, 0.7) * (maxSize - minSize);
};

const buildMetrics = (graph) => {
  const degrees = new Map();
  const adjacency = new Map();

  graph.nodes.forEach((node) => {
    degrees.set(node.id, 0);
    adjacency.set(node.id, new Set());
  });

  graph.edges.forEach(({ from, to }) => {
    if (!degrees.has(from)) degrees.set(from, 0);
    if (!degrees.has(to)) degrees.set(to, 0);
    degrees.set(from, degrees.get(from) + 1);
    degrees.set(to, degrees.get(to) + 1);

    if (!adjacency.has(from)) adjacency.set(from, new Set());
    if (!adjacency.has(to)) adjacency.set(to, new Set());
    adjacency.get(from).add(to);
    adjacency.get(to).add(from);
  });

  let hubId = null;
  let hubDegree = -1;
  degrees.forEach((value, key) => {
    if (value > hubDegree) {
      hubId = key;
      hubDegree = value;
    }
  });

  const distances = new Map();
  if (hubId !== null) {
    const queue = [hubId];
    distances.set(hubId, 0);

    while (queue.length) {
      const current = queue.shift();
      const neighbours = adjacency.get(current) || [];
      neighbours.forEach((next) => {
        if (!distances.has(next)) {
          distances.set(next, distances.get(current) + 1);
          queue.push(next);
        }
      });
    }
  }

  return { degrees, adjacency, hubId, distances };
};

const computeFocusedLayout = (nodes, metrics) => {
  const positions = new Map();
  if (!nodes.length) return positions;

  const { hubId, distances } = metrics;
  const width = graphContainer.clientWidth || 640;
  const height = graphContainer.clientHeight || 480;
  const baseRadius = Math.min(width, height) * 0.24;
  const radiusStep = Math.min(width, height) * 0.2;

  const levels = new Map();
  nodes.forEach((node) => {
    const level = distances.has(node.id) ? distances.get(node.id) : Number.MAX_SAFE_INTEGER;
    if (!levels.has(level)) levels.set(level, []);
    levels.get(level).push(node.id);
  });

  const sortedLevels = [...levels.entries()].sort((a, b) => a[0] - b[0]);

  sortedLevels.forEach(([level, ids]) => {
    const ringIndex = level === Number.MAX_SAFE_INTEGER ? sortedLevels.length : level;
    const radius = baseRadius + radiusStep * (ringIndex - 1);
    const count = ids.length;
    const angleStep = (2 * Math.PI) / count;
    ids.forEach((id, index) => {
      const angle = angleStep * index - Math.PI / 2;
      const jitter = (Math.random() - 0.5) * 18;
      positions.set(id, {
        x: Math.cos(angle) * radius + jitter,
        y: Math.sin(angle) * radius + jitter
      });
    });
  });

  if (hubId && !positions.has(hubId)) {
    positions.set(hubId, { x: 0, y: 0 });
  }

  return positions;
};

const computeHierarchyLayout = (nodes, metrics) => {
  const positions = new Map();
  if (!nodes.length) return positions;

  const { hubId, distances, degrees } = metrics;

  const levels = new Map();
  let maxLevel = 0;

  nodes.forEach((node) => {
    const level = distances.has(node.id) ? distances.get(node.id) : Number.MAX_SAFE_INTEGER;
    if (level !== Number.MAX_SAFE_INTEGER) {
      maxLevel = Math.max(maxLevel, level);
    }
    if (!levels.has(level)) levels.set(level, []);
    levels.get(level).push(node.id);
  });

  let fallbackLevel = maxLevel + 1;
  levels.get(Number.MAX_SAFE_INTEGER)?.forEach((id) => {
    levels.delete(Number.MAX_SAFE_INTEGER);
    if (!levels.has(fallbackLevel)) levels.set(fallbackLevel, []);
    levels.get(fallbackLevel).push(id);
    fallbackLevel += 1;
  });

  const sortedLevels = [...levels.entries()].sort((a, b) => a[0] - b[0]);
  const layerHeight = 180;
  const nodeSpacing = 180;

  sortedLevels.forEach(([level, ids]) => {
    ids.sort((a, b) => (degrees.get(b) || 0) - (degrees.get(a) || 0));
    const y = (level - (sortedLevels.length - 1) / 2) * layerHeight;
    const half = (ids.length - 1) / 2;
    ids.forEach((id, index) => {
      const x = (index - half) * nodeSpacing;
      positions.set(id, { x, y });
    });
  });

  if (hubId && positions.has(hubId)) {
    positions.set(hubId, { x: 0, y: positions.get(hubId).y });
  }

  return positions;
};

const withAlpha = (hex, alphaHex) => `${hex}${alphaHex}`;

const getNodeColor = (level, highlight = false) => {
  if (level === Number.MAX_SAFE_INTEGER || level == null) {
    return {
      border: '#334155',
      background: '#e2e8f0',
      highlight: { border: '#1d4ed8', background: '#f8fafc' },
      hover: { border: '#1d4ed8', background: '#f1f5f9' }
    };
  }

  const index = Math.max(0, Math.min(palette.length - 1, level));
  const base = palette[index];

  return {
    border: base,
    background: withAlpha(base, highlight ? '22' : '18'),
    highlight: {
      border: base,
      background: withAlpha(base, highlight ? '33' : '26')
    },
    hover: {
      border: base,
      background: withAlpha(base, highlight ? '26' : '1f')
    }
  };
};

const updateToggleUI = (mode) => {
  if (!viewToggle) return;
  [...viewToggle.querySelectorAll('button')].forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.viewMode === mode);
  });
};

const applyViewMode = (mode) => {
  activeView = mode;
  updateToggleUI(mode);

  const { graph, metrics } = state;
  if (!graph.nodes.length) return;

  if (mode === 'free') {
    network.setOptions({
      ...baseOptions,
      ...freeModeOptions,
      interaction: { ...baseOptions.interaction, ...freeModeOptions.interaction }
    });

    const updates = graph.nodes.map((node) => ({
      id: node.id,
      fixed: false,
      physics: true,
      color: getNodeColor(metrics.distances.get(node.id), false)
    }));

    networkData.nodes.update(updates);
    network.stabilize(240);
    return;
  }

  const positions =
    mode === 'hierarchy'
      ? computeHierarchyLayout(graph.nodes, metrics)
      : computeFocusedLayout(graph.nodes, metrics);

  network.setOptions({
    ...baseOptions,
    ...staticModeOptions,
    interaction: { ...baseOptions.interaction, ...staticModeOptions.interaction }
  });

  const updates = graph.nodes.map((node) => {
    const position = positions.get(node.id) || { x: 0, y: 0 };
    return {
      id: node.id,
      x: position.x,
      y: position.y,
      fixed: { x: true, y: true },
      physics: false,
      color: getNodeColor(metrics.distances.get(node.id), mode === 'focused')
    };
  });

  networkData.nodes.update(updates);
  network.moveTo({
    position: { x: 0, y: 0 },
    scale: 1,
    animation: { duration: 600, easingFunction: 'easeInOutQuad' }
  });
};

const renderGraph = (graph) => {
  state.graph = graph;
  state.metrics = buildMetrics(graph);

  const { degrees } = state.metrics;
  const maxDegree = Math.max(1, ...degrees.values(), 1);
  const maxWeight = graph.edges.length
    ? Math.max(...graph.edges.map((edge) => edge.weight))
    : 1;

  const normalizedNodes = graph.nodes.map((node) => {
    const degree = degrees.get(node.id) || 0;
    const cleanLabel = formatConcept(node.label);
    return {
      id: node.id,
      label: cleanLabel,
      value: Math.max(1, degree),
      title: `${cleanLabel} · ${degree} link${degree === 1 ? '' : 's'}`,
      physics: false,
      fixed: { x: true, y: true },
      size: scaleNodeSize(degree, maxDegree),
      font: {
        size: clamp(16 + degree * 1.2, 16, 28),
        face: 'Inter',
        color: '#0f172a'
      }
    };
  });

  const normalizedEdges = graph.edges.map((edge) => ({
    id: `${edge.from}-${edge.to}`,
    from: edge.from,
    to: edge.to,
    width: scaleEdgeWidth(edge.weight, maxWeight),
    label: edge.weight.toString(),
    font: {
      size: scaleEdgeFont(edge.weight, maxWeight),
      color: '#475467',
      vadjust: -12,
      strokeWidth: 0
    }
  }));

  networkData.nodes.clear();
  networkData.edges.clear();
  networkData.nodes.add(normalizedNodes);
  networkData.edges.add(normalizedEdges);

  applyViewMode(activeView);
};

const handleViewToggle = (event) => {
  const button = event.target.closest('button[data-view-mode]');
  if (!button) return;
  applyViewMode(button.dataset.viewMode);
};

if (viewToggle) {
  viewToggle.addEventListener('click', handleViewToggle);
}

const disableSessionForm = (disabled, message = '') => {
  const inputs = form.querySelectorAll('input, button');
  inputs.forEach((el) => {
    el.disabled = disabled;
  });
  setFeedback(message, disabled ? 'warning' : '');
};

const showExampleBanner = (visible) => {
  exampleBanner.classList.toggle('hidden', !visible);
};

const showSessionShell = (visible) => {
  sessionShell.classList.toggle('hidden', !visible);
  introSection.classList.toggle('hidden', visible);
  launchSection.classList.toggle('hidden', visible);
};

const updateShareLink = (code) => {
  if (!shareLinkInput) return;
  if (!code) {
    shareContainer.classList.add('hidden');
    shareLinkInput.value = '';
    return;
  }
  const url = `${window.location.origin}${window.location.pathname}?code=${encodeURIComponent(code)}`;
  shareLinkInput.value = url;
  shareContainer.classList.remove('hidden');
};

const updateSessionUI = () => {
  if (!state.session) return;
  const { session, isExample } = state;
  const title = session.name || (isExample ? 'Example session' : 'Untitled session');
  sessionTitle.textContent = title;

  if (isExample) {
    sessionPill.textContent = 'Example view';
    sessionPill.classList.add('pill-example');
    sessionSubtitle.textContent = 'Use this preview to show students what the network looks like.';
    updateShareLink(null);
    disableSessionForm(true, 'This is a read-only example. Start or join a session to contribute.');
  } else {
    sessionPill.textContent = `Session: ${session.code}`;
    sessionPill.classList.remove('pill-example');
    sessionSubtitle.textContent = 'Share the link below with your class. Every submission updates the network live.';
    updateShareLink(session.code);
    disableSessionForm(false);
  }
};

const leaveActiveSession = () => {
  if (activeSessionCode) {
    socket.emit('session:leave', activeSessionCode);
  }
  activeSessionCode = null;
};

const joinSocketSession = (code) => {
  if (!code) return;
  leaveActiveSession();
  activeSessionCode = code;
  socket.emit('session:join', code);
};

const applyGraphResponse = (payload, isExample = false) => {
  if (!payload) return;
  state.session = payload.session;
  state.isExample = isExample;
  updateSessionUI();
  showExampleBanner(isExample);
  showSessionShell(true);
  renderGraph(payload.graph);
};

const fetchSessionGraph = async (code) => {
  const response = await fetch(`/api/session/${encodeURIComponent(code)}/graph`);
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.error || 'Unable to load session.');
  }
  return response.json();
};

const createSession = async (name) => {
  const response = await fetch('/api/session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name })
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.error || 'Unable to create session.');
  }

  const payload = await response.json();
  const { session } = payload;
  const graphPayload = await fetchSessionGraph(session.code);
  joinSocketSession(session.code);
  applyGraphResponse(graphPayload, false);
  const url = new URL(window.location.href);
  url.searchParams.set('code', session.code);
  window.history.replaceState({}, '', url.toString());
};

const joinSession = async (code) => {
  const normalized = code.trim().toLowerCase();
  const payload = await fetchSessionGraph(normalized);
  joinSocketSession(normalized);
  applyGraphResponse(payload, false);
  setJoinFeedback('', '');
  const url = new URL(window.location.href);
  url.searchParams.set('code', normalized);
  window.history.replaceState({}, '', url.toString());
};

const showExample = async () => {
  const payload = await fetchSessionGraph(DEMO_SESSION);
  leaveActiveSession();
  applyGraphResponse(payload, true);
  setJoinFeedback('', '');
  const url = new URL(window.location.href);
  url.searchParams.delete('code');
  window.history.replaceState({}, '', url.toString());
};

const resetToLanding = () => {
  leaveActiveSession();
  state.session = null;
  state.isExample = false;
  networkData.nodes.clear();
  networkData.edges.clear();
  showSessionShell(false);
  showExampleBanner(false);
  setFeedback('', '');
  setJoinFeedback('', '');
  updateShareLink(null);
  const url = new URL(window.location.href);
  url.searchParams.delete('code');
  window.history.replaceState({}, '', url.toString());
};

createSessionForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const formData = new FormData(createSessionForm);
  const name = formData.get('name')?.toString().trim() || undefined;
  try {
    await createSession(name);
  } catch (error) {
    setJoinFeedback(error.message, 'warning');
  }
});

joinSessionForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const formData = new FormData(joinSessionForm);
  const code = formData.get('code')?.toString();
  if (!code) {
    setJoinFeedback('Enter a session code to join.', 'warning');
    return;
  }
  try {
    await joinSession(code);
  } catch (error) {
    setJoinFeedback(error.message, 'warning');
  }
});

showExampleBtn.addEventListener('click', () => {
  showExample().catch((error) => {
    setJoinFeedback(error.message, 'warning');
  });
});

copyShareLinkBtn.addEventListener('click', async () => {
  if (!shareLinkInput.value) return;
  try {
    await navigator.clipboard.writeText(shareLinkInput.value);
    copyShareLinkBtn.textContent = 'Copied!';
    setTimeout(() => {
      copyShareLinkBtn.textContent = 'Copy';
    }, 1800);
  } catch {
    copyShareLinkBtn.textContent = 'Press Cmd+C';
    setTimeout(() => {
      copyShareLinkBtn.textContent = 'Copy';
    }, 1800);
  }
});

closeSessionBtn.addEventListener('click', () => {
  resetToLanding();
});

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!state.session || state.isExample) {
    setFeedback('This example view is read-only. Join a live session to contribute.', 'warning');
    return;
  }

  const formData = new FormData(form);
  const source = formData.get('source')?.toString().trim();
  const target = formData.get('target')?.toString().trim();

  if (!source || !target) {
    setFeedback('Please enter a concept in both fields.', 'warning');
    return;
  }

  if (source.toLowerCase() === target.toLowerCase()) {
    setFeedback('Concepts must be distinct.', 'warning');
    return;
  }

  try {
    const response = await fetch(`/api/session/${encodeURIComponent(state.session.code)}/submit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source, target })
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error.error || 'Unable to submit concepts.');
    }

    const result = await response.json();

    if (result.status === 'duplicate') {
      setFeedback('You already counted that link this session.', 'warning');
    } else {
      setFeedback('Thanks! Your link has been recorded.', 'success');
    }

    if (result.graph) {
      renderGraph(result.graph);
    }

    form.reset();
    form.source?.focus();
  } catch (err) {
    setFeedback(err.message || 'Something went wrong.', 'warning');
  }
});

socket.on('graph:update', (graph) => {
  if (!state.session || !activeSessionCode) return;
  renderGraph(graph);
});

const bootstrap = async () => {
  const url = new URL(window.location.href);
  const code = url.searchParams.get('code');
  if (!code) return;

  try {
    await joinSession(code);
  } catch (error) {
    setJoinFeedback(error.message, 'warning');
  }
};

bootstrap();

