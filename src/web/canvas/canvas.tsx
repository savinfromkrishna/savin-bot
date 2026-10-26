import "@xyflow/react/dist/style.css";
import type { Node } from "@xyflow/react";
import { Background, BackgroundVariant, Controls, ReactFlow, useNodesState } from "@xyflow/react";
import { useEffect, useMemo } from "react";
import type { AppState, Run } from "../../shared/contracts.ts";
import type { GraphNode } from "../../shared/graph.ts";
import { buildGraph } from "../../shared/graph.ts";
import { DEMO } from "../../shared/providers.ts";
import type { FlowEdge } from "./nodes.tsx";
import { edgeTypes, nodeTypes } from "./nodes.tsx";

/** Adds what the node views need to draw a bot; positions stay wherever the user dragged them. */
function toFlowNodes(state: AppState, nodes: GraphNode[]): Node[] {
  const active = state.models.active;
  const defaultModel = active && active.providerId !== DEMO.providerId ? active.model : "demo";
  return nodes.map((node) => {
    if (node.type !== "bot") return node;
    const bot = state.bots.find((candidate) => candidate.id === node.data.botId);
    return { ...node, data: { ...node.data, bot, model: bot?.model?.model ?? defaultModel } };
  });
}

export function Canvas({
  state,
  runs,
  onOpen,
}: {
  state: AppState;
  runs: Run[];
  onOpen: (nodeId: string | null) => void;
}) {
  const graph = useMemo(() => buildGraph(state, runs), [state, runs]);
  const [nodes, setNodes, onNodesChange] = useNodesState(toFlowNodes(state, graph.nodes));

  useEffect(() => {
    setNodes((current) => {
      const previous = new Map(current.map((node) => [node.id, node]));
      return toFlowNodes(state, graph.nodes).map((node) => {
        const old = previous.get(node.id);
        return old ? { ...old, data: node.data } : node;
      });
    });
  }, [state, graph, setNodes]);

  const colors = useMemo(() => new Map(state.bots.map((bot) => [`bot:${bot.id}`, bot.avatar.color])), [state.bots]);
  const edges = useMemo<FlowEdge[]>(
    () =>
      graph.edges
        // The shared model reaches every bot; those lines only show while a bot is thinking.
        .filter((edge) => edge.kind !== "model" || edge.active)
        .map((edge) => {
          const owner =
            edge.kind === "delegation" || edge.kind === "tool" || edge.kind === "app" ? edge.source : edge.target;
          return {
            id: edge.id,
            source: edge.source,
            target: edge.target,
            targetHandle: edge.targetHandle,
            type: "flow",
            data: { ...edge, color: colors.get(owner) ?? "var(--foreground)" },
            zIndex: edge.active || edge.waiting ? 1 : 0,
            selectable: false,
          };
        }),
    [graph, colors],
  );

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      edgeTypes={edgeTypes}
      onNodesChange={onNodesChange}
      onNodeClick={(_, node) => onOpen(node.id)}
      nodesConnectable={false}
      deleteKeyCode={null}
      colorMode="system"
      fitView
      // A phone cannot fit the whole map at a readable size, so it opens on the middle of it instead.
      fitViewOptions={{ padding: 0.1, minZoom: 0.55 }}
      minZoom={0.25}
      maxZoom={1.75}
    >
      <Background variant={BackgroundVariant.Dots} gap={20} size={1.3} />
      <Controls showInteractive={false} position="top-left" />
    </ReactFlow>
  );
}
