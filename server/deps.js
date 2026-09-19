const crypto = require('crypto');
const {
  load,
  save,
  STATUSES,
  ACTIVE_STATUS,
  DEPRECATED_STATUS,
  MAX_NAME_LENGTH,
  MAX_VERSION_LENGTH,
  MAX_LICENSE_LENGTH,
  MAX_OWNER_LENGTH,
  MAX_NOTE_LENGTH,
  MAX_DEPRECATE_REASON_LENGTH,
  MAX_OPERATOR_LENGTH,
} = require('./store');
const { ApiError, pickText } = require('./errors');
const { findProject } = require('./projects');

// 依赖名允许小写字母、数字、点、下划线、短横线，也允许带范围的写法
const NAME_PATTERN = /^[@a-z0-9][@a-z0-9._/-]*$/;
// 版本写法固定成三段数字，后面可选择带一段预发布后缀
const VERSION_PATTERN = /^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/;
// 弃用之后还会在别处继续用的状态：在用与待升都算还没退场
const ACTIVE_USAGE_STATUSES = [ACTIVE_STATUS, '待升'];

function validateName(value) {
  const name = pickText(value);
  if (!name) throw new ApiError(400, 'DEP_NAME_REQUIRED', '请填写依赖名称', 'depName');
  if (name.length > MAX_NAME_LENGTH) {
    throw new ApiError(400, 'DEP_NAME_TOO_LONG', `依赖名称不能超过 ${MAX_NAME_LENGTH} 个字符`, 'depName');
  }
  if (!NAME_PATTERN.test(name)) {
    throw new ApiError(400, 'DEP_NAME_INVALID', '依赖名称只能用小写字母、数字、点、下划线、短横线与斜线，并且要以字母或数字开头', 'depName');
  }
  return name;
}

function validateVersion(value) {
  const version = pickText(value);
  if (!version) throw new ApiError(400, 'VERSION_REQUIRED', '请填写版本', 'version');
  if (version.length > MAX_VERSION_LENGTH) {
    throw new ApiError(400, 'VERSION_TOO_LONG', `版本不能超过 ${MAX_VERSION_LENGTH} 个字符`, 'version');
  }
  if (!VERSION_PATTERN.test(version)) {
    throw new ApiError(400, 'VERSION_INVALID', '版本要写成三段数字，例如 2.7.18，需要时可以带一段预发布后缀', 'version');
  }
  return version;
}

function validateLicense(value) {
  const license = pickText(value);
  if (license.length > MAX_LICENSE_LENGTH) {
    throw new ApiError(400, 'LICENSE_TOO_LONG', `许可名称不能超过 ${MAX_LICENSE_LENGTH} 个字符`, 'license');
  }
  return license;
}

function validateOwner(value) {
  const owner = pickText(value);
  if (owner.length > MAX_OWNER_LENGTH) {
    throw new ApiError(400, 'OWNER_TOO_LONG', `责任人名字不能超过 ${MAX_OWNER_LENGTH} 个字符`, 'owner');
  }
  return owner;
}

function validateStatus(value) {
  const status = pickText(value);
  if (!status) return STATUSES[0];
  if (!STATUSES.includes(status)) {
    throw new ApiError(400, 'STATUS_INVALID', `状态只能是 ${STATUSES.join('、')} 其中之一`, 'status');
  }
  return status;
}

function validateNote(value) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw new ApiError(400, 'NOTE_INVALID', '备注需要是文本', 'note');
  if (value.length > MAX_NOTE_LENGTH) {
    throw new ApiError(400, 'NOTE_TOO_LONG', `备注不能超过 ${MAX_NOTE_LENGTH} 个字符`, 'note');
  }
  return value.trim();
}

// 弃用理由必须写清楚，空白不收；长度与备注一档
function validateDeprecateReason(value) {
  if (value === undefined || value === null) {
    throw new ApiError(400, 'DEPRECATE_REASON_REQUIRED', '标成已弃用必须写清楚理由', 'deprecateReason');
  }
  if (typeof value !== 'string') {
    throw new ApiError(400, 'DEPRECATE_REASON_INVALID', '弃用理由需要是文本', 'deprecateReason');
  }
  const reason = value.trim();
  if (!reason) {
    throw new ApiError(400, 'DEPRECATE_REASON_REQUIRED', '标成已弃用必须写清楚理由', 'deprecateReason');
  }
  if (reason.length > MAX_DEPRECATE_REASON_LENGTH) {
    throw new ApiError(400, 'DEPRECATE_REASON_TOO_LONG', `弃用理由不能超过 ${MAX_DEPRECATE_REASON_LENGTH} 个字符`, 'deprecateReason');
  }
  return reason;
}

// 弃用与恢复都要记是谁操作的，不接受匿名
function validateOperator(value) {
  const operator = pickText(value);
  if (!operator) {
    throw new ApiError(400, 'OPERATOR_REQUIRED', '请先在页面右上角填上当前操作者的名字，再做弃用或恢复', 'operator');
  }
  if (operator.length > MAX_OPERATOR_LENGTH) {
    throw new ApiError(400, 'OPERATOR_TOO_LONG', `操作者名字不能超过 ${MAX_OPERATOR_LENGTH} 个字符`, 'operator');
  }
  return operator;
}

