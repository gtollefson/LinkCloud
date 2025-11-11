const form = document.getElementById('concept-form');
const feedback = document.getElementById('feedback');
const graphContainer = document.getElementById('graph');
const viewToggle = document.querySelector('.view-toggle');

const socket = io();

const palette = ['#3f8cff', '#22c55e', '#f97316', '#8b5cf6', '#ef4444', '#14b8a6'];

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
      roundness: 0.28
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
  physics: false
};

const freeModeOptions = {
  physics: {
    enabled: true,
    solver: 'forceAtlas2Based',
    springConstant: 0.02,
    springLength: 140,
    damping: 0.38,
    stabilization: {
      enabled: true,
      iterations: 220
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
  }
};

let activeView = 'focused';

const setFeedback = (message, type = '') => {
  feedback.textContent = message;
  feedback.className = `feedback ${type}`.trim();
};

const formatConcept = (text) =>
  text.replace(/\b\w/g, (char) => char.toUpperCase());

const scaleWidth = (weight) => {
  const minWidth = 1;
  const maxWidth = 12;
  const maxWeight = 10;
  return minWidth + ((Math.min(weight, maxWeight) - 1) / (maxWeight - 1)) * (maxWidth - minWidth);
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
  const baseRadius = Math.min(width, height) * 0.22;
  const radiusStep = Math.min(width, height) * 0.18;

  const levelMap = new Map();

  nodes.forEach((node) => {
    const level = distances.has(node.id) ? distances.get(node.id) : Number.MAX_SAFE_INTEGER;
    if (!levelMap.has(level)) levelMap.set(level, []);
    levelMap.get(level).push(node.id);
  });

  const sortedLevels = [...levelMap.entries()].sort((a, b) => a[0] - b[0]);

  sortedLevels.forEach(([level, ids]) => {
    if (level === 0 || level === Number.MAX_SAFE_INTEGER) {
      ids.forEach((id, index) => {
        const offset = index * 40;
        positions.set(id, { x: offset, y: offset });
      });
      return;
    }

    const radius = baseRadius + radiusStep * (level - 1);
    const angleStep = (2 * Math.PI) / ids.length;
    ids.forEach((id, index) => {
      const angle = angleStep * index - Math.PI / 2;
      positions.set(id, {
        x: Math.cos(angle) * radius,
        y: Math.sin(angle) * radius
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

  const levelAssignments = new Map();
  let maxKnownLevel = 0;

  nodes.forEach((node) => {
    if (distances.has(node.id)) {
      const level = distances.get(node.id);
      levelAssignments.set(node.id, level);
      maxKnownLevel = Math.max(maxKnownLevel, level);
    }
  });

  let extraLevel = maxKnownLevel + 1;
  nodes.forEach((node) => {
    if (!levelAssignments.has(node.id)) {
      levelAssignments.set(node.id, extraLevel);
      extraLevel += 1;
    }
  });

  const levelBuckets = new Map();
  levelAssignments.forEach((level, id) => {
    if (!levelBuckets.has(level)) levelBuckets.set(level, []);
    levelBuckets.get(level).push(id);
  });

  const sortedLevels = [...levelBuckets.entries()].sort((a, b) => a[0] - b[0]);

  const layerHeight = 160;
  const nodeSpacing = 160;

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
    network.stabilize(200);
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
      size: 18 + Math.min(12, (degree / maxDegree) * 16)
    };
  });

  const normalizedEdges = graph.edges.map((edge) => ({
    id: `${edge.from}-${edge.to}`,
    from: edge.from,
    to: edge.to,
    width: scaleWidth(edge.weight),
    label: edge.weight.toString(),
    font: { size: 13, color: '#475467', vadjust: -10, strokeWidth: 0 }
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

form.addEventListener('submit', async (event) => {
  event.preventDefault();

  const formData = new FormData(form);
  const source = formData.get('source')?.trim();
  const target = formData.get('target')?.trim();

  if (!source || !target) {
    setFeedback('Please enter a concept in both fields.', 'warning');
    return;
  }

  if (source.toLowerCase() === target.toLowerCase()) {
    setFeedback('Concepts must be distinct.', 'warning');
    return;
  }

  try {
    const response = await fetch('/api/submit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source, target })
    });

    if (!response.ok) {
      const error = await response.json();
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
  renderGraph(graph);
});

const bootstrap = async () => {
  try {
    const res = await fetch('/api/graph');
    if (!res.ok) throw new Error('Failed to load initial data');
    const graph = await res.json();
    renderGraph(graph);
  } catch (err) {
    setFeedback('Could not load initial data. Please refresh.', 'warning');
  }
};

bootstrap();

