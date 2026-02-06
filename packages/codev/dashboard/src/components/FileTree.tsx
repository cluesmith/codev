import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { fetchFiles, createFileTab, fetchGitStatus, fetchRecentFiles } from '../lib/api.js';
import type { FileEntry, GitStatus, RecentFile } from '../lib/api.js';

interface FileTreeProps {
  onRefresh: () => void;
}

interface FileNodeProps {
  entry: FileEntry;
  expanded: Set<string>;
  gitStatus: GitStatus;
  onToggle: (path: string) => void;
  onOpen: (path: string) => void;
  depth?: number;
}

/**
 * Get git status indicator for a file path
 */
function getGitIndicator(filePath: string, gitStatus: GitStatus): { indicator: string; className: string } | null {
  // Check if path matches any git status (paths are relative)
  const relativePath = filePath.replace(/^\//, '');

  if (gitStatus.staged.some(p => relativePath.endsWith(p) || p.endsWith(relativePath))) {
    return { indicator: 'A', className: 'git-staged' };
  }
  if (gitStatus.modified.some(p => relativePath.endsWith(p) || p.endsWith(relativePath))) {
    return { indicator: 'M', className: 'git-modified' };
  }
  if (gitStatus.untracked.some(p => relativePath.endsWith(p) || p.endsWith(relativePath))) {
    return { indicator: '?', className: 'git-untracked' };
  }
  return null;
}

function FileNode({
  entry,
  expanded,
  gitStatus,
  onToggle,
  onOpen,
  depth = 0,
}: FileNodeProps) {
  const isDir = entry.type === 'directory';
  const isOpen = expanded.has(entry.path);
  const gitIndicator = !isDir ? getGitIndicator(entry.path, gitStatus) : null;

  return (
    <>
      <div
        className={`file-node ${isDir ? 'directory' : 'file'}`}
        style={{ paddingLeft: `${depth * 16 + 8}px` }}
        onClick={() => isDir ? onToggle(entry.path) : onOpen(entry.path)}
        role="treeitem"
        aria-expanded={isDir ? isOpen : undefined}
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            isDir ? onToggle(entry.path) : onOpen(entry.path);
          }
        }}
      >
        <span className="file-icon">{isDir ? (isOpen ? '📂' : '📁') : '📄'}</span>
        <span className="file-name">{entry.name}</span>
        {gitIndicator && (
          <span className={`git-indicator ${gitIndicator.className}`}>
            {gitIndicator.indicator}
          </span>
        )}
      </div>
      {isDir && isOpen && entry.children?.map(child => (
        <FileNode
          key={child.path}
          entry={child}
          expanded={expanded}
          gitStatus={gitStatus}
          onToggle={onToggle}
          onOpen={onOpen}
          depth={depth + 1}
        />
      ))}
    </>
  );
}

/**
 * Flatten all file entries for search
 */
function flattenEntries(entries: FileEntry[], result: FileEntry[] = []): FileEntry[] {
  for (const entry of entries) {
    if (entry.type === 'file') {
      result.push(entry);
    }
    if (entry.children) {
      flattenEntries(entry.children, result);
    }
  }
  return result;
}

