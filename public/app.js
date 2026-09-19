// 页面交互：项目清单与依赖登记都从服务端拉取，任何一步失败都把说明显示在顶部并标到对应输入项上

const state = {
  projects: [],
  deps: [],
  licenses: [],
  statuses: [],
  editingId: '',
  conflicts: [],
};

const el = (id) => document.getElementById(id);

// 统一的请求入口：出错时把服务端给的错误码、说明与出错位置一起抛出去
async function request(path, options) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  let payload = null;
  try {
    payload = await res.json();
  } catch (err) {
    payload = null;
  }
  if (!res.ok) {
    const error = (payload && payload.error) || {};
    const failure = new Error(error.message || `请求失败（状态码 ${res.status}）`);
    failure.code = error.code || '';
    failure.field = error.field || '';
    failure.extra = error.extra || null;
    throw failure;
  }
  return payload;
}

function notify(message, kind) {
  const box = el('notice');
  box.textContent = message;
  box.className = `notice ${kind === 'ok' ? 'ok' : 'error'}`;
}

function clearNotice() {
  const box = el('notice');
  box.className = 'notice hidden';
  box.textContent = '';
}

function clearFieldMarks() {
  document.querySelectorAll('.invalid').forEach((node) => node.classList.remove('invalid'));
}

// 把出错位置标到具体输入项上：项目区与依赖区共用一套标记
function markField(field) {
  if (!field) return;
  const target = document.querySelector(`[data-field="${field}"]`);
  if (!target) return;
  target.classList.add('invalid');
  const input = ['INPUT', 'SELECT', 'TEXTAREA'].includes(target.tagName)
    ? target
    : target.querySelector('input, select, textarea');
  if (input) input.focus();
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatTime(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const pad = (num) => String(num).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

// 操作者名字记在浏览器里，刷新之后还在，保存时随请求一起带上
const OPERATOR_KEY = 'dep-ledger-operator';

function currentOperator() {
  return el('operator').value.trim();
}

function restoreOperator() {
  el('operator').value = window.localStorage.getItem(OPERATOR_KEY) || '';
}

async function loadHealth() {
  try {
    await request('/api/health');
    el('health').textContent = '服务正常';
    el('health').className = 'health ok';
  } catch (err) {
    el('health').textContent = '服务连不上';
    el('health').className = 'health bad';
  }
}

async function loadProjects() {
  const payload = await request('/api/projects');
  state.projects = payload.projects || [];
  renderProjects();
  renderProjectOptions();
}

async function loadDeps() {
  const params = new URLSearchParams();
  const projectId = el('filter-project').value;
  const status = el('filter-status').value;
  const license = el('filter-license').value;
  const keyword = el('filter-keyword').value.trim();
  if (projectId) params.set('projectId', projectId);
  if (status) params.set('status', status);
  if (license) params.set('license', license);
  if (keyword) params.set('keyword', keyword);
  const query = params.toString();
  const payload = await request(`/api/deps${query ? `?${query}` : ''}`);
  state.deps = payload.deps || [];
  state.licenses = payload.licenses || [];
  state.statuses = payload.statuses || [];
  renderDepFilterOptions();
  renderDeps();
}

function renderProjects() {
  const body = el('project-body');
  body.innerHTML = state.projects.map((item) => `<tr>
      <td>${escapeHtml(item.name)}</td>
      <td>${escapeHtml(item.owner) || '<span class="missing">未指定</span>'}</td>
      <td class="note-cell">${escapeHtml(item.note)}</td>
      <td>${item.depCount} 条</td>
      <td class="mono">${escapeHtml(formatTime(item.createdAt))}</td>
      <td class="actions">
        <button type="button" class="link" data-project-rename="${escapeHtml(item.id)}">改名</button>
        <button type="button" class="link" data-project-owner="${escapeHtml(item.id)}">改负责人</button>
        <button type="button" class="link danger" data-project-delete="${escapeHtml(item.id)}">删除</button>
      </td>
    </tr>`).join('');
  el('project-empty').classList.toggle('hidden', state.projects.length > 0);
}

function renderProjectOptions() {
  const select = el('dep-project');
  const current = select.value;
  select.innerHTML = state.projects
    .map((item) => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.name)}</option>`)
    .join('');
  if (state.projects.some((item) => item.id === current)) select.value = current;

  const filter = el('filter-project');
  const filterCurrent = filter.value;
  filter.innerHTML = '<option value="">全部项目</option>'
    + state.projects.map((item) => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.name)}</option>`).join('');
  if (state.projects.some((item) => item.id === filterCurrent)) filter.value = filterCurrent;
}

