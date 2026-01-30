import { useState, useEffect, useCallback } from 'react';
import { fetchFiles, createFileTab } from '../lib/api.js';
import type { FileEntry } from '../lib/api.js';

interface FileTreeProps {
  onRefresh: () => void;
}

function FileNode({
  entry,
  expanded,
  onToggle,
  onOpen,
  depth = 0,
}: {
  entry: FileEntry;
  expanded: Set<string>;
  onToggle: (path: string) => void;
  onOpen: (path: string) => void;
  depth?: number;
}) {
  const isDir = entry.type === 'directory';
  const isOpen = expanded.has(entry.path);

  return (
    <>
      <div
        className={`file-node ${isDir ? 'directory' : 'file'}`}
        style={{ paddingLeft: `${depth * 16 + 8}px` }}
        onClick={() => isDir ? onToggle(entry.path) : onOpen(entry.path)}
        role={isDir ? 'treeitem' : 'treeitem'}
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
      </div>
      {isDir && isOpen && entry.children?.map(child => (
        <FileNode
          key={child.path}
          entry={child}
          expanded={expanded}
          onToggle={onToggle}
          onOpen={onOpen}
          depth={depth + 1}
        />
      ))}
    </>
  );
}

export function FileTree({ onRefresh }: FileTreeProps) {
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

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

  useEffect(() => {
    if (!loaded) loadFiles();
  }, [loaded, loadFiles]);

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
    } catch (e) {
      console.error('Failed to open file:', e);
    }
  };

  if (error) return <div className="file-tree-error">Error: {error}</div>;
  if (!loaded) return <div className="file-tree-loading">Loading files...</div>;

  return (
    <div className="file-tree" role="tree" aria-label="Project files">
      {files.map(entry => (
        <FileNode
          key={entry.path}
          entry={entry}
          expanded={expanded}
          onToggle={toggleDir}
          onOpen={openFile}
        />
      ))}
    </div>
  );
}