// 同一个项目下不允许出现同名依赖，比较时忽略大小写
function assertNameFree(data, projectId, name, selfId) {
  const hit = data.deps.find((item) => item.projectId === projectId
    && item.id !== selfId
    && item.name.toLowerCase() === name.toLowerCase());
  if (hit) throw new ApiError(409, 'DEP_DUPLICATED', `这个项目下已经有 ${hit.name} 这条登记了`, 'depName');
}

// 找别的项目里还把同一个依赖登记成在用或待升的记录，弃用前要让操作者先看到这些
function findActiveUsages(data, name, selfId) {
  const target = name.toLowerCase();
  const projectNames = new Map(data.projects.map((item) => [item.id, item.name]));
  return data.deps
    .filter((item) => item.id !== selfId
      && item.name.toLowerCase() === target
      && ACTIVE_USAGE_STATUSES.includes(item.status))
    .map((item) => ({
      depId: item.id,
      projectId: item.projectId,
      projectName: projectNames.get(item.projectId) || item.projectId,
      version: item.version,
      status: item.status,
      owner: item.owner,
    }));
}

function sortDeps(list) {
  return list.slice().sort((a, b) => {
    if (a.projectId !== b.projectId) return a.projectId < b.projectId ? -1 : 1;
    if (a.name !== b.name) return a.name < b.name ? -1 : 1;
    return a.id < b.id ? -1 : 1;
  });
}

// 给已弃用的登记挂上别处仍在使用的清单，页面据此提示操作者
function withUsages(data, dep) {
  if (dep.status !== DEPRECATED_STATUS) return dep;
  return { ...dep, usages: findActiveUsages(data, dep.name, dep.id) };
}

// 依赖清单：支持按项目、状态、许可筛选，再按依赖名或责任人搜索
function listDeps(options) {
  const input = options && typeof options === 'object' ? options : {};
  const projectId = pickText(input.projectId);
  const status = pickText(input.status);
  const license = pickText(input.license);
  const keyword = pickText(input.keyword).toLowerCase();
  const data = load();

  let list = data.deps;
  if (projectId) list = list.filter((item) => item.projectId === projectId);
  if (status) list = list.filter((item) => item.status === status);
  if (license) list = list.filter((item) => item.license === license);
  if (keyword) {
    list = list.filter((item) => item.name.toLowerCase().includes(keyword)
      || item.owner.toLowerCase().includes(keyword)
      || item.note.toLowerCase().includes(keyword));
  }

  const licenses = Array.from(new Set(data.deps.map((item) => item.license).filter(Boolean))).sort();
  const projects = data.projects
    .map((item) => ({ id: item.id, name: item.name, owner: item.owner }))
    .sort((a, b) => (a.name < b.name ? -1 : 1));

  const deps = sortDeps(list).map((item) => withUsages(data, item));
  return { deps, projects, licenses, statuses: STATUSES.slice() };
}

function getDep(id) {
  const data = load();
  const found = data.deps.find((item) => item.id === id);
  if (!found) throw new ApiError(404, 'DEP_NOT_FOUND', '这条依赖登记不存在或已被删除', '');
  return withUsages(data, found);
}

function createDep(payload) {
  const input = payload && typeof payload === 'object' ? payload : {};
  // 新登记不允许一上来就是已弃用：弃用是一条需要理由与痕迹的动作，得先保存再走弃用流程
  const requestedStatus = input.status === undefined ? ACTIVE_STATUS : validateStatus(input.status);
  if (requestedStatus === DEPRECATED_STATUS) {
    throw new ApiError(400, 'DEPRECATE_ON_CREATE_FORBIDDEN', '新登记不能直接标成已弃用，请先保存为在用或待升，再通过弃用操作写明理由', 'status');
  }

  const data = load();
  const project = findProject(data, input.projectId);
  const name = validateName(input.name);
  assertNameFree(data, project.id, name, '');

  const now = new Date().toISOString();
  const created = {
    id: crypto.randomUUID(),
    projectId: project.id,
    name,
    version: validateVersion(input.version),
    license: validateLicense(input.license),
    owner: validateOwner(input.owner),
    status: requestedStatus,
    note: validateNote(input.note),
    createdAt: now,
    updatedAt: now,
    lifecycle: [],
  };
  data.deps.push(created);
  save(data);
  return created;
}

// 把一条登记标成已弃用：理由与操作者必填，别处还在用时默认拦下，force 表示操作者看过清单后照旧弃用
function deprecate(data, found, input, now) {
  const reason = validateDeprecateReason(input.deprecateReason);
  const operator = validateOperator(input.operator);

  const usages = findActiveUsages(data, found.name, found.id);
  if (usages.length && input.force !== true) {
    throw new ApiError(409, 'DEP_STILL_IN_USE',
      `${found.name} 还在 ${usages.length} 个项目里登记为在用或待升，请先确认是去处理那些项目，还是照旧弃用这条登记`,
      'status', { conflicts: usages });
  }

  found.status = DEPRECATED_STATUS;
  found.deprecatedReason = reason;
  found.deprecatedAt = now;
  found.deprecatedBy = operator;
  found.lifecycle.push({ action: '弃用', at: now, by: operator, reason });
}

