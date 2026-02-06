import { useState, useEffect } from 'react';
import type { DashboardState } from '../lib/api.js';
import { createShellTab } from '../lib/api.js';
import { getApiBase } from '../lib/constants.js';
import { FileTree } from './FileTree.js';

interface StatusPanelProps {
  state: DashboardState | null;
  onRefresh: () => void;
  onSelectTab?: (id: string) => void;
}

interface Project {
  id: string;
  title: string;
  status: string;
  summary?: string;
  priority?: string;
  notes?: string;
  files?: { spec?: string | null; plan?: string | null; review?: string | null };
  timestamps?: Record<string, string | null>;
  dependencies?: string[];
  tags?: string[];
  ticks?: string[];
}

/** Collapsible section matching legacy dashboard-section behavior */
function Section({
  title,
  className,
  defaultOpen = true,
  actions,
  children,
}: {
  title: string;
  className?: string;
  defaultOpen?: boolean;
  actions?: React.ReactNode;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className={`dashboard-section${open ? '' : ' collapsed'}${className ? ' ' + className : ''}`}>
      <div className="dashboard-section-header" onClick={() => setOpen(!open)}>
        <h3>
          <span className="collapse-icon">▼</span> {title}
        </h3>
        {actions && <div className="header-actions" onClick={e => e.stopPropagation()}>{actions}</div>}
      </div>
      {open && <div className="dashboard-section-content">{children}</div>}
    </div>
  );
}

// --- Project parsing (matches legacy parseProjectEntry/isValidProject) ---

