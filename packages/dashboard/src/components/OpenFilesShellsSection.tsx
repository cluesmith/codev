import type { UtilTerminal, Annotation } from '../lib/api.js';
import { formatDuration, shortPath } from '../lib/open-files-shells-utils.js';

const IDLE_THRESHOLD_MS = 30_000;

interface OpenFilesShellsSectionProps {
  utils: UtilTerminal[];
  annotations: Annotation[];
  onSelectTab: (id: string) => void;
}

export function OpenFilesShellsSection({ utils, annotations, onSelectTab }: OpenFilesShellsSectionProps) {
  if (utils.length === 0 && annotations.length === 0) return null;

  const now = Date.now();

  return (
    <section className="work-section">
      <h3 className="work-section-title">Open Files &amp; Shells</h3>
      <div className="ofs-rows">
        {utils.length > 0 && (
          <>
            <div className="ofs-subgroup-label">Shells</div>
            {utils.map(util => {
              const isIdle = !util.lastDataAt || (now - util.lastDataAt > IDLE_THRESHOLD_MS);
              const idleDuration = util.lastDataAt ? formatDuration(now - util.lastDataAt) : '';

              return (
                <div
                  key={util.id}
                  className="ofs-row"
                  onClick={() => onSelectTab(util.id)}
                >
                  <span className={`ofs-dot ${isIdle ? 'ofs-dot--idle' : 'ofs-dot--running'}`} />
                  <span className="ofs-name">{util.name || `Shell ${util.id}`}</span>
                  {isIdle && idleDuration && (
                    <span className="ofs-idle">{idleDuration}</span>
                  )}
                </div>
              );
            })}
          </>
        )}
        {annotations.length > 0 && (
          <>
            <div className="ofs-subgroup-label">Files</div>
            {annotations.map(ann => {
              const basename = ann.file.split('/').pop() ?? ann.file;
              return (
                <div
                  key={ann.id}
                  className="ofs-row"
                  onClick={() => onSelectTab(ann.id)}
                  title={ann.file}
                >
                  <span className="ofs-file-icon">&#128196;</span>
                  <span className="ofs-name">{basename}</span>
                  <span className="ofs-path">{shortPath(ann.file)}</span>
                </div>
              );
            })}
          </>
        )}
      </div>
    </section>
  );
}
