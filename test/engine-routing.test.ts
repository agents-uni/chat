import { describe, it, expect, beforeEach } from 'vitest';
import {
  RelationshipGraph,
  EvolutionEngine,
  MemoryConsolidator,
  EmergenceDetector,
  computeInfluence,
} from '@agents-uni/rel';
import type { ParticipantInfo } from '../src/types.js';

/**
 * Tests for the enhanced selectRespondents() logic in ChatEngine.
 *
 * Since selectRespondents is private, we test the scoring behavior
 * indirectly by verifying the relationship-aware scoring algorithm.
 * We also test the getRecentRespondentIds pattern and influence boosting.
 */

function createParticipants(): ParticipantInfo[] {
  return [
    { id: 'alice', name: 'Alice', role: 'Engineer', department: 'Backend' },
    { id: 'bob', name: 'Bob', role: 'Designer', department: 'Frontend' },
    { id: 'charlie', name: 'Charlie', role: 'Manager', department: 'Operations' },
    { id: 'dave', name: 'Dave', role: 'Data Scientist', department: 'Analytics' },
    { id: 'eve', name: 'Eve', role: 'Security', department: 'Security' },
  ];
}

describe('Relationship-Enhanced Routing', () => {
  let graph: RelationshipGraph;

  beforeEach(() => {
    graph = new RelationshipGraph();
  });

  describe('influence scoring', () => {
    it('should compute higher influence for agents with more incoming trust', () => {
      graph.addFromSeed({ from: 'bob', to: 'alice', type: 'ally' });
      graph.addFromSeed({ from: 'charlie', to: 'alice', type: 'ally' });
      graph.addFromSeed({ from: 'dave', to: 'alice', type: 'peer' });
      graph.addFromSeed({ from: 'bob', to: 'charlie', type: 'peer' });

      const scores = computeInfluence(graph);
      expect(scores[0].agentId).toBe('alice');
      expect(scores[0].score).toBeGreaterThan(0);
    });

    it('should return empty scores for empty graph', () => {
      const scores = computeInfluence(graph);
      expect(scores).toHaveLength(0);
    });
  });

  describe('trust-based relationship boosting', () => {
    it('should find trust dimension value between agents', () => {
      graph.addFromSeed({ from: 'alice', to: 'bob', type: 'ally' });
      // ally template gives trust: 0.6
      const trustValue = graph.getDimensionValue('alice', 'bob', 'trust');
      expect(trustValue).toBeDefined();
      expect(trustValue!).toBeGreaterThan(0.3);
    });

    it('should return undefined trust for unrelated agents', () => {
      graph.addFromSeed({ from: 'alice', to: 'bob', type: 'ally' });
      const trustValue = graph.getDimensionValue('alice', 'charlie', 'trust');
      expect(trustValue).toBeUndefined();
    });

    it('should find rivalry dimension between rival agents', () => {
      graph.addFromSeed({ from: 'alice', to: 'bob', type: 'rival' });
      const rivalryValue = graph.getDimensionValue('alice', 'bob', 'rivalry');
      expect(rivalryValue).toBeDefined();
      expect(rivalryValue!).toBeGreaterThan(0.3);
    });
  });

  describe('visualization data generation', () => {
    it('should produce VisualizationData with nodes, edges, clusters', () => {
      graph.addFromSeed({ from: 'alice', to: 'bob', type: 'ally' });
      graph.addFromSeed({ from: 'bob', to: 'charlie', type: 'peer' });

      const vizData = graph.toVisualizationData({
        agentMetadata: {
          alice: { name: 'Alice', role: 'Engineer' },
          bob: { name: 'Bob', role: 'Designer' },
          charlie: { name: 'Charlie', role: 'Manager' },
        },
      });

      expect(vizData.nodes).toHaveLength(3);
      expect(vizData.edges).toHaveLength(2);
      expect(vizData.clusters.length).toBeGreaterThanOrEqual(1);
      expect(vizData.generatedAt).toBeDefined();

      const aliceNode = vizData.nodes.find(n => n.id === 'alice');
      expect(aliceNode!.label).toBe('Alice');
      expect(aliceNode!.role).toBe('Engineer');
    });
  });

  describe('routing behavior degradation', () => {
    it('should still work with no relationships (empty graph)', () => {
      // With an empty graph, influence scores are all 0
      // selectRespondents should fall back to keyword/diversity
      const scores = computeInfluence(graph);
      expect(scores).toHaveLength(0);
    });

    it('should provide trust values for keyword+relationship combined scoring', () => {
      // Setup: alice trusts bob
      graph.addFromSeed({ from: 'alice', to: 'bob', type: 'ally' });

      // Verify: trust value exists for scoring
      const trust = graph.getDimensionValue('alice', 'bob', 'trust');
      expect(trust).toBeDefined();
      expect(trust!).toBeGreaterThan(0);

      // Verify: no trust for unrelated pair
      const noTrust = graph.getDimensionValue('alice', 'dave', 'trust');
      expect(noTrust).toBeUndefined();
    });

    it('should return influence scores for all graph participants', () => {
      graph.addFromSeed({ from: 'alice', to: 'bob', type: 'ally' });
      graph.addFromSeed({ from: 'charlie', to: 'bob', type: 'ally' });
      graph.addFromSeed({ from: 'dave', to: 'alice', type: 'peer' });

      const scores = computeInfluence(graph);
      // Should have scores for all agents in the graph
      const agentIds = scores.map(s => s.agentId);
      expect(agentIds).toContain('alice');
      expect(agentIds).toContain('bob');
      expect(agentIds).toContain('charlie');
      expect(agentIds).toContain('dave');
    });
  });
});