function parseProjectEntry(text: string): Project | null {
  const proj: Record<string, unknown> = {};
  const lines = text.split('\n');

  for (const line of lines) {
    const match = line.match(/^\s*-?\s*(\w+):\s*(.*)$/);
    if (!match) continue;
    const [, key, rawValue] = match;
    let value = rawValue.trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }

    // Nested: files
    if (key === 'files') { proj.files = {}; continue; }
    if (key === 'spec' || key === 'plan' || key === 'review') {
      if (!proj.files) proj.files = {};
      (proj.files as Record<string, string | null>)[key] = value === 'null' ? null : value;
      continue;
    }

    // Nested: timestamps
    if (key === 'timestamps') { proj.timestamps = {}; continue; }
    const tsFields = ['conceived_at', 'specified_at', 'planned_at', 'implementing_at', 'implemented_at', 'committed_at', 'integrated_at'];
    if (tsFields.includes(key)) {
      if (!proj.timestamps) proj.timestamps = {};
      (proj.timestamps as Record<string, string | null>)[key] = value === 'null' ? null : value;
      continue;
    }

    // Arrays
    if (key === 'dependencies' || key === 'tags' || key === 'ticks') {
      if (value.startsWith('[') && value.endsWith(']')) {
        const inner = value.slice(1, -1).trim();
        proj[key] = inner === '' ? [] : inner.split(',').map(s => s.trim().replace(/^["']|["']$/g, ''));
      } else {
        proj[key] = [];
      }
      continue;
    }

    if (value !== 'null') proj[key] = value;
  }

  return proj as unknown as Project;
}

const VALID_STATUSES = new Set(['conceived', 'specified', 'planned', 'implementing', 'implemented', 'committed', 'integrated', 'abandoned', 'on-hold']);

function isValidProject(p: Project): boolean {
  if (!p.id || p.id === 'NNNN' || !/^\d{4}$/.test(p.id)) return false;
  if (!p.status || !VALID_STATUSES.has(p.status)) return false;
  if (!p.title) return false;
  if (p.tags && p.tags.includes('example')) return false;
  return true;
}

function parseProjectlist(text: string): Project[] {
  const projects: Project[] = [];
  const yamlBlockRegex = /```yaml\n([\s\S]*?)```/g;
  let match;
  while ((match = yamlBlockRegex.exec(text)) !== null) {
    const block = match[1];
    const entries = block.split(/\n(?=\s*- id:)/);
    for (const entry of entries) {
      if (!entry.trim() || !entry.includes('id:')) continue;
      const proj = parseProjectEntry(entry);
      if (proj && isValidProject(proj)) projects.push(proj);
    }
  }
  return projects;
}

// --- Sorting and filtering (matches legacy renderKanbanGrid) ---

const STATUS_ORDER = ['conceived', 'specified', 'planned', 'implementing', 'implemented', 'committed', 'integrated'];
const STATUS_LABELS = ["CONC'D", "SPEC'D", "PLANNED", "IMPL'ING", "IMPL'D", "CMTD", "INTGR'D"];
const ACTIVE_STATUSES = new Set(['conceived', 'specified', 'planned', 'implementing', 'implemented', 'committed']);
const TERMINAL_STATUSES = new Set(['abandoned', 'on-hold']);

function isRecentlyIntegrated(p: Project): boolean {
  if (p.status !== 'integrated') return false;
  const integratedAt = p.timestamps?.integrated_at;
  if (!integratedAt) return false;
  const d = new Date(integratedAt);
  if (isNaN(d.getTime())) return false;
  return (Date.now() - d.getTime()) / (1000 * 60 * 60) <= 72; // 3 days
}

function getStatusIndex(status: string): number {
  const idx = STATUS_ORDER.indexOf(status);
  return idx >= 0 ? idx : -1;
}

// --- Stage cell content (spec/plan/review/PR links) ---

function getStageCellContent(project: Project, stage: string): { label: string; link: string | null; external?: boolean } {
  switch (stage) {
    case 'specified':
      if (project.files?.spec) return { label: 'Spec', link: project.files.spec };
      return { label: '', link: null };
    case 'planned':
      if (project.files?.plan) return { label: 'Plan', link: project.files.plan };
      return { label: '', link: null };
    case 'implemented':
      if (project.files?.review) return { label: 'Revw', link: project.files.review };
      return { label: '', link: null };
    case 'committed': {
      if (project.notes) {
        const prMatch = project.notes.match(/PR\s*#?(\d+)/i);
        if (prMatch) return { label: 'PR', link: `https://github.com/cluesmith/codev/pull/${prMatch[1]}`, external: true };
      }
      return { label: '', link: null };
    }
    default:
      return { label: '', link: null };
  }
}

// --- Render helpers ---

function StageCell({ project, stage }: { project: Project; stage: string }) {
  const currentIdx = getStatusIndex(project.status);
  const stageIdx = getStatusIndex(stage);

  if (stageIdx < currentIdx) {
    // Completed stage
    const content = getStageCellContent(project, stage);
    return (
      <td className="project-stage">
        <span className="checkmark">✓</span>
        {content.label && content.link && (
          content.external
            ? <> <a href={content.link} target="_blank" rel="noreferrer">{content.label}</a></>
            : <> <a href="#" onClick={e => { e.preventDefault(); openFile(content.link!); }}>{content.label}</a></>
        )}
      </td>
    );
  }

  if (stageIdx === currentIdx) {
    // Current stage
    if (stage === 'integrated' && isRecentlyIntegrated(project)) {
      return <td className="project-stage"><span className="celebration">🎉</span></td>;
    }
    const content = getStageCellContent(project, stage);
    return (
      <td className="project-stage">
        <span className="current-indicator" />
        {content.label && content.link && (
          content.external
            ? <> <a href={content.link} target="_blank" rel="noreferrer">{content.label}</a></>
            : <> <a href="#" onClick={e => { e.preventDefault(); openFile(content.link!); }}>{content.label}</a></>
        )}
      </td>
    );
  }

  // Future stage — empty
  return <td className="project-stage" />;
}

async function openFile(path: string) {
  try {
    const base = getApiBase();
    await fetch(`${base}api/tabs/file`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path }),
    });
  } catch { /* ignore */ }
}

