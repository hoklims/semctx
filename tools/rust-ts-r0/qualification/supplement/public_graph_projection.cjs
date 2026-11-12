// Pure projector; never invokes a producer. Frozen materialize.ts canonicalGraph
// uses JS localeCompare, so the final graph ordering remains in that same runtime.
function canonicalGraph(graph) {
  const nodeKey = n => JSON.stringify({kind:n.kind,name:n.name,filePath:n.filePath,scope:n.scope});
  const byId = new Map(graph.nodes.map(n => [n.id,nodeKey(n)]));
  if (byId.size !== graph.nodes.length) throw Error('ASSEMBLY_DUPLICATE_NODE_ID');
  const nodes = graph.nodes.map(n => ({kind:n.kind,name:n.name,...(n.filePath===undefined?{}:{filePath:n.filePath}),...(n.scope===undefined?{}:{scope:n.scope})}));
  const edges = graph.edges.map(e => {
    if (!byId.has(e.from)||!byId.has(e.to)) throw Error('ASSEMBLY_UNRESOLVED_ENDPOINT_WITHOUT_PROVENANCE');
    return {kind:e.kind,from:byId.get(e.from),to:byId.get(e.to)};
  });
  return {nodes:nodes.sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b))),edges:edges.sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)))};
}
module.exports={canonicalGraph};
