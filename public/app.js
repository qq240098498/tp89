// 页面交互：项目清单与依赖登记都从服务端拉取，任何一步失败都把说明显示在顶部并标到对应输入项上

const DEPRECATED_STATUS = '已弃用';
const ACTIVE_STATUS = '在用';

const state = {
  projects: [],
  deps: [],
  licenses: [],
  statuses: [],
  editingId: '',
  editingDep: null,
  // 弃用时被服务端拦下的冲突清单，操作者看过之后可以选择“照旧弃用”再提交一次
  pendingConflicts: [],
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
    failure.details = error.details || null;
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
}

function projectName(projectId) {
  const found = state.projects.find((item) => item.id === projectId);
  return found ? found.name : projectId;
}

function renderDeps() {
  const body = el('dep-body');
  body.innerHTML = state.deps.map((item) => {
    const deprecated = item.status === DEPRECATED_STATUS;
    const statusTag = deprecated ? 'off' : 'on';
    const usages = item.usages || [];
    // 已弃用：状态格下面直接给出弃用时间与弃用人，鼠标停上去能看到完整理由
    const deprecateLine = deprecated
      ? `<div class="cell-dep" title="${escapeHtml(`弃用理由：${item.deprecatedReason || ''}`)}">${escapeHtml(formatTime(item.deprecatedAt))} 由 ${escapeHtml(item.deprecatedBy || '未记录')} 弃用</div>`
      : '';
    // 弃用了但别的项目还登记成在用/待升：在行内直接亮提示，点开就是那些项目与版本
    const usageWarn = deprecated && usages.length
      ? `<button type="button" class="warn-badge" data-dep-usages="${escapeHtml(item.id)}">⚠ ${usages.length} 个项目仍在用</button>`
      : '';
    return `<tr${deprecated ? ' class="row-deprecated"' : ''}>
      <td>${escapeHtml(projectName(item.projectId))}</td>
      <td class="mono">${escapeHtml(item.name)}</td>
      <td class="mono">${escapeHtml(item.version)}</td>
      <td>${item.license ? escapeHtml(item.license) : '<span class="missing">未填</span>'}</td>
      <td>${item.owner ? escapeHtml(item.owner) : '<span class="missing">未指定</span>'}</td>
      <td><span class="tag ${statusTag}">${escapeHtml(item.status)}</span>${deprecateLine}${usageWarn}</td>
      <td class="note-cell">${escapeHtml(item.note)}</td>
      <td class="mono">${escapeHtml(formatTime(item.updatedAt))}</td>
      <td class="actions">
        <button type="button" class="link" data-dep-edit="${escapeHtml(item.id)}">${deprecated ? '查看' : '编辑'}</button>
        <button type="button" class="link danger" data-dep-delete="${escapeHtml(item.id)}">删除</button>
      </td>
    </tr>`;
  }).join('');
  el('dep-empty').classList.toggle('hidden', state.deps.length > 0);
}

// 找别的项目里还把同一依赖登记成在用或待升的记录，页面上先用本地数据给操作者提示一次
function findLocalConflicts(dep, name) {
  const target = (name || '').toLowerCase();
  if (!target) return [];
  return state.deps
    .filter((item) => (!dep || item.id !== dep.id)
      && item.name.toLowerCase() === target
      && (item.status === ACTIVE_STATUS || item.status === '待升'))
    .map((item) => ({
      depId: item.id,
      projectId: item.projectId,
      projectName: projectName(item.projectId),
      version: item.version,
      status: item.status,
      owner: item.owner,
    }));
}

function conflictListHtml(conflicts, askConfirm) {
  const rows = conflicts.map((item) => `<li>
      <span class="conf-project">${escapeHtml(item.projectName)}</span>
      <span class="tag on">${escapeHtml(item.status)}</span>
      <span class="mono">${escapeHtml(item.version)}</span>
      <span>${item.owner ? escapeHtml(item.owner) : '<span class="missing">未指定责任人</span>'}</span>
    </li>`).join('');
  const ask = askConfirm ? '<div class="conf-ask">请确认：先去处理这些项目，还是照旧弃用这条登记？</div>' : '';
  return `<div class="conf-title">这个依赖还在以下项目里登记为在用或待升：</div>
    <ul class="conf-list">${rows}</ul>${ask}`;
}

// 弃用/恢复痕迹按时间倒序展示，最新的动作在最上面
function historyHtml(dep) {
  const records = (dep.lifecycle || []).slice().reverse();
  if (!records.length) return '';
  const rows = records.map((item) => {
    const isDep = item.action === '弃用';
    return `<li>
      <span class="tag ${isDep ? 'off' : 'on'}">${escapeHtml(item.action)}</span>
      <span class="mono">${escapeHtml(formatTime(item.at))}</span>
      <span>操作人：${escapeHtml(item.by || '未记录')}</span>
      ${isDep ? `<span class="hist-reason">理由：${escapeHtml(item.reason || '')}</span>` : ''}
    </li>`;
  }).join('');
  return `<div class="history-title">弃用与恢复记录</div><ul class="history-list">${rows}</ul>`;
}