function renderDepFilterOptions() {
  const statusSelect = el('filter-status');
  const statusCurrent = statusSelect.value;
  statusSelect.innerHTML = '<option value="">全部状态</option>'
    + state.statuses.map((item) => `<option value="${escapeHtml(item)}">${escapeHtml(item)}</option>`).join('');
  if (state.statuses.includes(statusCurrent)) statusSelect.value = statusCurrent;

  const licenseSelect = el('filter-license');
  const licenseCurrent = licenseSelect.value;
  licenseSelect.innerHTML = '<option value="">全部许可</option>'
    + state.licenses.map((item) => `<option value="${escapeHtml(item)}">${escapeHtml(item)}</option>`).join('');
  if (state.licenses.includes(licenseCurrent)) licenseSelect.value = licenseCurrent;

  const statusForm = el('dep-status');
  const statusFormCurrent = statusForm.value;
  statusForm.innerHTML = state.statuses
    .map((item) => `<option value="${escapeHtml(item)}">${escapeHtml(item)}</option>`)
    .join('');
  if (state.statuses.includes(statusFormCurrent)) statusForm.value = statusFormCurrent;
  // 状态选项被重建后，弃用/恢复相关的禁用与锁定要重新套回去
  if (state.editingId) syncFormState();
}

function projectName(projectId) {
  const found = state.projects.find((item) => item.id === projectId);
  return found ? found.name : projectId;
}

function renderDepTrace(item) {
  if (item.status === '已弃用') {
    return `<div class="trace">
      <span class="trace-line">${escapeHtml(item.deprecatedAt ? formatTime(item.deprecatedAt) : '时间未记录')}
        由 <strong>${escapeHtml(item.deprecatedBy || '未记录操作人')}</strong> 弃用</span>
      <span class="trace-reason">理由：${escapeHtml(item.deprecationReason || '（未记录）')}</span>
    </div>`;
  }
  if (item.restoredAt || item.restoredBy) {
    return `<div class="trace restored">
      <span class="trace-line">${escapeHtml(item.restoredAt ? formatTime(item.restoredAt) : '时间未记录')}
        由 <strong>${escapeHtml(item.restoredBy || '未记录操作人')}</strong> 恢复为在用</span>
      <span class="trace-reason">此前弃用理由：${escapeHtml(item.deprecationReason || '（未记录）')}</span>
    </div>`;
  }
  return '<span class="missing">—</span>';
}

function renderDeps() {
  const body = el('dep-body');
  body.innerHTML = state.deps.map((item) => {
    const statusTag = item.status === '已弃用' ? 'off' : 'on';
    const rowClass = item.status === '已弃用' ? ' class="row-deprecated"' : '';
    return `<tr${rowClass}>
      <td>${escapeHtml(projectName(item.projectId))}</td>
      <td class="mono">${escapeHtml(item.name)}</td>
      <td class="mono">${escapeHtml(item.version)}</td>
      <td>${item.license ? escapeHtml(item.license) : '<span class="missing">未填</span>'}</td>
      <td>${item.owner ? escapeHtml(item.owner) : '<span class="missing">未指定</span>'}</td>
      <td><span class="tag ${statusTag}">${escapeHtml(item.status)}</span></td>
      <td class="note-cell">${escapeHtml(item.note)}</td>
      <td class="trace-cell">${renderDepTrace(item)}</td>
      <td class="mono">${escapeHtml(formatTime(item.updatedAt))}</td>
      <td class="actions">
        <button type="button" class="link" data-dep-edit="${escapeHtml(item.id)}">编辑</button>
        <button type="button" class="link danger" data-dep-delete="${escapeHtml(item.id)}">删除</button>
      </td>
    </tr>`;
  }).join('');
  el('dep-empty').classList.toggle('hidden', state.deps.length > 0);
}

function setLockedFieldState(locked) {
  ['dep-version', 'dep-license', 'dep-owner'].forEach((id) => {
    el(id).disabled = locked;
  });
  document.querySelectorAll('[data-lock-group]').forEach((node) => node.classList.toggle('locked', locked));
}

