export function StructureDiagramLayer({
  layout,
  structureEdgePaths,
  structureFocus,
  hasActiveStructureEdge,
  onEdgeEnter,
  onEdgeLeave,
  onEdgeClick,
}) {
  return (
    <>
      {(layout.bands ?? []).map((band) => (
        <g key={`level-${band.depth}`} className={`fd-level-band ${band.kind ? `fd-level-band--${band.kind}` : ''}`}>
          <rect x="2" y={band.y} width={Math.max(0, layout.width - 4)} height={band.height} rx="12" />
          {band.label ? <text x="12" y={band.y + 17}>{band.label}</text> : null}
          {band.secondaryLabel ? (
            <text className="fd-level-band-secondary" x="12" y={band.y + 32}>{band.secondaryLabel}</text>
          ) : null}
        </g>
      ))}
      {(layout.groups ?? []).map((group) => {
        const edgeId = `structure:${group.parentId}:${group.id}`;
        const isActive = structureFocus?.pathNodeIds.has(group.id);
        const isSibling = structureFocus?.siblingNodeIds.has(group.id);
        const isDimmed = hasActiveStructureEdge && !isActive && !isSibling;
        const headerWidth = 82;
        const headerX = group.x + (group.width / 2) - (headerWidth / 2);
        return (
          <g
            key={group.id ?? `${group.parentId}-${group.kind}-${group.x}-${group.y}`}
            className={`fd-complete-sibling-group-wrap ${group.isAggregate ? 'is-interactive' : ''} ${isActive ? 'is-structure-active' : ''} ${isSibling ? 'is-structure-sibling' : ''} ${isDimmed ? 'is-structure-dimmed' : ''}`}
            onPointerEnter={group.isAggregate ? () => onEdgeEnter(edgeId) : undefined}
            onPointerLeave={group.isAggregate ? onEdgeLeave : undefined}
            onPointerDown={group.isAggregate ? (event) => event.stopPropagation() : undefined}
            onClick={group.isAggregate ? (event) => onEdgeClick(event, edgeId) : undefined}
          >
            <rect
              className={`fd-complete-sibling-group fd-complete-sibling-group--${group.kind} fd-complete-sibling-group--tone-${group.tone ?? 0} ${group.isAggregate ? 'is-aggregate' : ''}`}
              x={group.x}
              y={group.y}
              width={group.width}
              height={group.height}
              rx="12"
            />
            {group.isAggregate ? (
              <>
                <rect className="fd-complete-sibling-group-header" x={headerX} y={group.y - 9} width={headerWidth} height="18" rx="9" />
                <circle className="fd-complete-sibling-group-port" cx={group.x + (group.width / 2)} cy={group.y - 9} r="4" />
                <text className="fd-complete-sibling-group-label" x={group.x + (group.width / 2)} y={group.y + 3} textAnchor="middle">
                  {`${group.storyCount} histoires`}
                </text>
              </>
            ) : null}
          </g>
        );
      })}
      {structureEdgePaths.map((edge) => {
        const isActive = structureFocus?.activeEdgeId === edge.id;
        const isPath = structureFocus?.pathEdgeIds.has(edge.id);
        const isSibling = structureFocus?.siblingEdgeIds.has(edge.id);
        const isDimmed = hasActiveStructureEdge && !isPath && !isSibling;
        return (
          <g
            key={edge.id}
            className={`fd-complete-structure-edge ${isActive ? 'is-active' : ''} ${isPath ? 'is-path' : ''} ${isSibling ? 'is-sibling' : ''} ${isDimmed ? 'is-dimmed' : ''}`}
          >
            <path
              className="fd-complete-line-hitbox fd-complete-structure-hitbox"
              data-structure-edge-id={edge.id}
              d={edge.d}
              onPointerEnter={() => onEdgeEnter(edge.id)}
              onPointerLeave={onEdgeLeave}
              onPointerDown={(event) => event.stopPropagation()}
              onClick={(event) => onEdgeClick(event, edge.id)}
            />
            <path
              className={`fd-complete-line fd-complete-line--${edge.kind || 'structural'}`}
              d={edge.d}
            />
          </g>
        );
      })}
    </>
  );
}
