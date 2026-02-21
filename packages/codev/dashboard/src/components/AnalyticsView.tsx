import { useState } from 'react';
import { useAnalytics } from '../hooks/useAnalytics.js';
import type { AnalyticsResponse } from '../lib/api.js';
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell,
  PieChart, Pie,
} from 'recharts';

interface AnalyticsViewProps {
  isActive: boolean;
}

type RangeLabel = '24h' | '7d' | '30d' | 'all';

const CHART_COLORS = [
  '#6366f1', '#8b5cf6', '#a78bfa', '#c4b5fd', '#ddd6fe',
  '#818cf8', '#4f46e5', '#7c3aed', '#5b21b6', '#3730a3',
];

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
    <section className="analytics-section">
      <h3
        className="analytics-section-title"
        onClick={() => setOpen(!open)}
        style={{ cursor: 'pointer', userSelect: 'none' }}
      >
        <span className="analytics-collapse-icon">{open ? '\u25BE' : '\u25B8'}</span>
        {title}
      </h3>
      {error && <div className="analytics-error">{error}</div>}
      {open && children}
    </section>
  );
}

function MetricGrid({ children }: { children: React.ReactNode }) {
  return <div className="analytics-metric-grid">{children}</div>;
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="analytics-metric">
      <span className="analytics-metric-value">{value}</span>
      <span className="analytics-metric-label">{label}</span>
    </div>
  );
}