function renderConflicts(conflicts) {
  state.conflicts = Array.isArray(conflicts) ? conflicts : [];
  const list = el('dep-conflict-list');
  if (!state.conflicts.length) {
    el('dep-conflict').classList.add('hidden');
    list.innerHTML = '';
    el('dep-confirm').checked = false;
    return;
  }
  list.innerHTML = state.conflicts.map((item) => `<li>
      <strong>${escapeHtml(item.projectName)}</strong>
      <span class="tag ${item.status === '在用' ? 'on' : 'wait'}">${escapeHtml(item.status)}</span>
      <span class="mono">${escapeHtml(item.version)}</span>
    </li>`).join('');
  el('dep-conflict').classList.remove('hidden');
}

function renderDeprecatedDetail(dep) {
  el('deprecated-detail').innerHTML = `
    <div><span class="detail-label">弃用时间：</span>${escapeHtml(formatTime(dep.deprecatedAt)) || '未记录'}</div>
    <div><span class="detail-label">操作人：</span>${escapeHtml(dep.deprecatedBy || '未记录')}</div>
    <div><span class="detail-label">弃用理由：</span>${escapeHtml(dep.deprecationReason || '（未记录）')}</div>`;
}

function renderHistory(dep) {
  const box = el('dep-history');
  if (!dep || dep.status === '已弃用' || !(dep.deprecatedAt || dep.restoredAt)) {
    box.classList.add('hidden');
    box.innerHTML = '';
    return;
  }
  box.innerHTML = '<div class="history-title">状态变更记录</div>'
    + `<div class="history-line old">弃用：${escapeHtml(formatTime(dep.deprecatedAt))} 由 ${escapeHtml(dep.deprecatedBy || '未记录')}；理由：${escapeHtml(dep.deprecationReason || '（未记录）')}</div>`
    + (dep.restoredAt ? `<div class="history-line back">恢复：${escapeHtml(formatTime(dep.restoredAt))} 由 ${escapeHtml(dep.restoredBy || '未记录')} 恢复为在用</div>` : '');
  box.classList.remove('hidden');
}

// 表单随当前选择的状态联动：弃用要填理由、查冲突、锁三项；恢复只能回在用
function syncFormState() {
  const editing = !!state.editingId;
  const dep = editing ? state.deps.find((item) => item.id === state.editingId) : null;
  const wasDeprecated = !!(dep && dep.status === '已弃用');
  const target = el('dep-status').value;

  Array.from(el('dep-status').options).forEach((option) => {
    option.disabled = (!editing && option.value === '已弃用')
      || (wasDeprecated && option.value === '待升');
  });

  const locking = editing && (wasDeprecated || target === '已弃用');
  setLockedFieldState(locking);
  if (locking && dep) {
    // 锁定时把三项回填成已保存的值，避免界面上留着注定存不进去的改动
    el('dep-version').value = dep.version;
    el('dep-license').value = dep.license;
    el('dep-owner').value = dep.owner;
  }

  const showReason = editing && target === '已弃用';
  el('deprecate-fields').classList.toggle('hidden', !showReason);
  el('dep-reason').readOnly = wasDeprecated;
  if (showReason && wasDeprecated) renderConflicts([]);

  el('deprecated-info').classList.toggle('hidden', !(wasDeprecated && target === '已弃用'));
  el('dep-restore-tip').classList.toggle('hidden', !(wasDeprecated && target === '在用'));
  renderHistory(wasDeprecated ? null : dep);
}

// 弃用前问一次服务端：同名依赖在别的项目里是否还在在用或待升
async function refreshConflicts() {
  if (!state.editingId) return;
  if (el('dep-status').value !== '已弃用') return;
  const dep = state.deps.find((item) => item.id === state.editingId);
  if (dep && dep.status === '已弃用') return;
  const name = el('dep-name').value.trim();
  if (!name) { renderConflicts([]); return; }
  const params = new URLSearchParams({
    depId: state.editingId,
    projectId: el('dep-project').value,
    name,
  });
  try {
    const result = await request(`/api/deps/deprecation-check?${params.toString()}`);
    renderConflicts(result.conflicts || []);
  } catch (err) {
    renderConflicts([]);
  }
}

