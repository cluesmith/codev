import { getApiBase } from '../lib/constants.js';

interface FileViewerProps {
  tabId: string;
  initialLine?: number;
}

/**
 * FileViewer - Renders the rich annotator template in an iframe.
 * The annotator (open.html / 3d-viewer.html) provides Prism.js syntax highlighting,
 * markdown preview, image zoom, video player, STL/3MF 3D viewing, annotations,
 * search (Cmd+F), auto-reload, and inline editing with save.
 */
export function FileViewer({ tabId, initialLine }: FileViewerProps) {
  const base = getApiBase();
  let annotateUrl = `${base}api/annotate/${tabId}/`;
  if (initialLine) {
    annotateUrl += `?line=${initialLine}`;
  }

  return (
    <div className="file-viewer" style={{ width: '100%', height: '100%' }}>
      <iframe
        src={annotateUrl}
        style={{ width: '100%', height: '100%', border: 'none' }}
        title="File Annotator"
      />
    </div>
  );
}