function ProjectRow({ project }: { project: Project }) {
  const isTerminal = TERMINAL_STATUSES.has(project.status);
  return (
    <tr className={`project-row status-${project.status}`}>
      <td className="project-cell">
        <span className="project-id">{project.id}</span>
        <span className="project-title">
          {project.title}
          {isTerminal && <span className="project-terminal-status"> ({project.status})</span>}
        </span>
      </td>
      {isTerminal
        ? STATUS_ORDER.map(s => <td key={s} className="project-stage" />)
        : STATUS_ORDER.map(s => <StageCell key={s} project={project} stage={s} />)
      }
    </tr>
  );
}

function ProjectTable({ projects }: { projects: Project[] }) {
  if (projects.length === 0) return <p style={{ color: 'var(--text-muted)', textAlign: 'center', padding: 20 }}>No projects</p>;
  return (
    <table className="project-table">
      <thead>
        <tr>
          <th style={{ textAlign: 'left' }}>Project</th>
          {STATUS_LABELS.map(l => <th key={l} className="stage-header">{l}</th>)}
        </tr>
      </thead>
      <tbody>
        {projects.map(p => <ProjectRow key={p.id} project={p} />)}
      </tbody>
    </table>
  );
}

function ProjectsView({ projects }: { projects: Project[] }) {
  // Split: active (+ recently integrated) vs old integrated vs terminal
  const activeProjects = projects.filter(p =>
    ACTIVE_STATUSES.has(p.status) || isRecentlyIntegrated(p)
  );

  // Sort active: furthest along first, then by ID
  activeProjects.sort((a, b) => {
    const orderA = getStatusIndex(a.status);
    const orderB = getStatusIndex(b.status);
    if (orderB !== orderA) return orderB - orderA;
    return a.id.localeCompare(b.id);
  });

  const completedProjects = projects.filter(p =>
    p.status === 'integrated' && !isRecentlyIntegrated(p)
  );

  const terminalProjects = projects.filter(p => TERMINAL_STATUSES.has(p.status));

  return (
    <>
      {(activeProjects.length > 0 || completedProjects.length === 0) && (
        <details className="project-section" open>
          <summary>Active <span className="section-count">({activeProjects.length})</span></summary>
          <ProjectTable projects={activeProjects} />
        </details>
      )}
      {completedProjects.length > 0 && (
        <details className="project-section">
          <summary>Completed <span className="section-count">({completedProjects.length})</span></summary>
          <ProjectTable projects={completedProjects} />
        </details>
      )}
      {terminalProjects.length > 0 && (
        <details className="project-section">
          <summary>Terminal <span className="section-count">({terminalProjects.length})</span></summary>
          <ProjectTable projects={terminalProjects} />
        </details>
      )}
    </>
  );
}

// --- Main component ---