export function FileTree({ onRefresh }: FileTreeProps) {
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [gitStatus, setGitStatus] = useState<GitStatus>({ modified: [], staged: [], untracked: [] });
  const [recentFiles, setRecentFiles] = useState<RecentFile[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [showSuggestions, setShowSuggestions] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);

  const loadFiles = useCallback(async () => {
    try {
      const data = await fetchFiles();
      setFiles(data);
      setError(null);
      setLoaded(true);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  const loadGitStatus = useCallback(async () => {
    try {
      const status = await fetchGitStatus();
      setGitStatus(status);
    } catch (e) {
      console.error('Failed to load git status:', e);
    }
  }, []);

  const loadRecentFiles = useCallback(async () => {
    try {
      const recent = await fetchRecentFiles();
      setRecentFiles(recent);
    } catch (e) {
      console.error('Failed to load recent files:', e);
    }
  }, []);

  useEffect(() => {
    if (!loaded) {
      loadFiles();
      loadGitStatus();
      loadRecentFiles();
    }
  }, [loaded, loadFiles, loadGitStatus, loadRecentFiles]);

  // Refresh git status periodically
  useEffect(() => {
    const interval = setInterval(() => {
      loadGitStatus();
    }, 30000); // Every 30 seconds
    return () => clearInterval(interval);
  }, [loadGitStatus]);

  const toggleDir = (path: string) => {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const openFile = async (filePath: string) => {
    try {
      await createFileTab(filePath);
      onRefresh();
      loadRecentFiles(); // Refresh recent files after opening
    } catch (e) {
      console.error('Failed to open file:', e);
    }
  };

  // Flatten files for search autocomplete
  const allFiles = useMemo(() => flattenEntries(files), [files]);

  // Filter files based on search query
  const searchResults = useMemo(() => {
    if (!searchQuery.trim()) return [];
    const query = searchQuery.toLowerCase();
    return allFiles
      .filter(f => f.name.toLowerCase().includes(query) || f.path.toLowerCase().includes(query))
      .slice(0, 10); // Limit to 10 results
  }, [allFiles, searchQuery]);

  const handleSearchChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setSearchQuery(e.target.value);
    setShowSuggestions(true);
  };

  const handleSearchKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') {
      setShowSuggestions(false);
      setSearchQuery('');
    } else if (e.key === 'Enter' && searchResults.length > 0) {
      openFile(searchResults[0].path);
      setSearchQuery('');
      setShowSuggestions(false);
    }
  };

  const handleSuggestionClick = (filePath: string) => {
    openFile(filePath);
    setSearchQuery('');
    setShowSuggestions(false);
  };

  if (error) return <div className="file-tree-error">Error: {error}</div>;
  if (!loaded) return <div className="file-tree-loading">Loading files...</div>;

  return (
    <div className="file-tree-container">
      {/* Search bar with autocomplete */}
      <div className="file-search">
        <input
          ref={searchInputRef}
          type="text"
          className="file-search-input"
          placeholder="Search files..."
          value={searchQuery}
          onChange={handleSearchChange}
          onKeyDown={handleSearchKeyDown}
          onFocus={() => setShowSuggestions(true)}
          onBlur={() => setTimeout(() => setShowSuggestions(false), 200)}
        />
        {showSuggestions && searchResults.length > 0 && (
          <div className="file-search-suggestions">
            {searchResults.map(file => (
              <div
                key={file.path}
                className="file-search-suggestion"
                onMouseDown={() => handleSuggestionClick(file.path)}
              >
                <span className="suggestion-name">{file.name}</span>
                <span className="suggestion-path">{file.path}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Recent files section */}
      {recentFiles.length > 0 && (
        <div className="file-tree-section">
          <div className="file-tree-section-header">Recent</div>
          {recentFiles.map(recent => (
            <div
              key={recent.id}
              className="file-node file recent-file"
              style={{ paddingLeft: '8px' }}
              onClick={() => openFile(recent.path)}
              role="treeitem"
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  openFile(recent.path);
                }
              }}
            >
              <span className="file-icon">🕐</span>
              <span className="file-name">{recent.name}</span>
              <span className="file-path-hint">{recent.relativePath}</span>
            </div>
          ))}
        </div>
      )}

      {/* File tree */}
      <div className="file-tree-section">
        <div className="file-tree-section-header">Files</div>
        <div className="file-tree" role="tree" aria-label="Project files">
          {files.map(entry => (
            <FileNode
              key={entry.path}
              entry={entry}
              expanded={expanded}
              gitStatus={gitStatus}
              onToggle={toggleDir}
              onOpen={openFile}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
