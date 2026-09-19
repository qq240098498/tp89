const crypto = require('crypto');
const {
  load,
  save,
  STATUSES,
  MAX_NAME_LENGTH,
  MAX_VERSION_LENGTH,
  MAX_LICENSE_LENGTH,
  MAX_OWNER_LENGTH,
  MAX_NOTE_LENGTH,
  MAX_DEPRECATION_REASON_LENGTH,
} = require('./store');
const { ApiError, pickText } = require('./errors');
const { findProject } = require('./projects');

const DEPRECATED = '已弃用';
const ACTIVE = '在用';
const PENDING = '待升';

// 依赖名允许小写字母、数字、点、下划线、短横线，也允许带范围的写法
const NAME_PATTERN = /^[@a-z0-9][@a-z0-9._/-]*$/;
// 版本写法固定成三段数字，后面可选择带一段预发布后缀
const VERSION_PATTERN = /^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/;

// 弃用后冻结的字段：页面上只能查看，任何保存都不能改这三项
const LOCKED_FIELDS = [
  ['version', '版本'],
  ['license', '许可'],
  ['owner', '责任人'],
];

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

// 弃用理由是必填项，没写清楚不允许标成弃用
function validateDeprecationReason(value) {
  const reason = pickText(value);
  if (!reason) {
    throw new ApiError(400, 'DEPRECATION_REASON_REQUIRED', '标成已弃用必须写清弃用理由', 'deprecationReason');
  }
  if (reason.length > MAX_DEPRECATION_REASON_LENGTH) {
    throw new ApiError(400, 'DEPRECATION_REASON_TOO_LONG', `弃用理由不能超过 ${MAX_DEPRECATION_REASON_LENGTH} 个字符`, 'deprecationReason');
  }
  return reason;
}