// 把已弃用的登记恢复成在用：同样记下时间与操作者，恢复后版本、许可与责任人重新可以改
function reactivate(data, found, input, now) {
  const operator = validateOperator(input.operator);
  found.status = ACTIVE_STATUS;
  delete found.deprecatedReason;
  delete found.deprecatedAt;
  delete found.deprecatedBy;
  found.lifecycle.push({ action: '恢复', at: now, by: operator });
}

function updateDep(id, payload) {
  const input = payload && typeof payload === 'object' ? payload : {};
  const data = load();
  const found = data.deps.find((item) => item.id === id);
  if (!found) throw new ApiError(404, 'DEP_NOT_FOUND', '这条依赖登记不存在或已被删除', '');

  const now = new Date().toISOString();
  const nextStatus = input.status === undefined ? found.status : validateStatus(input.status);
  const leavingDeprecated = found.status === DEPRECATED_STATUS && nextStatus !== DEPRECATED_STATUS;

  // 已弃用的登记整单冻结，版本、许可与责任人等一律不能再改，只能恢复成在用之后再动
  if (found.status === DEPRECATED_STATUS && !leavingDeprecated) {
    const frozenFields = ['projectId', 'name', 'version', 'license', 'owner', 'note'];
    const touched = frozenFields.filter((field) => input[field] !== undefined
      && pickText(input[field]) !== String(found[field]));
    const rewritingReason = input.deprecateReason !== undefined;
    if (touched.length || rewritingReason) {
      throw new ApiError(409, 'DEP_DEPRECATED_LOCKED',
        '这条登记已经弃用，版本、许可与责任人不允许再改动，弃用理由也不能改写；如需修改请先恢复成在用', 'status');
    }
    // 只是重复提交了一遍已弃用状态：原样返回，不刷新更新时间
    return withUsages(data, found);
  }

  // 离开弃用状态只能直接恢复成在用，不允许绕到待升
  if (leavingDeprecated && nextStatus !== ACTIVE_STATUS) {
    throw new ApiError(400, 'REACTIVATE_TARGET_INVALID', '已弃用的登记只能恢复成在用，不能直接改成待升', 'status');
  }

  if (leavingDeprecated) {
    reactivate(data, found, input, now);
    found.updatedAt = now;
    save(data);
    return withUsages(data, found);
  }

  const becomingDeprecated = nextStatus === DEPRECATED_STATUS && found.status !== DEPRECATED_STATUS;
  if (becomingDeprecated) {
    // 弃用这一步不允许夹带任何字段修改，要改先改完再来弃用
    const nextProjectId = input.projectId === undefined ? found.projectId : findProject(data, input.projectId).id;
    const nextName = input.name === undefined ? found.name : validateName(input.name);
    const nextVersion = input.version === undefined ? found.version : validateVersion(input.version);
    const nextLicense = input.license === undefined ? found.license : validateLicense(input.license);
    const nextOwner = input.owner === undefined ? found.owner : validateOwner(input.owner);
    const nextNote = input.note === undefined ? found.note : validateNote(input.note);
    if (nextProjectId !== found.projectId || nextName !== found.name || nextVersion !== found.version
      || nextLicense !== found.license || nextOwner !== found.owner || nextNote !== found.note) {
      throw new ApiError(409, 'DEP_DEPRECATE_WITH_CHANGES',
        '弃用时不能同时修改登记内容，请先保存这些改动，再单独做弃用操作', 'status');
    }
    deprecate(data, found, input, now);
    found.updatedAt = now;
    save(data);
    return withUsages(data, found);
  }

  const project = input.projectId === undefined ? null : findProject(data, input.projectId);
  const projectId = project ? project.id : found.projectId;
  const name = input.name === undefined ? found.name : validateName(input.name);
  assertNameFree(data, projectId, name, found.id);

  found.projectId = projectId;
  found.name = name;
  found.version = input.version === undefined ? found.version : validateVersion(input.version);
  found.license = input.license === undefined ? found.license : validateLicense(input.license);
  found.owner = input.owner === undefined ? found.owner : validateOwner(input.owner);
  found.status = nextStatus;
  found.note = input.note === undefined ? found.note : validateNote(input.note);
  found.updatedAt = now;
  save(data);
  return withUsages(data, found);
}

function deleteDep(id) {
  const data = load();
  const index = data.deps.findIndex((item) => item.id === id);
  if (index === -1) throw new ApiError(404, 'DEP_NOT_FOUND', '这条依赖登记不存在或已被删除', '');
  const [removed] = data.deps.splice(index, 1);
  save(data);
  return { id: removed.id, name: removed.name };
}

module.exports = {
  listDeps,
  getDep,
  createDep,
  updateDep,
  deleteDep,
  validateName,
  validateVersion,
  findActiveUsages,
};
