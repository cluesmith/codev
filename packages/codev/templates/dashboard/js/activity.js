// Activity Summary Functions (Spec 0059)

// Show activity summary - creates tab if needed
async function showActivitySummary() {
  let activityTab = tabs.find(t => t.type === 'activity');

  if (!activityTab) {
    activityTab = {
      id: 'activity-today',
      type: 'activity',
      name: 'Today'
    };
    tabs.push(activityTab);
  }

  activeTabId = activityTab.id;
  currentTabType = null;
  renderTabs();
  renderTabContent();
}

// Render the activity tab content
async function renderActivityTab() {
  const content = document.getElementById('tab-content');

  content.innerHTML = `
    <div class="activity-tab-container">
      <div class="activity-loading">
        <span class="activity-spinner"></span>
        Loading activity...
      </div>
    </div>
  `;

  try {
    const response = await fetch('/api/activity-summary');
    if (!response.ok) {
      throw new Error(await response.text());
    }
    activityData = await response.json();
    renderActivityTabContent(activityData);
  } catch (err) {
    content.innerHTML = `
      <div class="activity-tab-container">
        <div class="activity-error">
          Failed to load activity: ${escapeHtml(err.message)}
        </div>
      </div>
    `;
  }
}

// Render activity tab content
// Uses shared renderActivityContentHtml from utils.js (Maintenance Run 0004)
function renderActivityTabContent(data) {
  const content = document.getElementById('tab-content');
  content.innerHTML = renderActivityContentHtml(data, { isTab: true });
}

// Render activity summary content (for modal)
// Uses shared renderActivityContentHtml from utils.js (Maintenance Run 0004)
function renderActivitySummary(data) {
  const content = document.getElementById('activity-content');
  content.innerHTML = renderActivityContentHtml(data, { isTab: false });
}

// Close activity modal
function closeActivityModal() {
  document.getElementById('activity-modal').classList.add('hidden');
}

// Copy activity summary to clipboard (shared by tab and modal)
function copyActivityToClipboard() {
  copyActivitySummary();
}

function copyActivitySummary() {
  if (!activityData) return;

  const hours = Math.floor(activityData.timeTracking.activeMinutes / 60);
  const mins = activityData.timeTracking.activeMinutes % 60;
  const uniqueBranches = new Set(activityData.commits.map(c => c.branch)).size;
  const mergedPrs = activityData.prs.filter(p => p.state === 'MERGED').length;

  let markdown = `## Today's Summary\n\n`;

  if (activityData.aiSummary) {
    markdown += `${activityData.aiSummary}\n\n`;
  }

  markdown += `### Activity\n`;
  markdown += `- ${activityData.commits.length} commits across ${uniqueBranches} branches\n`;
  markdown += `- ${activityData.files.length} files modified\n`;
  markdown += `- ${activityData.prs.length} PRs${mergedPrs > 0 ? ` (${mergedPrs} merged)` : ''}\n\n`;

  if (activityData.projectChanges && activityData.projectChanges.length > 0) {
    markdown += `### Projects Touched\n`;
    activityData.projectChanges.forEach(p => {
      markdown += `- ${p.id}: ${p.title} (${p.oldStatus} → ${p.newStatus})\n`;
    });
    markdown += '\n';
  }

  markdown += `### Time\n`;
  markdown += `Active time: ~${hours}h ${mins}m\n`;

  navigator.clipboard.writeText(markdown).then(() => {
    showToast('Copied to clipboard', 'success');
  }).catch(() => {
    showToast('Failed to copy', 'error');
  });
}