// 弃用与恢复都要记下是谁操作的，操作者取页面右上角的当前操作者
function validateOperator(value) {
  const operator = pickText(value);
  if (!operator) {
    throw new ApiError(400, 'OPERATOR_REQUIRED', '请先在页面右上角填写当前操作者，弃用与恢复都要留下操作人', 'operator');
  }
  if (operator.length > MAX_OWNER_LENGTH) {
    throw new ApiError(400, 'OPERATOR_TOO_LONG', `操作者名字不能超过 ${MAX_OWNER_LENGTH} 个字符`, 'operator');
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

// 已弃用（含正在执行弃用保存）的登记，版本、许可、责任人一项都不能动
function assertLockedFieldsUnchanged(found, input) {
  LOCKED_FIELDS.forEach(([field, label]) => {
    if (input[field] !== undefined && pickText(input[field]) !== found[field]) {
      throw new ApiError(409, 'DEP_DEPRECATED_LOCKED', `这条登记已弃用，${label}不允许再改动；如需修改请先恢复成在用`, field);
    }
  });
}

// 找出同名依赖在其他项目里仍处于在用或待升的登记，弃用前要让操作者知道
function findDeprecationConflicts(data, name, selfId, currentProjectId) {
  const lowerName = name.toLowerCase();
  const projectNames = new Map(data.projects.map((item) => [item.id, item.name]));
  return data.deps
    .filter((item) => item.id !== selfId
      && item.projectId !== currentProjectId
      && item.name.toLowerCase() === lowerName
      && (item.status === ACTIVE || item.status === PENDING))
    .map((item) => ({
      depId: item.id,
      projectId: item.projectId,
      projectName: projectNames.get(item.projectId) || item.projectId,
      name: item.name,
      version: item.version,
      status: item.status,
    }))
    .sort((a, b) => (a.projectName < b.projectName ? -1 : a.projectName > b.projectName ? 1 : 0));
}

function sortDeps(list) {
  return list.slice().sort((a, b) => {
    if (a.projectId !== b.projectId) return a.projectId < b.projectId ? -1 : 1;
    if (a.name !== b.name) return a.name < b.name ? -1 : 1;
    return a.id < b.id ? -1 : 1;
  });
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

  return { deps: sortDeps(list), projects, licenses, statuses: STATUSES.slice() };
}

function getDep(id) {
  const data = load();
  const found = data.deps.find((item) => item.id === id);
  if (!found) throw new ApiError(404, 'DEP_NOT_FOUND', '这条依赖登记不存在或已被删除', '');
  return found;
}

// 弃用前的冲突预检：表单选好项目与依赖名后先问一次，把仍在使用的项目列给操作者
function deprecationCheck(options) {
  const input = options && typeof options === 'object' ? options : {};
  const data = load();
  const name = validateName(input.name);
  let currentProjectId = '';
  if (pickText(input.projectId)) {
    currentProjectId = findProject(data, input.projectId).id;
  }
  const selfId = pickText(input.depId);
  if (selfId) {
    const found = data.deps.find((item) => item.id === selfId);
    if (!found) throw new ApiError(404, 'DEP_NOT_FOUND', '这条依赖登记不存在或已被删除', '');
  }
  return { name, conflicts: findDeprecationConflicts(data, name, selfId, currentProjectId) };
}

function createDep(payload) {
  const input = payload && typeof payload === 'object' ? payload : {};
  const data = load();
  const project = findProject(data, input.projectId);
  const name = validateName(input.name);
  assertNameFree(data, project.id, name, '');
  const status = validateStatus(input.status);
  // 弃用必须走“先登记、再标弃用”的流程，否则理由、操作者与冲突提示都无从谈起
  if (status === DEPRECATED) {
    throw new ApiError(400, 'DEPRECATE_NEEDS_EXISTING_RECORD', '新建登记时不能直接标成已弃用，请先按在用或待升保存，再通过编辑标成弃用', 'status');
  }

  const now = new Date().toISOString();
  const created = {
    id: crypto.randomUUID(),
    projectId: project.id,
    name,
    version: validateVersion(input.version),
    license: validateLicense(input.license),
    owner: validateOwner(input.owner),
    status,
    note: validateNote(input.note),
    deprecationReason: '',
    deprecatedAt: '',
    deprecatedBy: '',
    restoredAt: '',
    restoredBy: '',
    createdAt: now,
    updatedAt: now,
  };
  data.deps.push(created);
  save(data);
  return created;
}

function updateDep(id, payload) {
  const input = payload && typeof payload === 'object' ? payload : {};
  const data = load();
  const found = data.deps.find((item) => item.id === id);
  if (!found) throw new ApiError(404, 'DEP_NOT_FOUND', '这条依赖登记不存在或已被删除', '');

  const now = new Date().toISOString();
  const nextStatus = input.status === undefined ? found.status : validateStatus(input.status);
  const deprecating = found.status !== DEPRECATED && nextStatus === DEPRECATED;
  const restoring = found.status === DEPRECATED && nextStatus !== DEPRECATED;

  // 只要这次保存后登记处于弃用状态（已经弃用、或本次就要弃用），三项冻结字段一律不能动
  if (found.status === DEPRECATED || nextStatus === DEPRECATED) assertLockedFieldsUnchanged(found, input);

  if (restoring) {
    // 恢复只能回到在用，不允许从弃用直接跳成待升
    if (nextStatus !== ACTIVE) {
      throw new ApiError(400, 'DEP_RESTORE_TARGET_INVALID', '已弃用的登记只能恢复成在用，不能直接改成待升', 'status');
    }
    const operator = validateOperator(input.operator);
    applyEditableFields(found, data, input);
    found.status = ACTIVE;
    found.restoredAt = now;
    found.restoredBy = operator;
    found.updatedAt = now;
    save(data);
    return found;
  }

  if (deprecating) {
    const reason = validateDeprecationReason(input.deprecationReason);
    const operator = validateOperator(input.operator);

    const project = input.projectId === undefined ? null : findProject(data, input.projectId);
    const projectId = project ? project.id : found.projectId;
    const name = input.name === undefined ? found.name : validateName(input.name);
    assertNameFree(data, projectId, name, found.id);

    const conflicts = findDeprecationConflicts(data, name, found.id, projectId);
    if (conflicts.length && input.confirmDeprecate !== true) {
      const detail = conflicts.map((item) => `${item.projectName}（${item.status} ${item.version}）`).join('、');
      throw new ApiError(
        409,
        'DEP_DEPRECATION_CONFLICT',
        `依赖 ${name} 还在别的项目里处于在用或待升：${detail}。请先确认这些项目怎么处理；如已了解仍要弃用，勾选“照旧弃用”后再保存`,
        'deprecationReason',
        { conflicts },
      );
    }

    found.projectId = projectId;
    found.name = name;
    found.note = input.note === undefined ? found.note : validateNote(input.note);
    found.status = DEPRECATED;
    found.deprecationReason = reason;
    found.deprecatedAt = now;
    found.deprecatedBy = operator;
    found.restoredAt = '';
    found.restoredBy = '';
    found.updatedAt = now;
    save(data);
    return found;
  }

  // 留在弃用状态的普通保存：冻结字段已在上面拦过，这里只允许改所属项目、依赖名与备注
  if (found.status === DEPRECATED) {
    applyEditableFields(found, data, input);
    found.updatedAt = now;
    save(data);
    return found;
  }

  // 在用与待升之间的普通修改：不涉及弃用留痕，按原口径保存
  applyEditableFields(found, data, input);
  found.status = nextStatus;
  found.updatedAt = now;
  save(data);
  return found;
}

// 应用一次保存里允许编辑的字段；版本、许可、责任人的冻结检查由调用方负责
function applyEditableFields(found, data, input) {
  const project = input.projectId === undefined ? null : findProject(data, input.projectId);
  const projectId = project ? project.id : found.projectId;
  const name = input.name === undefined ? found.name : validateName(input.name);
  assertNameFree(data, projectId, name, found.id);

  found.projectId = projectId;
  found.name = name;
  if (found.status !== DEPRECATED) {
    found.version = input.version === undefined ? found.version : validateVersion(input.version);
    found.license = input.license === undefined ? found.license : validateLicense(input.license);
    found.owner = input.owner === undefined ? found.owner : validateOwner(input.owner);
  }
  found.note = input.note === undefined ? found.note : validateNote(input.note);
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
  deprecationCheck,
  createDep,
  updateDep,
  deleteDep,
  validateName,
  validateVersion,
};