function openDepForm(dep) {
  state.editingId = dep ? dep.id : '';
  el('dep-form-title').textContent = dep ? `编辑登记：${dep.name}` : '新建登记';
  if (state.projects.length) {
    el('dep-project').value = dep ? dep.projectId : state.projects[0].id;
  }
  el('dep-name').value = dep ? dep.name : '';
  el('dep-version').value = dep ? dep.version : '';
  el('dep-license').value = dep ? dep.license : '';
  el('dep-owner').value = dep ? dep.owner : currentOperator();
  el('dep-status').value = dep ? dep.status : (state.statuses[0] || '在用');
  el('dep-note').value = dep ? dep.note : '';
  el('dep-reason').value = dep ? (dep.deprecationReason || '') : '';
  renderConflicts([]);
  if (dep && dep.status === '已弃用') renderDeprecatedDetail(dep);
  el('dep-history').innerHTML = '';
  el('dep-form').classList.remove('hidden');
  syncFormState();
  el('dep-name').focus();
}

function closeDepForm() {
  state.editingId = '';
  el('dep-form').classList.add('hidden');
  setLockedFieldState(false);
  renderConflicts([]);
  clearFieldMarks();
}

async function submitProject(event) {
  event.preventDefault();
  clearNotice();
  clearFieldMarks();
  const payload = {
    name: el('project-name').value,
    owner: el('project-owner').value,
    note: el('project-note').value,
  };
  try {
    await request('/api/projects', { method: 'POST', body: JSON.stringify(payload) });
    el('project-name').value = '';
    el('project-owner').value = '';
    el('project-note').value = '';
    notify('项目已新增', 'ok');
    await loadProjects();
    await loadDeps();
  } catch (err) {
    notify(err.message, 'error');
    markField(err.field);
  }
}

async function submitDep(event) {
  event.preventDefault();
  clearNotice();
  clearFieldMarks();
  const editing = state.editingId;
  const targetStatus = el('dep-status').value;
  const original = editing ? state.deps.find((item) => item.id === editing) : null;
  const wasDeprecated = !!(original && original.status === '已弃用');
  const deprecating = !!editing && !wasDeprecated && targetStatus === '已弃用';
  const restoring = wasDeprecated && targetStatus === '在用';

  const payload = {
    projectId: el('dep-project').value,
    name: el('dep-name').value,
    version: el('dep-version').value,
    license: el('dep-license').value,
    owner: el('dep-owner').value,
    status: targetStatus,
    note: el('dep-note').value,
  };

  // 弃用与恢复都必须留下操作人，没填操作者当场拦下
  if (deprecating || restoring) {
    if (!currentOperator()) {
      notify('请先在页面右上角填写当前操作者，弃用与恢复都要留下操作人', 'error');
      el('operator').focus();
      return;
    }
    payload.operator = currentOperator();
  }
  if (deprecating) {
    payload.deprecationReason = el('dep-reason').value;
    if (!el('dep-reason').value.trim()) {
      notify('标成已弃用必须写清弃用理由', 'error');
      markField('deprecationReason');
      return;
    }
    if (state.conflicts.length && !el('dep-confirm').checked) {
      notify('这个依赖还在别的项目里在用或待升，请先在下面确认是照旧弃用还是去处理那些项目', 'error');
      return;
    }
    payload.confirmDeprecate = el('dep-confirm').checked;
  }

  try {
    if (editing) {
      await request(`/api/deps/${encodeURIComponent(editing)}`, { method: 'PATCH', body: JSON.stringify(payload) });
      notify(restoring ? '登记已恢复为在用，版本、许可与责任人可以重新修改了' : '依赖登记已保存', 'ok');
    } else {
      await request('/api/deps', { method: 'POST', body: JSON.stringify(payload) });
      notify('依赖登记已新增', 'ok');
    }
    closeDepForm();
    await loadProjects();
    await loadDeps();
  } catch (err) {
    notify(err.message, 'error');
    markField(err.field);
    // 服务端兜底发现的冲突也直接列出来，让操作者选择先处理还是照旧弃用
    if (err.code === 'DEP_DEPRECATION_CONFLICT' && err.extra && Array.isArray(err.extra.conflicts)) {
      renderConflicts(err.extra.conflicts);
    }
  }
}

