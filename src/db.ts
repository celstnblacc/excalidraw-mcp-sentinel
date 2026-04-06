import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import os from 'os';
import logger from './utils/logger.js';
import type { ServerElement, Snapshot } from './types.js';

export interface Tenant {
  id: string;
  name: string;
  workspace_path: string;
  created_at: string;
  last_accessed_at: string;
}

export interface Project {
  id: string;
  name: string;
  description: string | null;
  tenant_id: string;
  created_at: string;
  updated_at: string;
}

export interface ElementVersion {
  id: number;
  element_id: string;
  project_id: string;
  version: number;
  data: ServerElement;
  operation: 'create' | 'update' | 'delete';
  created_at: string;
}

const DEFAULT_PROJECT_ID = 'default';
const DEFAULT_TENANT_ID = 'default';

let db: Database.Database;
let activeTenantId: string = DEFAULT_TENANT_ID;
let activeProjectId: string = DEFAULT_PROJECT_ID;

function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).substring(2);
}

export function initDb(dbPath?: string): void {
  if (db) return; // Already initialized

  const resolvedPath = dbPath
    || process.env.EXCALIDRAW_DB_PATH
    || path.join(os.homedir(), '.excalidraw-mcp', 'excalidraw.db');

  const dir = path.dirname(resolvedPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  db = new Database(resolvedPath);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.pragma('foreign_keys = ON');

  runMigrations();

  // Ensure default tenant exists
  const defaultTenant = db.prepare('SELECT id FROM tenants WHERE id = ?').get(DEFAULT_TENANT_ID);
  if (!defaultTenant) {
    const now = new Date().toISOString();
    db.prepare('INSERT INTO tenants (id, name, workspace_path, created_at, last_accessed_at) VALUES (?, ?, ?, ?, ?)').run(
      DEFAULT_TENANT_ID, 'Default', '(none)', now, now
    );
  }

  // Ensure default project exists and is linked to default tenant
  const defaultProject = db.prepare('SELECT id FROM projects WHERE id = ?').get(DEFAULT_PROJECT_ID);
  if (!defaultProject) {
    db.prepare('INSERT INTO projects (id, name, description, tenant_id) VALUES (?, ?, ?, ?)').run(
      DEFAULT_PROJECT_ID, 'Default', 'Default project', DEFAULT_TENANT_ID
    );
  }

  logger.info(`SQLite database initialized at ${resolvedPath}`);
}

function runMigrations(): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS tenants (
      id               TEXT PRIMARY KEY,
      name             TEXT NOT NULL,
      workspace_path   TEXT NOT NULL,
      created_at       TEXT NOT NULL DEFAULT (datetime('now')),
      last_accessed_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS projects (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      description TEXT,
      created_at  TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS elements (
      id          TEXT PRIMARY KEY,
      project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      type        TEXT NOT NULL,
      data        TEXT NOT NULL,
      label_text  TEXT,
      created_at  TEXT NOT NULL,
      updated_at  TEXT NOT NULL,
      version     INTEGER NOT NULL DEFAULT 1,
      is_deleted  INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS element_versions (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      element_id  TEXT NOT NULL,
      project_id  TEXT NOT NULL,
      version     INTEGER NOT NULL,
      data        TEXT NOT NULL,
      operation   TEXT NOT NULL,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS snapshots (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      name        TEXT NOT NULL,
      elements    TEXT NOT NULL,
      created_at  TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(project_id, name)
    );

    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_elements_project ON elements(project_id);
    CREATE INDEX IF NOT EXISTS idx_elements_type ON elements(project_id, type);
    CREATE INDEX IF NOT EXISTS idx_elements_deleted ON elements(project_id, is_deleted);
    CREATE INDEX IF NOT EXISTS idx_versions_element ON element_versions(element_id);
    CREATE INDEX IF NOT EXISTS idx_versions_project ON element_versions(project_id, created_at);
  `);

  // FTS table
  const ftsExists = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='elements_fts'"
  ).get();

  if (!ftsExists) {
    db.exec(`
      CREATE VIRTUAL TABLE elements_fts USING fts5(
        element_id,
        label_text,
        type
      );
    `);
  }

  // Migration: add tenant_id to projects if it doesn't exist (upgrading from older schema)
  const cols = db.prepare("PRAGMA table_info(projects)").all() as { name: string }[];
  const hasTenantCol = cols.some(c => c.name === 'tenant_id');
  if (!hasTenantCol) {
    db.exec(`ALTER TABLE projects ADD COLUMN tenant_id TEXT REFERENCES tenants(id)`);
    logger.info('Migrated: added tenant_id column to projects');
  }

  db.exec(`CREATE INDEX IF NOT EXISTS idx_projects_tenant ON projects(tenant_id)`);

  // Migration: add sync_version to elements table
  const elementCols = db.prepare("PRAGMA table_info(elements)").all() as { name: string }[];
  if (!elementCols.some(c => c.name === 'sync_version')) {
    db.exec(`ALTER TABLE elements ADD COLUMN sync_version INTEGER NOT NULL DEFAULT 0`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_elements_sync_version ON elements(project_id, sync_version)`);
    logger.info('Migrated: added sync_version column to elements');
  }

  // Migration: add sync_version counter to projects table
  const projectCols = db.prepare("PRAGMA table_info(projects)").all() as { name: string }[];
  if (!projectCols.some(c => c.name === 'sync_version')) {
    db.exec(`ALTER TABLE projects ADD COLUMN sync_version INTEGER NOT NULL DEFAULT 0`);
    logger.info('Migrated: added sync_version counter to projects');
  }

  // Migration: assign orphan projects (no tenant_id) to default tenant
  const orphans = db.prepare('SELECT id FROM projects WHERE tenant_id IS NULL').all() as { id: string }[];
  if (orphans.length > 0) {
    // Ensure default tenant exists for migration
    const defTenant = db.prepare('SELECT id FROM tenants WHERE id = ?').get(DEFAULT_TENANT_ID);
    if (!defTenant) {
      const now = new Date().toISOString();
      db.prepare('INSERT INTO tenants (id, name, workspace_path, created_at, last_accessed_at) VALUES (?, ?, ?, ?, ?)').run(
        DEFAULT_TENANT_ID, 'Default', '(none)', now, now
      );
    }
    db.prepare('UPDATE projects SET tenant_id = ? WHERE tenant_id IS NULL').run(DEFAULT_TENANT_ID);
    logger.info(`Migrated: assigned ${orphans.length} orphan projects to default tenant`);
  }
}

function extractLabelText(element: ServerElement): string | null {
  if (element.label?.text) return element.label.text;
  if (element.text) return element.text;
  return null;
}

// Resolve effective project ID: explicit override > in-memory active
function pid(override?: string): string {
  return override ?? activeProjectId;
}

// ── Sync Version ──

export function incrementSyncVersion(projectId?: string): number {
  const p = pid(projectId);
  db.prepare('UPDATE projects SET sync_version = sync_version + 1 WHERE id = ?').run(p);
  const row = db.prepare('SELECT sync_version FROM projects WHERE id = ?').get(p) as { sync_version: number } | undefined;
  return row?.sync_version ?? 0;
}

export function getCurrentSyncVersion(projectId?: string): number {
  const p = pid(projectId);
  const row = db.prepare('SELECT sync_version FROM projects WHERE id = ?').get(p) as { sync_version: number } | undefined;
  return row?.sync_version ?? 0;
}

export interface ElementChange {
  id: string;
  action: 'upsert' | 'delete';
  element: ServerElement;
  sync_version: number;
}

export function getChangesSince(sinceVersion: number, projectId?: string): ElementChange[] {
  const p = pid(projectId);
  const rows = db.prepare(`
    SELECT id, data, sync_version, is_deleted FROM elements
    WHERE project_id = ? AND sync_version > ?
    ORDER BY sync_version ASC
  `).all(p, sinceVersion) as { id: string; data: string; sync_version: number; is_deleted: number }[];

  return rows.map(r => ({
    id: r.id,
    action: r.is_deleted ? 'delete' as const : 'upsert' as const,
    element: JSON.parse(r.data),
    sync_version: r.sync_version
  }));
}

// Given a tenant ID, return its default project (creating one if needed)
export function getDefaultProjectForTenant(tenantId: string): string {
  const row = db.prepare(
    'SELECT id FROM projects WHERE tenant_id = ? ORDER BY created_at ASC LIMIT 1'
  ).get(tenantId) as { id: string } | undefined;

  if (row) return row.id;

  const id = `${tenantId}-default`;
  const now = new Date().toISOString();
  db.prepare(
    'INSERT INTO projects (id, name, description, tenant_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(id, 'Default', 'Default project', tenantId, now, now);
  return id;
}

// ── Native field normalization ──

// Fill any missing native Excalidraw fields so every element stored in the DB
// is a complete, round-trippable Excalidraw element — not just an MCP partial.
function fillNativeFields(element: ServerElement): ServerElement {
  const el = element as any;

  // ── Universal fields ──────────────────────────────────────────────────────
  el.angle           = el.angle           ?? 0;
  el.strokeColor     = el.strokeColor     ?? '#1e1e1e';
  el.backgroundColor = el.backgroundColor ?? 'transparent';
  el.fillStyle       = el.fillStyle       ?? 'solid';
  el.strokeWidth     = el.strokeWidth     ?? 2;
  el.strokeStyle     = el.strokeStyle     ?? 'solid';
  el.roughness       = el.roughness       ?? 1;
  el.opacity         = el.opacity         ?? 100;
  el.groupIds        = el.groupIds        ?? [];
  el.frameId         = el.frameId         ?? null;
  el.seed            = el.seed            ?? Math.floor(Math.random() * 2147483647);
  el.versionNonce    = el.versionNonce    ?? Math.floor(Math.random() * 2147483647);
  el.isDeleted       = el.isDeleted       ?? false;
  el.updated         = el.updated         ?? Date.now();
  el.link            = el.link            ?? null;
  el.locked          = el.locked          ?? false;
  el.boundElements   = el.boundElements   ?? null;

  // index: preserve existing; generate a stable sortable value if absent
  if (!el.index) {
    el.index = `a${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
  }

  // roundness: Excalidraw default is rounded (type 3) for closed shapes
  if (el.roundness === undefined) {
    const rounded = el.type === 'rectangle' || el.type === 'diamond' || el.type === 'ellipse';
    el.roundness = rounded ? { type: 3 } : null;
  }

  // ── Type-specific fields ──────────────────────────────────────────────────
  if (el.type === 'text') {
    el.text          = el.text          ?? '';
    el.originalText  = el.originalText  ?? el.text;
    el.fontSize      = el.fontSize      ?? 20;
    el.fontFamily    = el.fontFamily    ?? 5;       // Nunito
    el.textAlign     = el.textAlign     ?? 'left';
    el.verticalAlign = el.verticalAlign ?? (el.containerId ? 'middle' : 'top');
    el.autoResize    = el.autoResize    ?? true;
    el.lineHeight    = el.lineHeight    ?? 1.25;
    el.containerId   = el.containerId   ?? null;
  } else if (el.type === 'arrow' || el.type === 'line') {
    el.points             = el.points             ?? [[0, 0], [100, 0]];
    el.lastCommittedPoint = el.lastCommittedPoint ?? null;
    el.startBinding       = el.startBinding       ?? null;
    el.endBinding         = el.endBinding         ?? null;
    el.startArrowhead     = el.startArrowhead     ?? null;
    el.endArrowhead       = el.endArrowhead       ?? (el.type === 'arrow' ? 'arrow' : null);
    el.elbowed            = el.elbowed            ?? false;
  } else if (el.type === 'image') {
    el.status = el.status ?? 'pending';
    el.scale  = el.scale  ?? [1, 1];
  } else if (el.type === 'freedraw') {
    el.points             = el.points             ?? [];
    el.pressures          = el.pressures          ?? [];
    el.simulatePressure   = el.simulatePressure   ?? true;
    el.lastCommittedPoint = el.lastCommittedPoint ?? null;
  }

  return el as ServerElement;
}

// When a text element with containerId is saved, ensure the container's
// boundElements array references it back. Both sides must be consistent
// for Excalidraw to treat the text as embedded in the shape.
function repairContainerBinding(element: ServerElement, projectId?: string): void {
  if (element.type !== 'text') return;
  const cid = (element as any).containerId as string | null | undefined;
  if (!cid) return;
  const container = getElement(cid, projectId);
  if (!container) return;
  const existing: any[] = Array.isArray((container as any).boundElements)
    ? (container as any).boundElements as any[]
    : [];
  if (existing.some((b: any) => b.id === element.id)) return;
  // Update container directly — container.type is never 'text' so this
  // cannot recurse back into repairContainerBinding.
  setElement(cid, {
    ...container,
    boundElements: [...existing, { type: 'text', id: element.id }]
  } as ServerElement, projectId);
}

// ── Element CRUD ──

export function getElement(id: string, projectId?: string): ServerElement | undefined {
  const row = db.prepare(
    'SELECT data FROM elements WHERE id = ? AND project_id = ? AND is_deleted = 0'
  ).get(id, pid(projectId)) as { data: string } | undefined;
  return row ? JSON.parse(row.data) : undefined;
}

export function hasElement(id: string, projectId?: string): boolean {
  const row = db.prepare(
    'SELECT 1 FROM elements WHERE id = ? AND project_id = ? AND is_deleted = 0'
  ).get(id, pid(projectId));
  return !!row;
}

export function setElement(id: string, element: ServerElement, projectId?: string): number {
  const p = pid(projectId);
  const now = new Date().toISOString();
  const normalized = fillNativeFields(element);
  const data = JSON.stringify(normalized);
  const labelText = extractLabelText(normalized);
  const sv = incrementSyncVersion(p);
  const existing = db.prepare(
    'SELECT version, is_deleted FROM elements WHERE id = ? AND project_id = ?'
  ).get(id, p) as { version: number; is_deleted: number } | undefined;

  if (existing) {
    const newVersion = existing.is_deleted ? 1 : (existing.version + 1);
    db.prepare(`
      UPDATE elements SET type = ?, data = ?, label_text = ?, updated_at = ?, version = ?, is_deleted = 0, sync_version = ?
      WHERE id = ? AND project_id = ?
    `).run(normalized.type, data, labelText, now, newVersion, sv, id, p);

    recordVersion(id, newVersion, data, existing.is_deleted ? 'create' : 'update', p);
    updateFts(id, labelText, normalized.type);
  } else {
    db.prepare(`
      INSERT INTO elements (id, project_id, type, data, label_text, created_at, updated_at, version, sync_version)
      VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)
    `).run(id, p, normalized.type, data, labelText, now, now, sv);

    recordVersion(id, 1, data, 'create', p);
    insertFts(id, labelText, normalized.type);
  }
  repairContainerBinding(normalized, projectId);
  return sv;
}

export function deleteElement(id: string, projectId?: string): boolean {
  const p = pid(projectId);
  const existing = db.prepare(
    'SELECT version, data FROM elements WHERE id = ? AND project_id = ? AND is_deleted = 0'
  ).get(id, p) as { version: number; data: string } | undefined;

  if (!existing) return false;

  const newVersion = existing.version + 1;
  const sv = incrementSyncVersion(p);
  db.prepare(`
    UPDATE elements SET is_deleted = 1, version = ?, updated_at = ?, sync_version = ?
    WHERE id = ? AND project_id = ?
  `).run(newVersion, new Date().toISOString(), sv, id, p);

  recordVersion(id, newVersion, existing.data, 'delete', p);
  deleteFts(id);
  return true;
}

export function getAllElements(projectId?: string): ServerElement[] {
  const rows = db.prepare(
    'SELECT data FROM elements WHERE project_id = ? AND is_deleted = 0'
  ).all(pid(projectId)) as { data: string }[];
  return rows.map(r => JSON.parse(r.data));
}

export function getElementCount(projectId?: string): number {
  const row = db.prepare(
    'SELECT COUNT(*) as count FROM elements WHERE project_id = ? AND is_deleted = 0'
  ).get(pid(projectId)) as { count: number };
  return row.count;
}

export function clearElements(projectId?: string): number {
  const p = pid(projectId);
  const now = new Date().toISOString();
  const elements = getAllElements(p);
  const sv = incrementSyncVersion(p);

  const stmt = db.prepare(`
    UPDATE elements SET is_deleted = 1, version = version + 1, updated_at = ?, sync_version = ?
    WHERE project_id = ? AND is_deleted = 0
  `);

  const clearTx = db.transaction(() => {
    const info = stmt.run(now, sv, p);
    for (const el of elements) {
      recordVersion(el.id, (el.version || 1) + 1, JSON.stringify(el), 'delete', p);
      deleteFts(el.id);
    }
    return info.changes;
  });

  return clearTx() as number;
}

export function queryElements(type?: string, filter?: Record<string, any>, projectId?: string): ServerElement[] {
  let elements = getAllElements(projectId);
  if (type) {
    elements = elements.filter(el => el.type === type);
  }
  if (filter) {
    elements = elements.filter(el => {
      return Object.entries(filter).every(([key, value]) => {
        return (el as any)[key] === value;
      });
    });
  }
  return elements;
}

export function searchElements(query: string, projectId?: string): ServerElement[] {
  const rows = db.prepare(`
    SELECT e.data FROM elements e
    INNER JOIN elements_fts fts ON fts.element_id = e.id
    WHERE elements_fts MATCH ? AND e.project_id = ? AND e.is_deleted = 0
  `).all(query, pid(projectId)) as { data: string }[];
  return rows.map(r => JSON.parse(r.data));
}

// ── FTS helpers ──

function insertFts(elementId: string, labelText: string | null, type: string): void {
  db.prepare('INSERT INTO elements_fts (element_id, label_text, type) VALUES (?, ?, ?)').run(
    elementId, labelText || '', type
  );
}

function updateFts(elementId: string, labelText: string | null, type: string): void {
  deleteFts(elementId);
  insertFts(elementId, labelText, type);
}

function deleteFts(elementId: string): void {
  db.prepare("DELETE FROM elements_fts WHERE element_id = ?").run(elementId);
}

// ── Version history ──

function recordVersion(elementId: string, version: number, data: string, operation: string, projectId?: string): void {
  db.prepare(`
    INSERT INTO element_versions (element_id, project_id, version, data, operation)
    VALUES (?, ?, ?, ?, ?)
  `).run(elementId, pid(projectId), version, data, operation);
}

export function getElementHistory(elementId: string, limit: number = 50, projectId?: string): ElementVersion[] {
  const rows = db.prepare(`
    SELECT id, element_id, project_id, version, data, operation, created_at
    FROM element_versions WHERE element_id = ? AND project_id = ?
    ORDER BY created_at DESC LIMIT ?
  `).all(elementId, pid(projectId), limit) as any[];
  return rows.map(r => ({ ...r, data: JSON.parse(r.data) }));
}

export function getProjectHistory(limit: number = 100, projectId?: string): ElementVersion[] {
  const rows = db.prepare(`
    SELECT id, element_id, project_id, version, data, operation, created_at
    FROM element_versions WHERE project_id = ?
    ORDER BY created_at DESC LIMIT ?
  `).all(pid(projectId), limit) as any[];
  return rows.map(r => ({ ...r, data: JSON.parse(r.data) }));
}

// ── Snapshots ──

export function saveSnapshot(name: string, elements: ServerElement[], projectId?: string): void {
  const data = JSON.stringify(elements);
  db.prepare(`
    INSERT OR REPLACE INTO snapshots (project_id, name, elements, created_at)
    VALUES (?, ?, ?, datetime('now'))
  `).run(pid(projectId), name, data);
}

export function getSnapshot(name: string, projectId?: string): Snapshot | undefined {
  const row = db.prepare(
    'SELECT name, elements, created_at FROM snapshots WHERE name = ? AND project_id = ?'
  ).get(name, pid(projectId)) as { name: string; elements: string; created_at: string } | undefined;

  if (!row) return undefined;
  return { name: row.name, elements: JSON.parse(row.elements), createdAt: row.created_at };
}

export function listSnapshots(projectId?: string): { name: string; elementCount: number; createdAt: string }[] {
  const rows = db.prepare(
    'SELECT name, elements, created_at FROM snapshots WHERE project_id = ? ORDER BY created_at DESC'
  ).all(pid(projectId)) as { name: string; elements: string; created_at: string }[];
  return rows.map(r => ({
    name: r.name,
    elementCount: (JSON.parse(r.elements) as any[]).length,
    createdAt: r.created_at
  }));
}

// ── Tenants ──

export function ensureTenant(id: string, name: string, workspacePath: string): Tenant {
  const now = new Date().toISOString();
  const existing = db.prepare('SELECT * FROM tenants WHERE id = ?').get(id) as Tenant | undefined;

  if (existing) {
    db.prepare('UPDATE tenants SET last_accessed_at = ? WHERE id = ?').run(now, id);
    return { ...existing, last_accessed_at: now };
  }

  db.prepare(
    'INSERT INTO tenants (id, name, workspace_path, created_at, last_accessed_at) VALUES (?, ?, ?, ?, ?)'
  ).run(id, name, workspacePath, now, now);

  return { id, name, workspace_path: workspacePath, created_at: now, last_accessed_at: now };
}

export function setActiveTenant(id: string): void {
  const tenant = db.prepare('SELECT id FROM tenants WHERE id = ?').get(id);
  if (!tenant) throw new Error(`Tenant "${id}" not found`);
  activeTenantId = id;

  // Auto-set active project to the tenant's first project, creating a default if none exists
  const firstProject = db.prepare(
    'SELECT id FROM projects WHERE tenant_id = ? ORDER BY created_at ASC LIMIT 1'
  ).get(id) as { id: string } | undefined;

  if (firstProject) {
    activeProjectId = firstProject.id;
  } else {
    const defaultId = `${id}-default`;
    const now = new Date().toISOString();
    db.prepare(
      'INSERT INTO projects (id, name, description, tenant_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(defaultId, 'Default', 'Default project', id, now, now);
    activeProjectId = defaultId;
  }

  logger.info(`Active tenant set to "${id}", active project: "${activeProjectId}"`);
}

export function getActiveTenant(): Tenant {
  return db.prepare('SELECT * FROM tenants WHERE id = ?').get(activeTenantId) as Tenant;
}

export function getTenantById(id: string): Tenant | undefined {
  return db.prepare('SELECT * FROM tenants WHERE id = ?').get(id) as Tenant | undefined;
}

export function getActiveTenantId(): string {
  return activeTenantId;
}

export function listTenants(): Tenant[] {
  return db.prepare('SELECT * FROM tenants ORDER BY last_accessed_at DESC').all() as Tenant[];
}

export function deleteTenant(id: string): void {
  if (id === activeTenantId) throw new Error('Cannot delete the active tenant — switch to another tenant first');
  const tenants = listTenants();
  if (tenants.length <= 1) throw new Error('Cannot delete the last tenant');
  const tenant = getTenantById(id);
  if (!tenant) throw new Error(`Tenant "${id}" not found`);
  // CASCADE: delete elements + element_versions for all projects in this tenant, then projects, then tenant
  const projects = db.prepare('SELECT id FROM projects WHERE tenant_id = ?').all(id) as { id: string }[];
  const deleteElements = db.prepare('DELETE FROM elements WHERE project_id = ?');
  const deleteVersions = db.prepare('DELETE FROM element_versions WHERE element_id IN (SELECT id FROM elements WHERE project_id = ?)');
  const deleteSnapshots = db.prepare('DELETE FROM snapshots WHERE project_id = ?');
  for (const p of projects) {
    deleteVersions.run(p.id);
    deleteElements.run(p.id);
    deleteSnapshots.run(p.id);
  }
  db.prepare('DELETE FROM projects WHERE tenant_id = ?').run(id);
  db.prepare('DELETE FROM tenants WHERE id = ?').run(id);
}

// ── Projects ──

export function createProject(name: string, description?: string, tenantId?: string): Project {
  const tid = tenantId ?? activeTenantId;
  const id = generateId();
  const now = new Date().toISOString();
  db.prepare(
    'INSERT INTO projects (id, name, description, tenant_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(id, name, description || null, tid, now, now);
  return { id, name, description: description || null, tenant_id: tid, created_at: now, updated_at: now };
}

export function listProjects(tenantId?: string): Project[] {
  const tid = tenantId ?? activeTenantId;
  return db.prepare('SELECT * FROM projects WHERE tenant_id = ? ORDER BY updated_at DESC').all(tid) as Project[];
}

export function getProjectForTenant(projectId: string, tenantId: string): Project | undefined {
  return db.prepare(
    'SELECT * FROM projects WHERE id = ? AND tenant_id = ?'
  ).get(projectId, tenantId) as Project | undefined;
}

export function setActiveProject(id: string): void {
  const project = db.prepare('SELECT id, tenant_id FROM projects WHERE id = ?').get(id) as { id: string; tenant_id: string } | undefined;
  if (!project) throw new Error(`Project "${id}" not found`);
  if (project.tenant_id !== activeTenantId) {
    throw new Error(`Project "${id}" belongs to tenant "${project.tenant_id}", not the active tenant "${activeTenantId}"`);
  }
  activeProjectId = id;
}

export function getActiveProject(): Project {
  return db.prepare('SELECT * FROM projects WHERE id = ?').get(activeProjectId) as Project;
}

export function getActiveProjectId(): string {
  return activeProjectId;
}

export function deleteProject(id: string): void {
  const projects = listProjects();
  if (projects.length <= 1) throw new Error('Cannot delete the last project');
  const project = db.prepare('SELECT id, tenant_id FROM projects WHERE id = ?').get(id) as { id: string; tenant_id: string } | undefined;
  if (!project) throw new Error(`Project "${id}" not found`);
  if (project.tenant_id !== activeTenantId) throw new Error(`Project "${id}" does not belong to the active tenant`);
  if (id === activeProjectId) throw new Error('Cannot delete the active project — switch to another project first');
  // CASCADE deletes elements, element_versions rows, and snapshots automatically
  db.prepare('DELETE FROM projects WHERE id = ?').run(id);
}

export function getElementCountForProject(projectId: string): number {
  const row = db.prepare('SELECT COUNT(*) as cnt FROM elements WHERE project_id = ? AND (data NOT LIKE \'%"is_deleted":true%\')').get(projectId) as { cnt: number };
  return row.cnt;
}

// ── Bulk operations (for sync endpoint) ──

export function bulkReplaceElements(elements: ServerElement[], projectId?: string): number {
  const tx = db.transaction(() => {
    clearElements(projectId);
    for (const el of elements) {
      setElement(el.id, el, projectId);
    }
    return elements.length;
  });
  return tx();
}

// ── Settings ──

export function getSetting(key: string): string | undefined {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value;
}

export function setSetting(key: string, value: string): void {
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, value);
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = undefined as any;
    logger.info('SQLite database closed');
  }
}
