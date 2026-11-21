(() => {
  'use strict';

  const id = name => document.getElementById('wf-' + name);
  const root = document.getElementById('builder');
  const viewport = id('viewport');
  const canvas = id('canvas');
  const plane = id('plane');
  const svg = 'http://www.w3.org/2000/svg';
  const groups = {
    trigger: ['Триггеры', '↯'], scanner: ['Анализаторы', '⌕'],
    logic: ['Логика', '⑂'], output: ['Результаты', '◇'],
  };
  const kinds = {start: 'старт', findings: 'находки', report: 'отчёт'};
  const storageKey = 'cybergarden.workflow.current';
  let library, graph, storedId, selected, connection, moving;
  let dirty = false;
  let busy = false;
  let runVersion = 0;
  let pinnedRun = '';
  let currentRun = null;
  let shownState = '';
  let shownHistory = '';
  let polling = false;
  let zoom = 1;
  let framePending = false;
  let panMode = false;
  let panning = null;
  let historyRows = [];
  let historySelection = 0;
  const runLabels = {
    queued: 'В очереди', pending: 'Ожидает', running: 'Выполняется', success: 'Завершено',
    partial: 'Частично завершено', failed: 'Ошибка', skipped: 'Пропущено', interrupted: 'Прервано',
  };

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function button(className, title) {
    const control = element('button', className, title);
    control.type = 'button';
    return control;
  }

  function feedback(text, state = '', errors = []) {
    id('status').textContent = text;
    const list = id('errors');
    list.replaceChildren(...errors.map(error => element('li', null, error)));
    list.hidden = !errors.length;
    list.parentElement.dataset.state = state;
  }

  async function request(path, body) {
    const response = await fetch(path, body === undefined ? undefined : {
      method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body),
    });
    const data = await response.json();
    if (!response.ok) {
      const error = new Error('Запрос не выполнен.');
      error.details = data.errors;
      throw error;
    }
    return data;
  }

  function setBusy(value) {
    busy = value;
    root.querySelector('.wf-workspace').inert = value;
    root.querySelectorAll('.wf-toolbar input, .wf-toolbar select, .wf-toolbar button').forEach(
      control => { control.disabled = value; },
    );
    syncRunButton();
  }

  function changed(message = 'Есть несохранённые изменения.') {
    dirty = true;
    syncRunButton();
    feedback(message);
  }

  function mayReplace() {
    return !dirty || window.confirm('Открыть другой граф без сохранения текущих изменений?');
  }

  function remember(key) {
    try {
      if (key) localStorage.setItem(storageKey, key);
      else localStorage.removeItem(storageKey);
    } catch {
      // The workflow remains available from the server list.
    }
  }

  function replaceGraph(next, key) {
    graph = next;
    for (const node of graph.nodes) {
      if (node.type === 'schedule') {
        node.params = {enabled: false, mode: 'interval', time: '09:00', timezone: 'UTC',
                       intervalMinutes: 60, ...node.params};
      }
    }
    storedId = key;
    dirty = false;
    selected = null;
    moving = null;
    connection = null;
    id('name').value = graph.name;
    id('saved').value = key || '';
    remember(key);
    viewport.scrollTo(0, 0);
    resetExecution();
    render();
    refreshExecution();
  }

  function emptyGraph() {
    return {version: library.version, name: 'Новый workflow', nodes: [], edges: []};
  }

  function findNode(key) {
    return graph.nodes.find(node => node.id === key);
  }

  function clamp(number) {
    return Math.max(0, Math.min(library.limits.coordinate, Math.round(number)));
  }

  function canvasPoint(clientX, clientY) {
    const frame = canvas.getBoundingClientRect();
    return {x: (clientX - frame.left) / zoom, y: (clientY - frame.top) / zoom};
  }

  function addNode(type, x, y) {
    if (busy || !graph || !Object.hasOwn(library.nodeTypes, type)) return;
    if (graph.nodes.length >= library.limits.nodes) {
      feedback('Достигнут лимит нод.', 'error');
      return;
    }
    const spec = library.nodeTypes[type];
    const node = {
      id: crypto.randomUUID().replaceAll('-', '').slice(0, 12), type, x: clamp(x), y: clamp(y),
      params: Object.fromEntries(Object.entries(spec.params).map(([key, field]) => [key, field.default])),
    };
    graph.nodes.push(node);
    selected = node;
    connection = null;
    changed();
    render();
  }

  function renderLibrary() {
    for (const [group, [label, glyph]] of Object.entries(groups)) {
      id('library').append(element('div', 'wf-group', label));
      for (const [type, spec] of Object.entries(library.nodeTypes)) {
        if (spec.group !== group) continue;
        const tile = button('wf-tile');
        tile.append(element('span', 'wf-glyph', glyph), element('span', null, spec.title));
        tile.dataset.group = group;
        tile.dataset.type = type;
        tile.title = spec.description;
        tile.draggable = true;
        tile.addEventListener('dragstart', event => {
          event.dataTransfer.effectAllowed = 'copy';
          event.dataTransfer.setData('application/x-cybergarden-node', type);
        });
        tile.addEventListener('dragend', () => canvas.classList.remove('wf-dropping'));
        tile.addEventListener('click', () => {
          let x = viewport.scrollLeft / zoom + 28;
          let y = viewport.scrollTop / zoom + 30;
          while (graph.nodes.some(node => Math.abs(node.x - x) < 192 && Math.abs(node.y - y) < 108)
                 && y < library.limits.coordinate) y += 112;
          addNode(type, x, y);
          viewport.scrollTop = Math.max(viewport.scrollTop, (y + 112) * zoom - viewport.clientHeight);
        });
        id('library').append(tile);
      }
    }
    for (const [index, entry] of library.templates.entries()) {
      id('template').add(new Option(entry.name, String(index)));
    }
  }

  function renderPort(node, side, key, spec) {
    const control = button('wf-port');
    control.dataset.side = side;
    control.dataset.port = key;
    const pin = element('span', 'wf-pin');
    pin.setAttribute('aria-hidden', 'true');
    const label = element('span', null, spec.label);
    control.append(...(side === 'out' ? [label, pin] : [pin, label]));
    const title = (side === 'out' ? 'Выход: ' : 'Вход: ') + spec.label;
    control.setAttribute('aria-label', library.nodeTypes[node.type].title + ' · ' + title);
    control.title = title + ' · ' + (spec.types || [spec.type]).map(type => kinds[type]).join(' / ');
    control.addEventListener('click', () => usePort(node, side, key));
    return control;
  }

  function renderCard(node) {
    const spec = library.nodeTypes[node.type];
    const card = element('div', 'wf-node');
    card.dataset.node = node.id;
    card.dataset.type = node.type;
    card.dataset.group = spec.group;
    card.style.left = node.x + 'px';
    card.style.top = node.y + 'px';
    const handle = button('wf-node-head');
    handle.append(element('span', 'wf-glyph', groups[spec.group][1]), element('span', null, spec.title));
    handle.title = spec.description;
    handle.addEventListener('click', () => select(node));
    handle.addEventListener('pointerdown', event => {
      if (event.button !== 0) return;
      select(node);
      moving = {node, card, pointerId: event.pointerId, point: canvasPoint(event.clientX, event.clientY),
                x: node.x, y: node.y};
      handle.setPointerCapture(event.pointerId);
    });
    const ports = element('div', 'wf-ports');
    const incoming = element('div');
    for (const [key, port] of Object.entries(spec.inputs)) incoming.append(renderPort(node, 'in', key, port));
    const outgoing = element('div');
    for (const [key, port] of Object.entries(spec.outputs)) outgoing.append(renderPort(node, 'out', key, port));
    ports.append(incoming, outgoing);
    card.append(handle, ports);
    card.append(element('span', 'wf-run-node'));
    return card;
  }

  function fitCanvas() {
    const width = Math.max(viewport.clientWidth / zoom, ...graph.nodes.map(node => node.x + 226));
    const height = Math.max(viewport.clientHeight / zoom, ...graph.nodes.map(node => node.y + 148));
    canvas.style.width = width + 'px';
    canvas.style.height = height + 'px';
    plane.style.width = Math.ceil(width * zoom) + 'px';
    plane.style.height = Math.ceil(height * zoom) + 'px';
  }

  function setZoom(wanted) {
    const next = Math.max(0.5, Math.min(1.6, Math.round(wanted * 100) / 100));
    const centerX = viewport.clientWidth / 2;
    const centerY = viewport.clientHeight / 2;
    const x = (viewport.scrollLeft + centerX) * next / zoom - centerX;
    const y = (viewport.scrollTop + centerY) * next / zoom - centerY;
    zoom = next;
    canvas.style.transform = 'scale(' + zoom + ')';
    id('zoom-reset').textContent = Math.round(zoom * 100) + '%';
    fitCanvas();
    viewport.scrollTo(x, y);
    drawEdges();
  }

  function portElement(nodeId, side, port) {
    return id('nodes').querySelector('[data-node="' + nodeId + '"] [data-side="' + side + '"][data-port="' + port + '"]');
  }

  function pinPosition(nodeId, side, port) {
    const pin = portElement(nodeId, side, port)?.querySelector('.wf-pin');
    if (!pin) return null;
    const box = pin.getBoundingClientRect();
    return canvasPoint(box.left + box.width / 2, box.top + box.height / 2);
  }

  function line(from, to) {
    const bend = Math.max(34, Math.min(148, Math.abs(to.x - from.x) * 0.45));
    return ['M', from.x, from.y, 'C', from.x + bend, from.y, to.x - bend, to.y, to.x, to.y].join(' ');
  }

  function drawEdges() {
    const fragment = document.createDocumentFragment();
    const positions = new Map();
    function position(node, side, port) {
      const key = [node, side, port].join(':');
      if (!positions.has(key)) positions.set(key, pinPosition(node, side, port));
      return positions.get(key);
    }
    const branches = new Map((currentRun?.nodes || []).filter(node => node.branch).map(node => [node.id, node.branch]));
    for (const edge of graph.edges) {
      const from = position(edge.source, 'out', edge.sourcePort);
      const to = position(edge.target, 'in', edge.targetPort);
      if (!from || !to) continue;
      const path = line(from, {x: to.x - 8, y: to.y});
      const wire = document.createElementNS(svg, 'path');
      wire.setAttribute('class', selected === edge ? 'wf-wire is-selected' : 'wf-wire');
      if (branches.has(edge.source) && edge.sourcePort !== branches.get(edge.source)) {
        wire.classList.add('is-inactive-branch');
      }
      wire.setAttribute('d', path);
      wire.dataset.port = edge.sourcePort;
      const hit = document.createElementNS(svg, 'path');
      hit.setAttribute('class', 'wf-wire-hit');
      hit.setAttribute('d', path);
      hit.setAttribute('tabindex', '0');
      hit.setAttribute('role', 'button');
      hit.setAttribute('aria-label', edgeLabel(edge));
      hit.addEventListener('click', () => select(edge));
      hit.addEventListener('keydown', event => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          select(edge);
        }
      });
      fragment.append(wire, hit);
    }
    id('edges').replaceChildren(fragment);
  }

  function queueWireDraw() {
    if (framePending) return;
    framePending = true;
    requestAnimationFrame(() => {
      framePending = false;
      drawEdges();
    });
  }

  function edgeLabel(edge) {
    const source = library.nodeTypes[findNode(edge.source).type];
    const target = library.nodeTypes[findNode(edge.target).type];
    return source.title + ' (' + source.outputs[edge.sourcePort].label + ') → ' + target.title;
  }

  function renderInspector() {
    const panel = id('inspector');
    panel.replaceChildren();
    if (!selected) {
      panel.append(element('p', null, 'Выберите ноду или связь.'));
      return;
    }
    const remove = button('wf-remove', selected.source ? 'Удалить связь' : 'Удалить ноду');
    remove.addEventListener('click', removeSelection);
    if (selected.source) {
      panel.append(element('h3', null, 'Связь'), element('p', null, edgeLabel(selected)), remove);
      return;
    }
    const node = selected;
    const spec = library.nodeTypes[node.type];
    panel.append(element('h3', null, spec.title), element('p', null, spec.description));
    for (const [name, field] of Object.entries(spec.params)) {
      const label = element('label', 'wf-field', field.label);
      if (node.type === 'schedule') {
        label.hidden = (name === 'intervalMinutes' && node.params.mode !== 'interval')
          || (['time', 'timezone'].includes(name) && node.params.mode !== 'daily');
      }
      let control;
      if (field.kind === 'select') {
        control = element('select');
        field.choices.forEach((value, index) => control.add(new Option(field.labels?.[index] || value, value)));
      } else {
        control = element('input');
        if (field.kind === 'boolean') {
          control.type = 'checkbox';
          control.checked = node.params[name] ?? field.default;
        } else if (field.kind === 'integer') {
          control.type = 'number';
          control.min = field.min;
          control.max = field.max;
          control.step = 1;
        } else {
          control.maxLength = field.maxLength;
        }
      }
      control.dataset.param = name;
      if (field.kind !== 'boolean') control.value = node.params[name] ?? '';
      control.addEventListener('input', () => {
        let value = control.value;
        if (field.kind === 'integer') value = value === '' ? null : Number(value);
        if (field.kind === 'boolean') value = control.checked;
        node.params[name] = value;
        changed();
        if (node.type === 'schedule' && name === 'mode') {
          renderInspector();
          panel.querySelector('[data-param="mode"]').focus();
        }
      });
      label.append(control);
      panel.append(label);
    }
    panel.append(remove);
  }

  function updateSelection() {
    for (const card of id('nodes').children) {
      card.classList.toggle('is-selected', card.dataset.node === selected?.id);
    }
    id('nodes').querySelector('.is-connecting')?.classList.remove('is-connecting');
    viewport.classList.toggle('is-linking', Boolean(connection));
    for (const port of id('nodes').querySelectorAll('[data-side="in"]')) {
      const target = findNode(port.closest('[data-node]').dataset.node);
      const source = connection && findNode(connection.source);
      const compatible = source && library.nodeTypes[target.type].inputs[port.dataset.port].types
        .includes(library.nodeTypes[source.type].outputs[connection.sourcePort].type);
      port.classList.toggle('is-compatible', Boolean(compatible && !canReach(target.id, source.id)));
    }
    if (connection) portElement(connection.source, 'out', connection.sourcePort)?.classList.add('is-connecting');
    else id('preview').setAttribute('visibility', 'hidden');
    drawEdges();
    renderInspector();
    paintSelectedNode();
  }

  function select(item) {
    selected = item;
    updateSelection();
  }

  function render() {
    fitCanvas();
    id('empty').hidden = graph.nodes.length > 0;
    id('count').textContent = 'Ноды: ' + graph.nodes.length + ' · Связи: ' + graph.edges.length;
    id('nodes').replaceChildren(...graph.nodes.map(renderCard));
    updateSelection();
    paintRun();
  }

  function canReach(start, end) {
    const visited = new Set();
    const pending = [start];
    while (pending.length) {
      const key = pending.pop();
      if (key === end) return true;
      if (visited.has(key)) continue;
      visited.add(key);
      for (const edge of graph.edges) if (edge.source === key) pending.push(edge.target);
    }
    return false;
  }

  function usePort(node, side, port) {
    if (side === 'out') {
      connection = {source: node.id, sourcePort: port};
      select(node);
      feedback('Выберите вход целевой ноды. Escape отменяет соединение.');
      return;
    }
    if (!connection) {
      feedback('Сначала выберите выход исходной ноды.', 'error');
      return;
    }
    const output = library.nodeTypes[findNode(connection.source).type].outputs[connection.sourcePort];
    const input = library.nodeTypes[node.type].inputs[port];
    if (!input.types.includes(output.type)) {
      feedback('Несовместимые порты: выход передаёт «' + kinds[output.type] + '».', 'error');
      return;
    }
    if (graph.edges.some(edge => edge.source === connection.source && edge.sourcePort === connection.sourcePort
                         && edge.target === node.id && edge.targetPort === port)) {
      feedback('Такая связь уже есть.', 'error');
      return;
    }
    if (canReach(node.id, connection.source)) {
      feedback('Эта связь создаёт цикл.', 'error');
      return;
    }
    if (graph.edges.length >= library.limits.edges) {
      feedback('Достигнут лимит связей.', 'error');
      return;
    }
    const edge = {...connection, target: node.id, targetPort: port};
    graph.edges.push(edge);
    selected = edge;
    connection = null;
    changed();
    render();
  }

  function removeSelection() {
    if (!selected || busy) return;
    if (selected.source) {
      graph.edges = graph.edges.filter(edge => edge !== selected);
    } else {
      graph.nodes = graph.nodes.filter(node => node !== selected);
      graph.edges = graph.edges.filter(edge => edge.source !== selected.id && edge.target !== selected.id);
    }
    selected = null;
    connection = null;
    changed();
    render();
  }

  async function updateSaved() {
    const data = await request('/api/workflows');
    id('saved').replaceChildren(new Option('Выбрать workflow', ''));
    for (const item of data.workflows) id('saved').add(new Option(item.name, item.id));
    id('saved').value = storedId || '';
    return data.workflows;
  }

  async function openWorkflow(key) {
    const record = await request('/api/workflows/' + encodeURIComponent(key));
    replaceGraph(record.graph, record.id);
    feedback('Загружено с диска.', 'success');
  }

  async function validateOrSave(save) {
    if (!graph || busy) return;
    setBusy(true);
    const body = {graph};
    if (save && storedId) body.id = storedId;
    try {
      const data = await request(save ? '/api/workflows' : '/api/workflows/validate', body);
      if (save) {
        storedId = data.id;
        dirty = false;
        remember(storedId);
        resetExecution();
        refreshExecution();
        try {
          await updateSaved();
          feedback('Workflow сохранён на диске.', 'success');
        } catch {
          feedback('Workflow сохранён. Список сохранённых сценариев пока недоступен.');
        }
      } else {
        feedback('Структура графа и параметры корректны.', 'success');
      }
    } catch (error) {
      feedback(save ? 'Сохранение не выполнено.' : 'Проверка не завершилась успешно.', 'error',
               error.details || [error.message]);
    } finally {
      setBusy(false);
    }
  }

  function syncRunButton() {
    id('run').disabled = busy || !storedId || dirty;
    id('archive').disabled = busy || !storedId;
    id('run').title = dirty || !storedId ? 'Сохраните изменения перед запуском' : 'Запустить сохранённый workflow';
  }

  function resetExecution() {
    runVersion += 1;
    pinnedRun = '';
    currentRun = null;
    shownState = '';
    shownHistory = '';
    id('run-status').textContent = storedId ? 'Загрузка запусков…' : 'Сохраните workflow для запуска.';
    id('schedule-status').textContent = '';
    id('run-history').replaceChildren(new Option('Последний запуск', ''));
    id('run-history').disabled = true;
    id('run-details').replaceChildren();
    syncRunButton();
    paintRun();
  }

  function localTime(value) {
    return value ? new Date(value).toLocaleString('ru-RU') : '—';
  }

  function nodeRunLabel(node) {
    const branch = node.branch === 'true' ? ' · True' : (node.branch === 'false' ? ' · False' : '');
    return runLabels[node.status] + branch;
  }

  function packetLabel(packet) {
    const categories = Object.entries(packet.categories || {}).map(([name, count]) => name + ' ' + count).join(', ');
    return [kinds[packet.type], categories || (packet.type !== 'start' ? '0 находок' : ''),
            packet.analysisCount ? 'AI: ' + packet.analysisCount : ''].filter(Boolean).join(' · ');
  }

  function paintSelectedNode() {
    const panel = id('node-result');
    const state = currentRun?.nodes.find(node => node.id === selected?.id && node.type === selected?.type);
    panel.hidden = !state;
    panel.replaceChildren();
    if (!state) return;
    panel.append(element('h3', null, 'Результат ноды'));
    const status = element('p', 'wf-packet', [nodeRunLabel(state),
      state.durationMs == null ? '' : state.durationMs + ' мс',
      state.findingCount == null ? '' : 'Находок: ' + state.findingCount].filter(Boolean).join(' · '));
    status.dataset.runState = state.status;
    panel.append(status);
    for (const item of state.inputs || []) {
      panel.append(element('p', 'wf-packet', 'Вход ← ' + item.nodeId + ' · ' + packetLabel(item)));
    }
    for (const item of state.outputs || []) {
      const port = library.nodeTypes[state.type].outputs[item.port]?.label || item.port;
      panel.append(element('p', 'wf-packet', 'Выход ' + port + ' → ' + packetLabel(item)));
    }
    if (state.delivery) panel.append(element('p', null, deliveryLabel(state.delivery)));
    if (state.message) panel.append(element('p', null, state.message));
  }

  function paintRun() {
    const states = new Map((currentRun?.nodes || []).map(node => [node.id, node]));
    for (const card of id('nodes').children) {
      const state = states.get(card.dataset.node);
      const label = card.querySelector('.wf-run-node');
      label.hidden = !state;
      label.textContent = state ? [nodeRunLabel(state),
        state.durationMs == null ? '' : state.durationMs + ' мс',
        state.findingCount == null ? '' : state.findingCount + ' находок'].filter(Boolean).join(' · ') : '';
      card.dataset.runState = state?.status || '';
    }
    paintSelectedNode();
  }

  function showRun(run) {
    const signature = JSON.stringify(run);
    if (signature === shownState) return false;
    shownState = signature;
    currentRun = run;
    paintRun();
    drawEdges();
    const panel = id('run-details');
    panel.replaceChildren();
    if (!run) {
      id('run-status').textContent = 'Для этого workflow пока нет запусков.';
      return true;
    }
    id('run-status').textContent = [
      runLabels[run.status], run.trigger === 'schedule' ? 'По расписанию' : 'Ручной запуск',
      localTime(run.startedAt || run.queuedAt), 'Находок: ' + run.findingCount,
      run.durationMs == null ? '' : run.durationMs + ' мс',
    ].filter(Boolean).join(' · ');
    panel.append(runNodeList(run));
    return true;
  }

  function runNodeList(run) {
    const list = element('ul', 'wf-run-list');
    for (const node of run.nodes) {
      const title = library.nodeTypes[node.type]?.title || node.type;
      const description = [nodeRunLabel(node), node.durationMs == null ? '' : node.durationMs + ' мс',
                           node.findingCount == null ? '' : 'находок ' + node.findingCount,
                           node.delivery ? deliveryLabel(node.delivery) : '', node.message || '']
        .filter(Boolean).join(' · ');
      const item = element('li', null, title + ' (' + node.id + ') · ' + description);
      item.dataset.runState = node.status;
      list.append(item);
    }
    for (const error of run.errors) {
      const item = element('li', null, error);
      item.dataset.runState = 'failed';
      list.append(item);
    }
    return list;
  }

  function showRunResults(run, result, target = id('run-details')) {
    const panel = element('div', 'wf-run-results');
    if (!['queued', 'running'].includes(run.status) && !Object.keys(result.reports).length) {
      panel.append(element('h3', null, 'Экспорт находок запуска'));
      for (const [name, file] of [['JSON', 'findings.json'], ['Markdown', 'report.md']]) {
        const link = element('a', null, 'Скачать ' + name);
        link.href = '/api/workflow-runs/' + run.runId + '/exports/' + file;
        panel.append(link);
      }
    }
    for (const [nodeId, analysis] of Object.entries(result.analyses || {})) {
      panel.append(element('h3', null, 'AI Analysis · ' + nodeId),
                   element('p', null, analysis.provider + ' · ' + analysis.model + ' · '
                           + analysis.analyzedCount + ' из ' + analysis.inputCount + ' находок'),
                   element('p', null, analysis.summary));
      for (const finding of analysis.findings) {
        const details = element('details');
        const location = finding.path + (finding.line == null ? '' : ':' + finding.line)
          + (finding.endLine == null ? '' : '–' + finding.endLine);
        details.append(element('summary', null, finding.findingId + ' · ' + location
                               + (finding.advisoryId ? ' · ' + finding.advisoryId : '')),
                       element('p', null, 'Риск: ' + finding.risk),
                       element('p', null, 'Исправление: ' + finding.remediation));
        panel.append(details);
      }
    }
    for (const [nodeId, report] of Object.entries(result.reports)) {
      panel.append(element('h3', null, report.title));
      for (const [name, file] of [['JSON', 'findings.json'], ['Markdown', 'report.md']]) {
        const link = element('a', null, 'Скачать ' + name);
        link.href = '/api/workflow-runs/' + run.runId + '/reports/' + encodeURIComponent(nodeId) + '/' + file;
        panel.append(link);
      }
    }
    for (const [nodeId, receipt] of Object.entries(result.deliveries || {})) {
      panel.append(element('h3', null, 'Webhook · ' + nodeId),
                   element('p', null, deliveryLabel(receipt)));
    }
    if (result.findings.length) {
      const details = element('details');
      details.append(element('summary', null, 'Находки запуска (' + result.findings.length + ')'));
      const rows = element('ul');
      for (const item of result.findings) {
        const location = item.category === 'SCA'
          ? item.path + ' · ' + item.group + ':' + item.artifact + ':' + item.version + ' · ' + item.advisoryId
          : item.path + ':' + item.line + ' · ' + item.class;
        rows.append(element('li', null, item.category + ' · ' + item.severity + ' · ' + location));
      }
      details.append(rows);
      panel.append(details);
    }
    target.append(panel);
  }

  function deliveryLabel(receipt) {
    return [
      receipt.status === 'delivered' ? 'Доставлено' : 'Доставка не подтверждена',
      receipt.httpStatus ? 'HTTP ' + receipt.httpStatus : '',
      receipt.attempts == null ? '' : 'Попыток: ' + receipt.attempts,
      receipt.receiver?.accepted ? 'Получатель подтвердил runId' : '',
    ].filter(Boolean).join(' · ');
  }

  async function aiConfiguration(check = false) {
    const control = id('ai-check');
    control.disabled = true;
    try {
      if (check) id('ai-config').textContent = 'Проверяем доступность модели…';
      const response = await fetch(check ? '/api/ai/check' : '/api/ai/settings', check ? {
        method: 'POST', headers: {'Content-Type': 'application/json'}, body: '{}',
      } : undefined);
      const data = await response.json();
      id('ai-config').dataset.runState = check
        ? (data.connected ? 'success' : 'failed') : (data.configured ? '' : 'skipped');
      id('ai-config').textContent = [
        data.provider || 'Провайдер не настроен', data.model || '', data.message || '',
      ].filter(Boolean).join(' · ');
    } catch {
      id('ai-config').textContent = 'Не удалось получить данные от Dashboard.';
    } finally {
      control.disabled = false;
    }
  }

  async function refreshExecution() {
    if (!storedId || polling || !root.classList.contains('active')) return;
    const key = storedId;
    const token = runVersion;
    polling = true;
    try {
      const {runs} = await request('/api/workflow-runs?workflowId=' + encodeURIComponent(key));
      if (token !== runVersion) return;
      const select = id('run-history');
      const signature = JSON.stringify(runs);
      if (signature !== shownHistory) {
        shownHistory = signature;
        select.replaceChildren(new Option('Последний запуск', ''));
        for (const run of runs) {
          select.add(new Option(localTime(run.queuedAt) + ' · ' + runLabels[run.status], run.runId));
        }
        if (pinnedRun && !runs.some(run => run.runId === pinnedRun)) pinnedRun = '';
        select.value = pinnedRun;
        select.disabled = !runs.length;
      }
      const runId = pinnedRun || runs[0]?.runId;
      const run = runId ? await request('/api/workflow-runs/' + runId) : null;
      if (token !== runVersion) return;
      if (showRun(run) && run && !['queued', 'running'].includes(run.status)) {
        const result = await request('/api/workflow-runs/' + run.runId + '/results');
        if (token === runVersion) showRunResults(run, result);
      }
      if (graph.nodes.some(node => node.type === 'schedule')) {
        const {schedules} = await request('/api/workflows/' + key + '/schedule');
        if (token !== runVersion) return;
        id('schedule-status').textContent = schedules.map(schedule => {
          const label = 'Расписание ' + schedule.nodeId + ' · ';
          return label + (schedule.enabled ? 'следующий запуск ' + localTime(schedule.nextAt) : 'выключено');
        }).join(' / ');
      }
    } catch {
      if (token === runVersion) {
        shownState = '';
        id('schedule-status').textContent = '';
        id('run-status').textContent = 'Нет данных от исполнителя. Проверьте, запущен ли Dashboard.';
      }
    } finally {
      polling = false;
    }
  }

  async function startExecution() {
    if (busy || !storedId || dirty) return;
    setBusy(true);
    try {
      const run = await request('/api/workflows/' + storedId + '/run', {});
      runVersion += 1;
      pinnedRun = '';
      showRun(run);
      feedback('Запуск добавлен в очередь.', 'success');
      refreshExecution();
    } catch (error) {
      feedback('Не удалось запустить workflow.', 'error', error.details || [error.message]);
    } finally {
      setBusy(false);
    }
  }

  async function archiveWorkflow() {
    if (!storedId || busy) return;
    const warning = dirty ? ' Несохранённые изменения открытого графа будут потеряны.' : '';
    if (!window.confirm('Переместить workflow в архив? История запусков сохранится.' + warning)) return;
    setBusy(true);
    try {
      await request('/api/workflows/' + storedId + '/archive', {});
      replaceGraph(emptyGraph(), null);
      await updateSaved();
      feedback('Workflow перемещён в архив.', 'success');
    } catch (error) {
      feedback('Не удалось обновить список workflow.', 'error', error.details || [error.message]);
    } finally {
      setBusy(false);
    }
  }

  function renderHistory() {
    const status = id('history-status').value;
    const date = id('history-date').value;
    const rows = historyRows.filter(run => {
      const local = new Date(run.startedAt || run.queuedAt);
      const day = [local.getFullYear(), local.getMonth() + 1, local.getDate()]
        .map(value => String(value).padStart(2, '0')).join('-');
      return (!status || run.status === status) && (!date || day === date);
    });
    id('history-rows').replaceChildren(...rows.map(run => {
      const tr = element('tr');
      const open = button('wf-check', 'Открыть');
      open.setAttribute('aria-label', 'Открыть запуск «' + (run.workflowName || run.workflowId) + '»');
      open.addEventListener('click', () => openHistoryRun(run.runId));
      const flag = element('span', 'wf-history-state', runLabels[run.status]);
      flag.dataset.runState = run.status;
      const values = [run.workflowName || run.workflowId, localTime(run.startedAt || run.queuedAt), flag,
                      run.durationMs == null ? '—' : run.durationMs + ' мс', run.findingCount, open];
      for (const value of values) {
        const cell = element('td');
        cell.append(typeof value === 'object' ? value : String(value));
        tr.append(cell);
      }
      return tr;
    }));
    id('history-feedback').textContent = rows.length ? 'Запусков: ' + rows.length : 'По этим условиям запусков нет.';
  }

  async function loadHistory() {
    const control = id('history-refresh');
    if (control.disabled) return;
    control.disabled = true;
    id('history-feedback').textContent = 'Загрузка истории…';
    try {
      const {runs} = await request('/api/workflow-runs');
      historyRows = runs;
      renderHistory();
    } catch {
      id('history-feedback').textContent = 'Не удалось загрузить историю. Проверьте соединение с Dashboard.';
    } finally {
      control.disabled = false;
    }
  }

  async function openHistoryRun(runId) {
    const version = ++historySelection;
    const box = id('history-detail');
    box.hidden = false;
    box.replaceChildren(element('p', null, 'Загрузка результатов…'));
    try {
      const path = '/api/workflow-runs/' + runId;
      const [run, result] = await Promise.all([request(path), request(path + '/results')]);
      if (version !== historySelection) return;
      box.replaceChildren(element('h2', null, run.workflowName),
        element('p', null, runLabels[run.status] + ' · ' + localTime(run.startedAt || run.queuedAt)),
        runNodeList(run));
      showRunResults(run, result, box);
      box.scrollIntoView({block: 'nearest'});
    } catch {
      if (version === historySelection) box.replaceChildren(element('p', null, 'Результаты запуска недоступны.'));
    }
  }

  function bindEvents() {
    const mime = 'application/x-cybergarden-node';
    id('zoom-in').addEventListener('click', () => setZoom(zoom + 0.1));
    id('zoom-out').addEventListener('click', () => setZoom(zoom - 0.1));
    id('zoom-reset').addEventListener('click', () => setZoom(1));
    id('pan').addEventListener('click', event => {
      panMode = !panMode;
      event.currentTarget.setAttribute('aria-pressed', String(panMode));
      viewport.classList.toggle('is-panning', panMode);
    });
    viewport.addEventListener('pointerdown', event => {
      if (!(event.button === 1 || (panMode && event.button === 0)) || event.target.closest('.wf-node,.wf-wire-hit')) return;
      event.preventDefault();
      panning = {id: event.pointerId, x: event.clientX + viewport.scrollLeft, y: event.clientY + viewport.scrollTop};
      viewport.setPointerCapture(event.pointerId);
    });
    viewport.addEventListener('pointermove', event => {
      if (panning?.id === event.pointerId) viewport.scrollTo(panning.x - event.clientX, panning.y - event.clientY);
    });
    for (const name of ['pointerup', 'pointercancel', 'lostpointercapture']) {
      viewport.addEventListener(name, event => {
        if (panning?.id === event.pointerId) panning = null;
      });
    }
    viewport.addEventListener('dragover', event => {
      if (!event.dataTransfer.types.includes(mime)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'copy';
      canvas.classList.add('wf-dropping');
    });
    viewport.addEventListener('dragleave', event => {
      if (!viewport.contains(event.relatedTarget)) canvas.classList.remove('wf-dropping');
    });
    viewport.addEventListener('drop', event => {
      if (!event.dataTransfer.types.includes(mime)) return;
      event.preventDefault();
      canvas.classList.remove('wf-dropping');
      const point = canvasPoint(event.clientX, event.clientY);
      addNode(event.dataTransfer.getData(mime), point.x - 12, point.y - 14);
    });
    canvas.addEventListener('pointermove', event => {
      const point = canvasPoint(event.clientX, event.clientY);
      if (moving && moving.pointerId === event.pointerId) {
        const {node, card, x, y} = moving;
        node.x = clamp(x + point.x - moving.point.x);
        node.y = clamp(y + point.y - moving.point.y);
        card.style.left = node.x + 'px';
        card.style.top = node.y + 'px';
        fitCanvas();
        queueWireDraw();
      } else if (connection) {
        const from = pinPosition(connection.source, 'out', connection.sourcePort);
        if (from) {
          id('preview').setAttribute('d', line(from, point));
          id('preview').setAttribute('visibility', 'visible');
        }
      }
    });
    for (const eventName of ['pointerup', 'pointercancel', 'lostpointercapture']) {
      canvas.addEventListener(eventName, event => {
        if (moving?.pointerId !== event.pointerId) return;
        if (moving.node.x !== moving.x || moving.node.y !== moving.y) changed();
        moving = null;
      });
    }
    canvas.addEventListener('pointerleave', () => id('preview').setAttribute('visibility', 'hidden'));
    canvas.addEventListener('click', event => {
      if (event.target === canvas) {
        connection = null;
        select(null);
      }
    });
    root.addEventListener('keydown', event => {
      if (event.key === 'Escape' && connection) {
        connection = null;
        updateSelection();
        feedback(dirty ? 'Есть несохранённые изменения.' : 'Соединение отменено.');
      }
      if (event.key === 'Delete' && !event.target.closest('input,select,textarea')) removeSelection();
    });
    id('name').addEventListener('input', event => { graph.name = event.target.value; changed(); });
    id('new').addEventListener('click', () => {
      if (!mayReplace()) return;
      replaceGraph(emptyGraph(), null);
      feedback('Новый workflow.');
    });
    id('template').addEventListener('change', event => {
      const key = event.target.value;
      event.target.value = '';
      if (key === '' || !mayReplace()) return;
      replaceGraph(structuredClone(library.templates[Number(key)]), null);
      changed('Шаблон открыт как новый workflow. Сохраните свою копию после редактирования.');
    });
    id('saved').addEventListener('change', async event => {
      const key = event.target.value;
      event.target.value = storedId || '';
      if (!key || !mayReplace()) return;
      setBusy(true);
      try {
        await openWorkflow(key);
      } catch (error) {
        feedback('Не удалось открыть workflow.', 'error', error.details || [error.message]);
      } finally {
        setBusy(false);
      }
    });
    id('validate').addEventListener('click', () => validateOrSave(false));
    id('save').addEventListener('click', () => validateOrSave(true));
    id('run').addEventListener('click', startExecution);
    id('archive').addEventListener('click', archiveWorkflow);
    id('ai-check').addEventListener('click', () => aiConfiguration(true));
    id('history-refresh').addEventListener('click', loadHistory);
    id('history-status').addEventListener('change', renderHistory);
    id('history-date').addEventListener('change', renderHistory);
    document.addEventListener('dashboard:view', event => {
      if (event.detail === 'history') loadHistory();
    });
    id('run-history').addEventListener('change', event => {
      runVersion += 1;
      pinnedRun = event.target.value;
      refreshExecution();
    });
    let nextIdlePoll = 0;
    window.setInterval(() => {
      if (['queued', 'running'].includes(currentRun?.status) || Date.now() >= nextIdlePoll) {
        nextIdlePoll = Date.now() + 2000;
        refreshExecution();
      }
    }, 400);
    window.addEventListener('beforeunload', event => {
      if (dirty) { event.preventDefault(); event.returnValue = true; }
    });
    new ResizeObserver(() => {
      if (!viewport.clientWidth) return;
      fitCanvas();
      drawEdges();
    }).observe(viewport);
  }

  async function initialize() {
    setBusy(true);
    try {
      library = await request('/api/workflow-library');
      let previous;
      try { previous = localStorage.getItem(storageKey); } catch { previous = null; }
      renderLibrary();
      replaceGraph(emptyGraph(), null);
      bindEvents();
      aiConfiguration();
      const records = await updateSaved();
      if (records.some(item => item.id === previous)) await openWorkflow(previous);
      else feedback('Добавьте ноды или откройте шаблон.');
    } catch (error) {
      feedback('Не удалось загрузить данные Workflow Builder.', 'error', error.details || [error.message]);
    } finally {
      if (graph) setBusy(false);
    }
  }

  initialize();
})();

