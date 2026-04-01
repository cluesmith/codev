import { useTeam } from '../hooks/useTeam.js';
import type { TeamApiMember, TeamApiMessage } from '../lib/api.js';

interface TeamViewProps {
  isActive: boolean;
}

function MemberCard({ member }: { member: TeamApiMember }) {
  const gh = member.github_data;
  const mergedCount = gh?.recentActivity.mergedPRs.length ?? 0;
  const closedCount = gh?.recentActivity.closedIssues.length ?? 0;

  return (
    <div className="team-member-card">
      <div className="team-member-header">
        <span className="team-member-name">{member.name}</span>
        <span className="team-member-role">{member.role}</span>
      </div>
      <a
        className="team-member-github"
        href={`https://github.com/${member.github}`}
        target="_blank"
        rel="noopener noreferrer"
      >
        @{member.github}
      </a>
      {gh && (
        <>
          <div className="team-member-section">
            <span className="team-section-label">Working on</span>
            {gh.assignedIssues.length > 0 ? (
              <div className="team-item-list">
                {gh.assignedIssues.map(issue => (
                  <a
                    key={issue.number}
                    className="team-item-link"
                    href={issue.url}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    #{issue.number} {issue.title}
                  </a>
                ))}
              </div>
            ) : (
              <span className="team-item-empty">No assigned issues</span>
            )}
          </div>
          <div className="team-member-section">
            <span className="team-section-label">Open PRs</span>
            {gh.openPRs.length > 0 ? (
              <div className="team-item-list">
                {gh.openPRs.map(pr => (
                  <a
                    key={pr.number}
                    className="team-item-link"
                    href={pr.url}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    #{pr.number} {pr.title}
                  </a>
                ))}
              </div>
            ) : (
              <span className="team-item-empty">No open PRs</span>
            )}
          </div>
        </>
      )}
      {(mergedCount > 0 || closedCount > 0) && (
        <div className="team-member-activity">
          {mergedCount > 0 && <span>{mergedCount} merged</span>}
          {closedCount > 0 && <span>{closedCount} closed</span>}
          <span className="team-activity-label">last 7d</span>
        </div>
      )}
    </div>
  );
}

function MessageItem({ message }: { message: TeamApiMessage }) {
  return (
    <div className="team-message">
      <div className="team-message-header">
        <span className="team-message-author">{message.author}</span>
        <span className="team-message-time">{message.timestamp}</span>
      </div>
      <div className="team-message-body">{message.body}</div>
    </div>
  );
}

export function TeamView({ isActive }: TeamViewProps) {
  const { data, error, loading, refresh } = useTeam(isActive);

  if (loading && !data) {
    return <div className="team-view"><div className="team-loading">Loading team data...</div></div>;
  }

  if (error && !data) {
    return (
      <div className="team-view">
        <div className="team-error">{error}</div>
      </div>
    );
  }

  if (!data || !data.enabled) {
    return null;
  }

  const members = data.members ?? [];
  const messages = data.messages ?? [];
  // Display messages in reverse chronological order
  const reversedMessages = [...messages].reverse();

  return (
    <div className="team-view">
      <div className="team-content">
        <div className="team-header">
          <h2 className="team-title">Team</h2>
          <button className="team-refresh-btn" onClick={refresh} disabled={loading}>
            {loading ? 'Refreshing...' : 'Refresh'}
          </button>
        </div>

        {data.githubError && (
          <div className="team-error">{data.githubError}</div>
        )}

        <div className="team-section">
          <h3 className="team-section-title">Members ({members.length})</h3>
          <div className="team-member-grid">
            {members.map(m => <MemberCard key={m.github} member={m} />)}
          </div>
        </div>

        <div className="team-section">
          <h3 className="team-section-title">Messages</h3>
          {reversedMessages.length === 0 ? (
            <div className="team-no-messages">No messages yet</div>
          ) : (
            <div className="team-messages">
              {reversedMessages.map((msg, i) => <MessageItem key={i} message={msg} />)}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