function MiniBarChart({ data, dataKey, nameKey, color, formatter }: {
  data: Array<Record<string, unknown>>;
  dataKey: string;
  nameKey: string;
  color?: string;
  formatter?: (v: number) => string;
}) {
  if (data.length === 0) return null;
  const height = Math.max(120, data.length * 28 + 30);
  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={data} layout="vertical" margin={{ top: 4, right: 40, bottom: 4, left: 0 }}>
        <XAxis type="number" hide />
        <YAxis type="category" dataKey={nameKey} width={80} tick={{ fontSize: 10, fill: 'var(--text-secondary)' }} />
        <Tooltip
          formatter={formatter ? (v: number | undefined) => v != null ? formatter(v) : '' : undefined}
          contentStyle={{ background: 'var(--bg-primary)', border: '1px solid var(--border-color)', fontSize: 11, borderRadius: 4 }}
          labelStyle={{ color: 'var(--text-primary)' }}
          itemStyle={{ color: 'var(--text-secondary)' }}
        />
        <Bar dataKey={dataKey} radius={[0, 3, 3, 0]}>
          {data.map((_entry, idx) => (
            <Cell key={idx} fill={color ?? CHART_COLORS[idx % CHART_COLORS.length]} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}

function MiniPieChart({ data, dataKey, nameKey }: {
  data: Array<Record<string, unknown>>;
  dataKey: string;
  nameKey: string;
}) {
  if (data.length === 0) return null;
  return (
    <ResponsiveContainer width="100%" height={160}>
      <PieChart>
        <Pie
          data={data}
          dataKey={dataKey}
          nameKey={nameKey}
          cx="50%"
          cy="50%"
          outerRadius={55}
          innerRadius={30}
          label={({ name, percent }) => `${name} ${((percent ?? 0) * 100).toFixed(0)}%`}
          labelLine={false}
          style={{ fontSize: 10 }}
        >
          {data.map((_entry, idx) => (
            <Cell key={idx} fill={CHART_COLORS[idx % CHART_COLORS.length]} />
          ))}
        </Pie>
        <Tooltip
          contentStyle={{ background: 'var(--bg-primary)', border: '1px solid var(--border-color)', fontSize: 11, borderRadius: 4 }}
          labelStyle={{ color: 'var(--text-primary)' }}
          itemStyle={{ color: 'var(--text-secondary)' }}
        />
      </PieChart>
    </ResponsiveContainer>
  );
}

function GitHubSection({ github, errors }: { github: AnalyticsResponse['github']; errors?: AnalyticsResponse['errors'] }) {
  const backlogData = [
    { name: 'Bug', value: github.bugBacklog },
    { name: 'Non-Bug', value: github.nonBugBacklog },
  ].filter(d => d.value > 0);

  return (
    <Section title="GitHub" error={errors?.github}>
      <MetricGrid>
        <Metric label="PRs Merged" value={String(github.prsMerged)} />
        <Metric label="Avg Time to Merge" value={fmt(github.avgTimeToMergeHours, 1, 'h')} />
        <Metric label="Issues Closed" value={String(github.issuesClosed)} />
        <Metric label="Avg Time to Close Bugs" value={fmt(github.avgTimeToCloseBugsHours, 1, 'h')} />
      </MetricGrid>
      {backlogData.length > 0 && (
        <div className="analytics-sub-section">
          <h4 className="analytics-sub-title">Open Issue Backlog</h4>
          <MiniBarChart data={backlogData} dataKey="value" nameKey="name" />
        </div>
      )}
    </Section>
  );
}

function BuildersSection({ builders }: { builders: AnalyticsResponse['builders'] }) {
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

function ConsultationSection({ consultation, errors }: { consultation: AnalyticsResponse['consultation']; errors?: AnalyticsResponse['errors'] }) {
  const modelData = consultation.byModel.map(m => ({
    name: m.model,
    count: m.count,
    cost: m.totalCost ?? 0,
    latency: m.avgLatency,
    success: m.successRate,
  }));

  const reviewTypeData = Object.entries(consultation.byReviewType).map(([type, count]) => ({
    name: type,
    value: count,
  }));

  const protocolData = Object.entries(consultation.byProtocol).map(([proto, count]) => ({
    name: proto,
    value: count,
  }));

  const projectData = consultation.costByProject.map(p => ({
    name: `#${p.projectId}`,
    cost: p.totalCost,
  }));

  return (
    <Section title="Consultation" error={errors?.consultation}>
      <MetricGrid>
        <Metric label="Total Consultations" value={String(consultation.totalCount)} />
        <Metric label="Total Cost" value={fmtCost(consultation.totalCostUsd)} />
        <Metric label="Avg Latency" value={fmt(consultation.avgLatencySeconds, 1, 's')} />
        <Metric label="Success Rate" value={fmtPct(consultation.successRate)} />
      </MetricGrid>

      {modelData.length > 0 && (
        <div className="analytics-sub-section">
          <h4 className="analytics-sub-title">Cost by Model</h4>
          <MiniBarChart
            data={modelData}
            dataKey="cost"
            nameKey="name"
            formatter={(v) => `$${v.toFixed(2)}`}
          />
        </div>
      )}

      {modelData.length > 0 && (
        <div className="analytics-sub-section">
          <h4 className="analytics-sub-title">Per Model</h4>
          <table className="analytics-table">
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

      {(reviewTypeData.length > 0 || protocolData.length > 0) && (
        <div className="analytics-charts-row">
          {reviewTypeData.length > 0 && (
            <div className="analytics-sub-section analytics-chart-half">
              <h4 className="analytics-sub-title">By Review Type</h4>
              <MiniPieChart data={reviewTypeData} dataKey="value" nameKey="name" />
            </div>
          )}
          {protocolData.length > 0 && (
            <div className="analytics-sub-section analytics-chart-half">
              <h4 className="analytics-sub-title">By Protocol</h4>
              <MiniPieChart data={protocolData} dataKey="value" nameKey="name" />
            </div>
          )}
        </div>
      )}

      {projectData.length > 0 && (
        <div className="analytics-sub-section">
          <h4 className="analytics-sub-title">Cost per Project</h4>
          <MiniBarChart
            data={projectData}
            dataKey="cost"
            nameKey="name"
            formatter={(v) => `$${v.toFixed(2)}`}
          />
        </div>
      )}
    </Section>
  );
}

export function AnalyticsView({ isActive }: AnalyticsViewProps) {
  const { data, error, loading, range, setRange, refresh } = useAnalytics(isActive);
  const ranges: RangeLabel[] = ['24h', '7d', '30d', 'all'];

  return (
    <div className="analytics-view">
      <div className="analytics-content">
        <div className="analytics-header">
          <h2 className="analytics-title">Analytics</h2>
          <div className="analytics-actions">
            <div className="analytics-range-selector">
              {ranges.map(r => (
                <button
                  key={r}
                  className={`analytics-range-btn ${range === r ? 'active' : ''}`}
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
          <div className="analytics-error">{error}</div>
        )}

        {loading && !data && (
          <div className="analytics-loading">Loading analytics...</div>
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
