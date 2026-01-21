// Dashboard State Management

// STATE_INJECTION_POINT - server injects window.INITIAL_STATE here

// Global state
const state = window.INITIAL_STATE || {
  architect: null,
  builders: [],
  utils: [],
  annotations: []
};

// Tab state
let tabs = [];
let activeTabId = null;
let pendingCloseTabId = null;
let contextMenuTabId = null;

// Track known tab IDs to detect new tabs
let knownTabIds = new Set();

// Projects tab state
let projectsData = [];
let projectlistHash = null;
let expandedProjectId = null;
let projectlistError = null;
let projectlistDebounce = null;

// Files tab state (Spec 0055)
let filesTreeData = [];
let filesTreeExpanded = new Set();  // Set of expanded folder paths
let filesTreeError = null;
let filesTreeLoaded = false;

// File search state (Spec 0058)
let filesTreeFlat = [];  // Flattened array of {name, path} objects for searching
let filesSearchQuery = '';
let filesSearchResults = [];
let filesSearchIndex = 0;
let filesSearchDebounceTimer = null;

// Cmd+P palette state (Spec 0058)
let paletteOpen = false;
let paletteQuery = '';
let paletteResults = [];
let paletteIndex = 0;
let paletteDebounceTimer = null;

// Collapsible section state (persisted to localStorage)
const SECTION_STATE_KEY = 'codev-dashboard-sections';
let sectionState = loadSectionState();

function loadSectionState() {
  try {
    const saved = localStorage.getItem(SECTION_STATE_KEY);
    if (saved) return JSON.parse(saved);
  } catch (e) { /* ignore */ }
  return { tabs: true, files: true, projects: true };
}

function saveSectionState() {
  try {
    localStorage.setItem(SECTION_STATE_KEY, JSON.stringify(sectionState));
  } catch (e) { /* ignore */ }
}

function toggleSection(section) {
  sectionState[section] = !sectionState[section];
  saveSectionState();
  renderDashboardTabContent();
}

// Track current architect port to avoid re-rendering iframe unnecessarily
let currentArchitectPort = null;

// Track current tab content to avoid re-rendering iframe unnecessarily
let currentTabPort = null;
let currentTabType = null;

// Polling state
let pollInterval = null;
let starterModePollingInterval = null;

// Hot reload state (Spec 0060)
// Hot reload only activates in dev mode (localhost or ?dev=1 query param)
let hotReloadEnabled = true;
let hotReloadInterval = null;
let hotReloadMtimes = {};  // Track file modification times
