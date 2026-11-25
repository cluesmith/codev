/** A Backlog or Recently Closed item's *spec* / *plan* / *review* link: opens that file through the host. */
export function ArtifactLink({ label, filePath, onOpen }: { label: string; filePath: string; onOpen: (path: string) => void }) {
  return (
    <button
      className="backlog-artifact-link"
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onOpen(filePath);
      }}
    >
      {label}
    </button>
  );
}
