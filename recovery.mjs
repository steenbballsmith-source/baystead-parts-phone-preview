import {validateJob,hashJson} from './model.mjs';

export const MAX_BACKUP_BYTES = 1048576;
const FORMAT = 'baystead-browser-backup/v1';
const STORAGE = 'baystead-browser-storage/v1';
const STATUSES = ['NOT TESTED','PASS','FAIL','BLOCKED'];
const clone = value => structuredClone(value);
const empty = () => ({job:null,tasks:[],qa:{}});
function record(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value,key))) {
    throw Error(`${label} has an unsupported structure.`);
  }
}
function text(value,max,label,allowEmpty=false) {
  if (typeof value !== 'string' || value.length > max || (!allowEmpty && !value.trim())) throw Error(`${label} is invalid.`);
}

export function validateWorkspace(state) {
  record(state,['job','tasks','qa'],'Workspace');
  if (state.job !== null) {
    const job = state.job;
    record(job,['estimateId','locationId','vehicle','parts','version','history','approved','reason','original'],'Job');
    validateJob(job);
    text(job.reason,500,'Current revision reason',true);
    if (job.reason !== (job.history.at(-1)?.reason || '')) throw Error('Current reason does not match the revision history.');
    record(job.original,['estimateId','locationId','vehicle','parts'],'Original job');
    for (const part of [...job.parts,...job.original.parts]) record(part,['lineId','description','partNumber','partType','quantity','unitPriceCents','supplier'],'Part');
    for (const revision of job.history) {
      record(revision,['version','reason','savedAt','changes'],'Revision');
      for (const change of revision.changes) record(change,['lineId','field','before','after'],'Revision change');
    }
    if (job.approved) record(job.approved,['version','at'],'Approval');
  }
  if (!Array.isArray(state.tasks) || state.tasks.length > 100) throw Error('Workspace task list is invalid.');
  const ids = new Set();
  for (const task of state.tasks) {
    record(task,['id','text','owner','done'],'Task');
    text(task.id,100,'Task ID'); text(task.text,300,'Task'); text(task.owner,80,'Task owner',true);
    if (ids.has(task.id) || typeof task.done !== 'boolean') throw Error('Task IDs must be unique and task status must be valid.');
    ids.add(task.id);
  }
  if (!state.qa || typeof state.qa !== 'object' || Array.isArray(state.qa)) throw Error('Test results are invalid.');
  for (const [id,result] of Object.entries(state.qa)) {
    if (!/^BROWSER0[1-8]$/.test(id)) throw Error('Unknown browser test result.');
    record(result,['status','note'],'Test result');
    if (!STATUSES.includes(result.status)) throw Error('Test result status is invalid.');
    text(result.note,4000,'Test notes',true);
  }
  return state;
}

export function readStored(raw) {
  if (raw === null) return {current:empty(),previous:null};
  const value = JSON.parse(raw);
  if (value?.format !== STORAGE) return {current:validateWorkspace(value),previous:null};
  record(value,['format','current','previous'],'Stored workspace');
  validateWorkspace(value.current);
  if (value.previous !== null) validateWorkspace(value.previous);
  return {current:value.current,previous:value.previous};
}

export function encodeStored(current,previous=null) {
  validateWorkspace(current);
  if (previous !== null) validateWorkspace(previous);
  return JSON.stringify({format:STORAGE,current,previous});
}

export function writeStored(storage,key,expectedRaw,current,previous=null) {
  const raw = encodeStored(current,previous);
  if (storage.getItem(key) !== expectedRaw) throw Error('This workspace changed in another tab. Nothing was replaced. Reload to use the latest saved work.');
  storage.setItem(key,raw);
  return raw;
}

export async function makeBackup(state) {
  validateWorkspace(state);
  const payload = {format:FORMAT,createdAt:new Date().toISOString(),workspace:clone(state)};
  const packet = {...payload,sha256:await hashJson(payload)};
  if (new TextEncoder().encode(JSON.stringify(packet,null,2)).length > MAX_BACKUP_BYTES) throw Error('This workspace exceeds the 1 MB backup limit. Contact Steen before resetting it.');
  return packet;
}

export async function readBackup(raw) {
  if (typeof raw !== 'string' || new TextEncoder().encode(raw).length > MAX_BACKUP_BYTES) throw Error('Choose a Baystead workspace backup smaller than 1 MB.');
  let packet;
  try { packet = JSON.parse(raw); } catch { throw Error('This file is not readable JSON. No work was changed.'); }
  record(packet,['format','createdAt','workspace','sha256'],'Backup');
  if (packet.format !== FORMAT) throw Error('Choose a browser workspace backup, not a review export or Windows file.');
  if (typeof packet.createdAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(packet.createdAt) || !Number.isFinite(Date.parse(packet.createdAt))) throw Error('Backup date is invalid.');
  validateWorkspace(packet.workspace);
  const payload = {format:packet.format,createdAt:packet.createdAt,workspace:packet.workspace};
  if (packet.sha256 !== await hashJson(payload)) throw Error('Backup integrity check failed. No work was changed.');
  return clone(packet);
}

export function workspaceSummary(state) {
  validateWorkspace(state);
  const results = Object.values(state.qa);
  return {
    job:state.job?.estimateId || 'No job',
    revision:state.job?.version ?? null,
    approval:state.job?.approved ? 'Approved locally' : 'Not approved',
    tasks:state.tasks.length,
    openTasks:state.tasks.filter(task=>!task.done).length,
    recordedTests:results.filter(result=>result.status !== 'NOT TESTED' || result.note.trim()).length
  };
}