function setFormLocked(locked) {
  ['dep-project', 'dep-name', 'dep-version', 'dep-license', 'dep-owner', 'dep-note']
    .forEach((id) => { el(id).disabled = locked; });
}

// 弃用是单独的动作：状态一选成已弃用，其他字段立刻只读，避免夹带修改被丢掉
function setDeprecatingMode(active) {
  setFormLocked(active);
  el('dep-lock-banner').classList.toggle('hidden', !active);
  if (active) {
    el('dep-lock-banner').textContent = '弃用动作只记录状态、理由与操作者，请先保存其他修改再来弃用。';
  }
}

function setStatusOptions(dep) {
  const select = el('dep-status');
  let options = state.statuses;
  if (!dep) {
    // 新登记不能一上来就弃用，弃用必须走带理由的动作
    options = state.statuses.filter((item) => item !== DEPRECATED_STATUS);
  } else if (dep.status === DEPRECATED_STATUS) {
    options = [DEPRECATED_STATUS];
  }
  select.innerHTML = options
    .map((item) => `<option value="${escapeHtml(item)}">${escapeHtml(item)}</option>`)
    .join('');
}

function openDepForm(dep) {
  state.editingId = dep ? dep.id : '';
  state.editingDep = dep || null;
  state.pendingConflicts = [];
  el('dep-form-title').textContent = dep
    ? (dep.status === DEPRECATED_STATUS ? `查看登记：${dep.name}` : `编辑登记：${dep.name}`)
    : '新建登记';
  setStatusOptions(dep);
  if (state.projects.length) {
    el('dep-project').value = dep ? dep.projectId : state.projects[0].id;
  }
  el('dep-name').value = dep ? dep.name : '';
  el('dep-version').value = dep ? dep.version : '';
  el('dep-license').value = dep ? dep.license : '';
  el('dep-owner').value = dep ? dep.owner : currentOperator();
  el('dep-status').value = dep ? dep.status : (state.statuses[0] || ACTIVE_STATUS);
  el('deprecate-reason').value = '';
  el('dep-note').value = dep ? dep.note : '';
  el('dep-submit').textContent = '保存';

  const deprecated = dep && dep.status === DEPRECATED_STATUS;
  setFormLocked(Boolean(deprecated));
  el('dep-status').disabled = Boolean(deprecated);
  const banner = el('dep-lock-banner');
  banner.classList.toggle('hidden', !deprecated);
  banner.textContent = '这条登记已弃用，版本、许可与责任人已锁定，只能查看；如需修改，请先恢复成在用。';
  el('deprecate-box').classList.add('hidden');
  el('deprecate-conflicts').classList.add('hidden');
  el('dep-submit').classList.toggle('hidden', Boolean(deprecated));
  el('dep-reactivate').classList.toggle('hidden', !deprecated);

  // 已弃用登记：把别处仍在使用的提示与完整痕迹直接摊开
  const usagesBox = el('dep-usages');
  if (deprecated && dep.usages && dep.usages.length) {
    usagesBox.innerHTML = `<div class="usages-title">⚠ 这条登记虽然已经弃用，但同一个依赖在别处仍被登记为在用或待升</div>${conflictListHtml(dep.usages, false)}`;
    usagesBox.classList.remove('hidden');
  } else {
    usagesBox.textContent = '';
    usagesBox.classList.add('hidden');
  }

  const historyBox = el('dep-history');
  if (dep && (dep.lifecycle || []).length) {
    historyBox.innerHTML = historyHtml(dep);
    historyBox.classList.remove('hidden');
  } else {
    historyBox.textContent = '';
    historyBox.classList.add('hidden');
  }

  el('dep-form').classList.remove('hidden');
  el('dep-name').focus();
}

function closeDepForm() {
  state.editingId = '';
  state.editingDep = null;
  state.pendingConflicts = [];
  el('dep-form').classList.add('hidden');
  setFormLocked(false);
  el('dep-status').disabled = false;
  el('dep-submit').textContent = '保存';
  clearFieldMarks();
}

// 状态切到已弃用时：亮出理由框，并立刻把别处仍在用的项目列出来
function handleStatusChange() {
  if (!state.editingId) return;
  const deprecating = el('dep-status').value === DEPRECATED_STATUS;
  const box = el('deprecate-box');
  box.classList.toggle('hidden', !deprecating);
  setDeprecatingMode(deprecating);
  state.pendingConflicts = [];
  if (deprecating) {
    refreshConflictPreview();
    el('deprecate-reason').focus();
  } else {
    el('dep-submit').textContent = '保存';
  }
}

