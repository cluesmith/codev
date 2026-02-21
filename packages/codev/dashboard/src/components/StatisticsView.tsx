import { useState } from 'react';
import { useStatistics } from '../hooks/useStatistics.js';
import type { StatisticsResponse } from '../lib/api.js';

interface StatisticsViewProps {
  isActive: boolean;
}

type RangeLabel = '7d' | '30d' | 'all';

function fmt(value: number | null, decimals = 1, suffix = ''): string {
  if (value === null) return '\u2014';
  return `${Number(value.toFixed(decimals))}${suffix}`;
}

function fmtCost(value: number | null): string {
  if (value === null) return '\u2014';
  return `$${value.toFixed(2)}`;
}

function fmtPct(value: number | null): string {
  if (value === null) return '\u2014';
  return `${value.toFixed(1)}%`;
}

function Section({ title, error, defaultOpen = true, children }: {
  title: string;
  error?: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <section className="stats-section">
      <h3
        className="stats-section-title"
        onClick={() => setOpen(!open)}
        style={{ cursor: 'pointer', userSelect: 'none' }}
      >
        <span className="stats-collapse-icon">{open ? '\u25BE' : '\u25B8'}</span>
        {title}
      </h3>
      {error && <div className="stats-error">{error}</div>}
      {open && children}
    </section>
  );
}

function MetricGrid({ children }: { children: React.ReactNode }) {
  return <div className="stats-metric-grid">{children}</div>;
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="stats-metric">
      <span className="stats-metric-value">{value}</span>
      <span className="stats-metric-label">{label}</span>
    </div>
  );
}

function GitHubSection({ github, errors }: { github: StatisticsResponse['github']; errors?: StatisticsResponse['errors'] }) {
  return (
    <Section title="GitHub" error={errors?.github}>
      <MetricGrid>
        <Metric label="PRs Merged" value={String(github.prsMerged)} />
        <Metric label="Avg Time to Merge" value={fmt(github.avgTimeToMergeHours, 1, 'h')} />
        <Metric label="Issues Closed" value={String(github.issuesClosed)} />
        <Metric label="Avg Time to Close Bugs" value={fmt(github.avgTimeToCloseBugsHours, 1, 'h')} />
        <Metric label="Bug Backlog" value={String(github.bugBacklog)} />
        <Metric label="Non-Bug Backlog" value={String(github.nonBugBacklog)} />
      </MetricGrid>
    </Section>
  );
}

function BuildersSection({ builders }: { builders: StatisticsResponse['builders'] }) {
  return (
    <Section title="Builders">
      <MetricGrid>
        <Metric label="Projects Completed" value={String(builders.projectsCompleted)} />
        <Metric label="Throughput / Week" value={fmt(builders.throughputPerWeek)} />
        <Metric label="Active Builders" value={String(builders.activeBuilders)} />
      </MetricGrid>
    </Section>
  );
}

function ConsultationSection({ consultation, errors }: { consultation: StatisticsResponse['consultation']; errors?: StatisticsResponse['errors'] }) {
  const reviewTypes = Object.entries(consultation.byReviewType);
  const protocols = Object.entries(consultation.byProtocol);
  const projects = consultation.costByProject;

  return (
    <Section title="Consultation" error={errors?.consultation}>
      <MetricGrid>
        <Metric label="Total Consultations" value={String(consultation.totalCount)} />
        <Metric label="Total Cost" value={fmtCost(consultation.totalCostUsd)} />
        <Metric label="Avg Latency" value={fmt(consultation.avgLatencySeconds, 1, 's')} />
        <Metric label="Success Rate" value={fmtPct(consultation.successRate)} />
      </MetricGrid>

      {consultation.byModel.length > 0 && (
        <div className="stats-sub-section">
          <h4 className="stats-sub-title">Per Model</h4>
          <table className="stats-table">
            <thead>
              <tr>
                <th>Model</th>
                <th>Count</th>
                <th>Cost</th>
                <th>Latency</th>
                <th>Success</th>
              </tr>
            </thead>
            <tbody>
              {consultation.byModel.map(m => (
                <tr key={m.model}>
                  <td>{m.model}</td>
                  <td>{m.count}</td>
                  <td>{fmtCost(m.totalCost)}</td>
                  <td>{fmt(m.avgLatency, 1, 's')}</td>
                  <td>{fmtPct(m.successRate)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {reviewTypes.length > 0 && (
        <div className="stats-sub-section">
          <h4 className="stats-sub-title">By Review Type</h4>
          <ul className="stats-list">
            {reviewTypes.map(([type, count]) => (
              <li key={type}><span className="stats-list-label">{type}</span> <span className="stats-list-value">{count}</span></li>
            ))}
          </ul>
        </div>
      )}

      {protocols.length > 0 && (
        <div className="stats-sub-section">
          <h4 className="stats-sub-title">By Protocol</h4>
          <ul className="stats-list">
            {protocols.map(([proto, count]) => (
              <li key={proto}><span className="stats-list-label">{proto}</span> <span className="stats-list-value">{count}</span></li>
            ))}
          </ul>
        </div>
      )}

      {projects.length > 0 && (
        <div className="stats-sub-section">
          <h4 className="stats-sub-title">Cost per Project</h4>
          <ul className="stats-list">
            {projects.map(p => (
              <li key={p.projectId}><span className="stats-list-label">#{p.projectId}</span> <span className="stats-list-value">{fmtCost(p.totalCost)}</span></li>
            ))}
          </ul>
        </div>
      )}
    </Section>
  );
}

export function StatisticsView({ isActive }: StatisticsViewProps) {
  const { data, error, loading, range, setRange, refresh } = useStatistics(isActive);
  const ranges: RangeLabel[] = ['7d', '30d', 'all'];

  return (
    <div className="stats-view">
      <div className="stats-content">
        <div className="stats-header">
          <h2 className="stats-title">Statistics</h2>
          <div className="stats-actions">
            <div className="stats-range-selector">
              {ranges.map(r => (
                <button
                  key={r}
                  className={`stats-range-btn ${range === r ? 'active' : ''}`}
                  onClick={() => setRange(r)}
                >
                  {r === 'all' ? 'All' : r}
                </button>
              ))}
            </div>
            <button className="work-btn work-btn-secondary" onClick={refresh} disabled={loading}>
              {loading ? 'Loading...' : 'Refresh'}
            </button>
          </div>
        </div>

        {error && !data && (
          <div className="stats-error">{error}</div>
        )}

        {loading && !data && (
          <div className="stats-loading">Loading statistics...</div>
        )}

        {data && (
          <>
            <GitHubSection github={data.github} errors={data.errors} />
            <BuildersSection builders={data.builders} />
            <ConsultationSection consultation={data.consultation} errors={data.errors} />
          </>
        )}
      </div>
    </div>
  );
}