export function StatusPanel({ state, onRefresh, onSelectTab }: StatusPanelProps) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectsError, setProjectsError] = useState<string | null>(null);

  useEffect(() => {
    let lastHash = '';
    const fetchProjects = () => {
      const base = getApiBase();
      fetch(`${base}file?path=codev/projectlist.md`)
        .then(async res => {
          if (!res.ok) {
            if (res.status === 404) { setProjects([]); return; }
            throw new Error(`HTTP ${res.status}`);
          }
          const text = await res.text();
          const hash = text.length + ':' + text.slice(0, 100);
          if (hash !== lastHash) {
            lastHash = hash;
            setProjects(parseProjectlist(text));
            setProjectsError(null);
          }
        })
        .catch(err => setProjectsError(err.message));
    };
    fetchProjects();
    const interval = setInterval(fetchProjects, 5000);
    return () => clearInterval(interval);
  }, []);

  if (!state) {
    return <div className="dashboard-container"><p style={{ color: 'var(--text-muted)', padding: 16 }}>Loading...</p></div>;
  }

  const handleNewShell = async () => {
    try { await createShellTab(); onRefresh(); } catch (err) { console.error('Failed to create shell:', err); }
  };

  const builders = state.builders ?? [];
  const shells = (state.utils ?? []).filter(s => s.terminalId || (s.pid && s.pid !== 0));
  const files = state.annotations ?? [];

  return (
    <div className="dashboard-container">
      {/* Info header */}
      <div className="projects-info">
        <h1 style={{ fontSize: 20, marginBottom: 12, color: 'var(--text-primary)' }}>Agent Farm Dashboard</h1>
        <p>
          Coordinate AI builders working on your codebase. The left panel shows the Architect terminal –
          tell it what you want to build. <strong>Tabs</strong> shows open terminals (Architect, Builders, utility shells).{' '}
          <strong>Files</strong> lets you browse and open project files. <strong>Projects</strong> tracks work as it
          moves from conception to integration.
        </p>
        <p>
          Docs:{' '}
          <a href="#" onClick={e => { e.preventDefault(); openFile('codev/resources/cheatsheet.md'); }}>Cheatsheet</a> ·{' '}
          <a href="#" onClick={e => { e.preventDefault(); openFile('codev/resources/lifecycle.md'); }}>Lifecycle</a> ·{' '}
          <a href="#" onClick={e => { e.preventDefault(); openFile('codev/resources/commands/overview.md'); }}>CLI Reference</a> ·{' '}
          <a href="#" onClick={e => { e.preventDefault(); openFile('codev/protocols/spider/protocol.md'); }}>SPIDER Protocol</a> ·{' '}
          <a href="https://github.com/cluesmith/codev#readme" target="_blank" rel="noreferrer">README</a> ·{' '}
          <a href="https://discord.gg/mJ92DhDa6n" target="_blank" rel="noreferrer">Discord</a>
        </p>
      </div>

      {/* Two-column: TABS + FILES side by side */}
      <div className="dashboard-header">
        <Section
          title="Tabs"
          className="section-tabs"
          actions={<button onClick={handleNewShell}>+ Shell</button>}
        >
          <div className="dashboard-tabs-list">
            {state.architect && (
              <div className="dashboard-tab-item" onClick={() => onSelectTab?.('architect')}>
                <span className="tab-icon">🏗️</span>
                <span className="tab-name">Architect</span>
              </div>
            )}
            {builders.map(b => (
              <div key={b.id} className="dashboard-tab-item" onClick={() => onSelectTab?.(b.id)}>
                <span className="tab-icon">🔨</span>
                <span className="tab-name">{b.name}</span>
                <span className={`status-dot status-${b.status}`} />
              </div>
            ))}
            {shells.map(s => (
              <div key={s.id} className="dashboard-tab-item" onClick={() => onSelectTab?.(s.id)}>
                <span className="tab-icon">💻</span>
                <span className="tab-name">{s.name}</span>
              </div>
            ))}
            {files.map(f => (
              <div key={f.id} className="dashboard-tab-item" onClick={() => onSelectTab?.(f.id)}>
                <span className="tab-icon">📄</span>
                <span className="tab-name">{f.file.split('/').pop()}</span>
              </div>
            ))}
            {!state.architect && builders.length === 0 && shells.length === 0 && files.length === 0 && (
              <p style={{ color: 'var(--text-muted)', fontStyle: 'italic', fontSize: 12, padding: '4px 8px' }}>No tabs open</p>
            )}
          </div>
        </Section>

        <Section title="Files" className="section-files">
          <FileTree onRefresh={onRefresh} />
        </Section>
      </div>

      {/* Projects section — full width below */}
      <Section title="Projects" className="section-projects">
        {projectsError ? (
          <div className="projects-error">
            <span>{projectsError}</span>
            <button onClick={() => window.location.reload()}>Retry</button>
          </div>
        ) : projects.length === 0 ? (
          <div className="projects-welcome">
            <p>No projects yet. Ask the Architect to create your first project.</p>
          </div>
        ) : (
          <ProjectsView projects={projects} />
        )}
      </Section>
    </div>
  );
}