function refreshConflictPreview() {
  const conflictsBox = el('deprecate-conflicts');
  const dep = state.editingDep;
  const conflicts = state.pendingConflicts.length
    ? state.pendingConflicts
    : findLocalConflicts(dep, dep ? dep.name : el('dep-name').value);
  state.pendingConflicts = conflicts;
  if (conflicts.length) {
    conflictsBox.innerHTML = conflictListHtml(conflicts, true);
    conflictsBox.classList.remove('hidden');
  } else {
    conflictsBox.textContent = '';
    conflictsBox.classList.add('hidden');
  }
  // 有冲突时，点击保存代表操作者看过清单后选择照旧弃用
  el('dep-submit').textContent = conflicts.length
    ? '照旧弃用（我已确认上面的项目）'
    : '确认弃用';
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
  const deprecating = editing && el('dep-status').value === DEPRECATED_STATUS;

  if (deprecating) {
    // 理由没写当场拦下，请求都不发；操作者名字为空也一样
    const reason = el('deprecate-reason').value.trim();
    if (!reason) {
      notify('标成已弃用必须写清楚理由', 'error');
      markField('deprecateReason');
      return;
    }
    const operator = currentOperator();
    if (!operator) {
      notify('请先在页面右上角填上当前操作者的名字，再做弃用', 'error');
      markField('operator');
      return;
    }
    // 弃用是单独动作：不夹带任何字段修改，服务端也会再核一遍
    const payload = {
      status: DEPRECATED_STATUS,
      deprecateReason: reason,
      operator,
    };
    // 冲突清单已经亮给操作者看过，这次点击代表“照旧弃用”
    if (state.pendingConflicts.length) payload.force = true;
    try {
      await request(`/api/deps/${encodeURIComponent(editing)}`, { method: 'PATCH', body: JSON.stringify(payload) });
      notify('这条登记已弃用，版本、许可与责任人已锁定', 'ok');
      closeDepForm();
      await loadProjects();
      await loadDeps();
    } catch (err) {
      if (err.code === 'DEP_STILL_IN_USE' && err.details && Array.isArray(err.details.conflicts)) {
        // 本地数据可能不是最新的，以服务端返回的清单为准，再让操作者确认一次
        state.pendingConflicts = err.details.conflicts;
        refreshConflictPreview();
      }
      notify(err.message, 'error');
      markField(err.field);
    }
    return;
  }

  const payload = {
    projectId: el('dep-project').value,
    name: el('dep-name').value,
    version: el('dep-version').value,
    license: el('dep-license').value,
    owner: el('dep-owner').value,
    status: el('dep-status').value,
    note: el('dep-note').value,
  };
  try {
    if (editing) {
      await request(`/api/deps/${encodeURIComponent(editing)}`, { method: 'PATCH', body: JSON.stringify(payload) });
      notify('依赖登记已保存', 'ok');
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
  }
}

// 已弃用登记恢复成在用：留下恢复时间与操作人，之后版本、许可与责任人重新可以改
async function reactivateDep() {
  const editing = state.editingId;
  if (!editing) return;
  clearNotice();
  clearFieldMarks();
  const operator = currentOperator();
  if (!operator) {
    notify('请先在页面右上角填上当前操作者的名字，再恢复登记', 'error');
    markField('operator');
    return;
  }
  const dep = state.editingDep;
  if (!window.confirm(`确定把 ${dep ? dep.name : '这条登记'} 恢复成在用吗？恢复操作会留下记录。`)) return;
  try {
    await request(`/api/deps/${encodeURIComponent(editing)}`, {
      method: 'PATCH',
      body: JSON.stringify({ status: ACTIVE_STATUS, operator }),
    });
    notify('已恢复成在用，版本、许可与责任人可以重新修改', 'ok');
    closeDepForm();
    await loadProjects();
    await loadDeps();
  } catch (err) {
    notify(err.message, 'error');
    markField(err.field);
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

  if (node.dataset.depEdit || node.dataset.depUsages) {
    clearNotice();
    const found = state.deps.find((item) => item.id === (node.dataset.depEdit || node.dataset.depUsages));
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
el('dep-status').addEventListener('change', handleStatusChange);
el('dep-reactivate').addEventListener('click', reactivateDep);
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

// 页面打开时先把项目与依赖登记拉一遍，项目决定登记表单里能选哪些归属
restoreOperator();
loadHealth();
loadProjects()
  .then(loadDeps)
  .catch((err) => notify(err.message, 'error'));
