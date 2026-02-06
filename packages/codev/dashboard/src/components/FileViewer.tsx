import { useState, useEffect, useCallback } from 'react';
import { fetchFileContent, getFileRawUrl, saveFile } from '../lib/api.js';
import type { FileContent } from '../lib/api.js';

interface FileViewerProps {
  tabId: string;
  initialLine?: number;
}

/**
 * FileViewer - Renders file content within the dashboard (Spec 0092)
 * Replaces the separate open-server.ts annotation viewer.
 */
export function FileViewer({ tabId, initialLine }: FileViewerProps) {
  const [data, setData] = useState<FileContent | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [content, setContent] = useState('');
  const [modified, setModified] = useState(false);
  const [saving, setSaving] = useState(false);

  // Load file content
  useEffect(() => {
    setLoading(true);
    setError(null);
    fetchFileContent(tabId)
      .then((d) => {
        setData(d);
        setContent(d.content || '');
        setModified(false);
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [tabId]);

  // Scroll to line after content loads
  useEffect(() => {
    if (data && initialLine && !data.isImage && !data.isVideo) {
      const lineEl = document.querySelector(`[data-line="${initialLine}"]`);
      if (lineEl) {
        lineEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
        lineEl.classList.add('highlighted-line');
      }
    }
  }, [data, initialLine]);

  // Handle save
  const handleSave = useCallback(async () => {
    if (!data || saving) return;
    setSaving(true);
    try {
      await saveFile(tabId, content);
      setModified(false);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }, [tabId, content, data, saving]);

  // Keyboard shortcut for save
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault();
        if (modified) handleSave();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [modified, handleSave]);

  // Handle content change (for editing)
  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setContent(e.target.value);
    setModified(true);
  };

  if (loading) {
    return <div className="file-viewer file-loading">Loading...</div>;
  }

  if (error) {
    return <div className="file-viewer file-error">Error: {error}</div>;
  }

  if (!data) {
    return <div className="file-viewer file-error">No file data</div>;
  }

  // Image viewer
  if (data.isImage) {
    return (
      <div className="file-viewer file-image-viewer">
        <div className="file-header">
          <span className="file-path">{data.path}</span>
        </div>
        <div className="file-image-container">
          <img
            src={getFileRawUrl(tabId)}
            alt={data.name}
            className="file-image"
          />
        </div>
      </div>
    );
  }

  // Video viewer
  if (data.isVideo) {
    return (
      <div className="file-viewer file-video-viewer">
        <div className="file-header">
          <span className="file-path">{data.path}</span>
        </div>
        <div className="file-video-container">
          <video
            src={getFileRawUrl(tabId)}
            controls
            className="file-video"
          />
        </div>
      </div>
    );
  }

  // Text file viewer with line numbers
  const lines = content.split('\n');

  return (
    <div className="file-viewer file-text-viewer">
      <div className="file-header">
        <span className="file-path">{data.path}</span>
        <span className="file-language">{data.language}</span>
        {modified && (
          <button
            className="file-save-btn"
            onClick={handleSave}
            disabled={saving}
          >
            {saving ? 'Saving...' : 'Save'}
          </button>
        )}
      </div>
      <div className="file-content">
        <div className="line-numbers">
          {lines.map((_, i) => (
            <div key={i} className="line-number" data-line={i + 1}>
              {i + 1}
            </div>
          ))}
        </div>
        <textarea
          className="file-text"
          value={content}
          onChange={handleChange}
          spellCheck={false}
          wrap="off"
        />
      </div>
    </div>
  );
}