// 列表上的操作用事件委托统一处理，列表重绘之后不需要重新绑定
document.addEventListener('click', async (event) => {
  const node = event.target.closest('button');
  if (!node) return;

  const projectId = node.dataset.projectRename || node.dataset.projectOwner || node.dataset.projectDelete;
  if (projectId) {
    clearNotice();
    const found = state.projects.find((item) => item.id === projectId);
    if (!found) return;
    try {
      if (node.dataset.projectRename) {
        const next = window.prompt(`把 ${found.name} 的名称改成`, found.name);
        if (next === null) return;
        await request(`/api/projects/${encodeURIComponent(projectId)}`, { method: 'PATCH', body: JSON.stringify({ name: next }) });
        notify('项目名称已更新', 'ok');
      } else if (node.dataset.projectOwner) {
        const next = window.prompt(`把 ${found.name} 的负责人改成`, found.owner || '');
        if (next === null) return;
        await request(`/api/projects/${encodeURIComponent(projectId)}`, { method: 'PATCH', body: JSON.stringify({ owner: next }) });
        notify('项目负责人已更新', 'ok');
      } else {
        if (!window.confirm(`确定删除项目 ${found.name} 吗？`)) return;
        await request(`/api/projects/${encodeURIComponent(projectId)}`, { method: 'DELETE' });
        notify('项目已删除', 'ok');
      }
      await loadProjects();
      await loadDeps();
    } catch (err) {
      notify(err.message, 'error');
    }
    return;
  }

  if (node.dataset.depEdit) {
    clearNotice();
    const found = state.deps.find((item) => item.id === node.dataset.depEdit);
    if (found) openDepForm(found);
    return;
  }

  if (node.dataset.depDelete) {
    clearNotice();
    const found = state.deps.find((item) => item.id === node.dataset.depDelete);
    if (!window.confirm(`确定删除登记 ${found ? found.name : ''} 吗？`)) return;
    try {
      await request(`/api/deps/${encodeURIComponent(node.dataset.depDelete)}`, { method: 'DELETE' });
      if (state.editingId === node.dataset.depDelete) closeDepForm();
      notify('登记已删除', 'ok');
      await loadProjects();
      await loadDeps();
    } catch (err) {
      notify(err.message, 'error');
    }
  }
});

el('project-form').addEventListener('submit', submitProject);
el('dep-form').addEventListener('submit', submitDep);
el('dep-new').addEventListener('click', () => {
  clearNotice();
  if (!state.projects.length) {
    notify('请先登记一个项目，再登记依赖', 'error');
    return;
  }
  openDepForm(null);
});
el('dep-cancel').addEventListener('click', closeDepForm);
el('filter-apply').addEventListener('click', () => {
  clearNotice();
  loadDeps().catch((err) => notify(err.message, 'error'));
});
el('filter-reset').addEventListener('click', () => {
  el('filter-project').value = '';
  el('filter-status').value = '';
  el('filter-license').value = '';
  el('filter-keyword').value = '';
  loadDeps().catch((err) => notify(err.message, 'error'));
});
el('dep-refresh').addEventListener('click', () => {
  clearNotice();
  loadProjects()
    .then(loadDeps)
    .catch((err) => notify(err.message, 'error'));
});
el('filter-project').addEventListener('change', () => {
  loadDeps().catch((err) => notify(err.message, 'error'));
});
el('filter-status').addEventListener('change', () => {
  loadDeps().catch((err) => notify(err.message, 'error'));
});
el('filter-license').addEventListener('change', () => {
  loadDeps().catch((err) => notify(err.message, 'error'));
});
el('operator').addEventListener('change', () => {
  window.localStorage.setItem(OPERATOR_KEY, currentOperator());
});
el('dep-status').addEventListener('change', () => {
  clearNotice();
  clearFieldMarks();
  syncFormState();
  refreshConflicts().catch(() => {});
});
el('dep-name').addEventListener('change', () => {
  refreshConflicts().catch(() => {});
});
el('dep-project').addEventListener('change', () => {
  refreshConflicts().catch(() => {});
});

// 页面打开时先把项目与依赖登记拉一遍，项目决定登记表单里能选哪些归属
restoreOperator();
loadHealth();
loadProjects()
  .then(loadDeps)
  .catch((err) => notify(err.message, 'error'));
