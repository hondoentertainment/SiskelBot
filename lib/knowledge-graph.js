/**
 * Knowledge graph: entities and relationships extracted from documents.
 * Enables cross-document querying and relationship-aware RAG.
 */
import { randomUUID } from "crypto";

const ENTITY_TYPES = new Set([
  "person", "organization", "concept", "tool",
  "technology", "location", "event", "other",
]);

const RELATION_TYPES = new Set([
  "uses", "depends_on", "part_of", "related_to",
  "created_by", "mentioned_in",
]);

/**
 * Create an in-memory knowledge graph with entity and relation management.
 * @returns {KnowledgeGraph}
 */
export function createKnowledgeGraph() {
  /** @type {Map<string, Entity>} */
  const entities = new Map();
  /** @type {Array<Relation>} */
  const relations = [];

  function normalizeType(type, validSet) {
    const t = String(type || "").trim().toLowerCase();
    return validSet.has(t) ? t : null;
  }

  const graph = {
    /**
     * Add an entity to the graph.
     * @param {object} entity - { id?, name, type, properties?, sourceDocId? }
     * @returns {{ ok: boolean, id?: string, error?: string }}
     */
    addEntity(entity) {
      if (!entity || typeof entity.name !== "string" || !entity.name.trim()) {
        return { ok: false, error: "entity name is required" };
      }
      const type = normalizeType(entity.type, ENTITY_TYPES);
      if (!type) {
        return { ok: false, error: `invalid entity type: ${entity.type}. Valid: ${[...ENTITY_TYPES].join(", ")}` };
      }
      const id = entity.id || randomUUID();
      const ent = {
        id,
        name: entity.name.trim(),
        type,
        properties: entity.properties && typeof entity.properties === "object" ? { ...entity.properties } : {},
        sourceDocId: entity.sourceDocId || null,
        createdAt: new Date().toISOString(),
      };
      entities.set(id, ent);
      return { ok: true, id };
    },

    /**
     * Add a relation between two entities.
     * @param {object} relation - { from, to, type, properties?, sourceDocId? }
     * @returns {{ ok: boolean, error?: string }}
     */
    addRelation(relation) {
      if (!relation || !relation.from || !relation.to) {
        return { ok: false, error: "from and to entity IDs are required" };
      }
      if (!entities.has(relation.from)) {
        return { ok: false, error: `source entity not found: ${relation.from}` };
      }
      if (!entities.has(relation.to)) {
        return { ok: false, error: `target entity not found: ${relation.to}` };
      }
      const type = normalizeType(relation.type, RELATION_TYPES);
      if (!type) {
        return { ok: false, error: `invalid relation type: ${relation.type}. Valid: ${[...RELATION_TYPES].join(", ")}` };
      }
      const rel = {
        from: relation.from,
        to: relation.to,
        type,
        properties: relation.properties && typeof relation.properties === "object" ? { ...relation.properties } : {},
        sourceDocId: relation.sourceDocId || null,
      };
      relations.push(rel);
      return { ok: true };
    },

    /**
     * Get an entity by ID.
     * @param {string} id
     * @returns {Entity|null}
     */
    getEntity(id) {
      return entities.get(id) || null;
    },

    /**
     * Find entities by name, type, or property match.
     * @param {object} query - { name?, type?, properties? }
     * @returns {Entity[]}
     */
    findEntities(query) {
      const q = query || {};
      const nameLower = typeof q.name === "string" ? q.name.toLowerCase() : null;
      const typeLower = typeof q.type === "string" ? q.type.toLowerCase() : null;
      const results = [];

      for (const ent of entities.values()) {
        if (nameLower && !ent.name.toLowerCase().includes(nameLower)) continue;
        if (typeLower && ent.type !== typeLower) continue;
        if (q.properties && typeof q.properties === "object") {
          let propsMatch = true;
          for (const [k, v] of Object.entries(q.properties)) {
            if (ent.properties[k] !== v) { propsMatch = false; break; }
          }
          if (!propsMatch) continue;
        }
        results.push(ent);
      }
      return results;
    },

    /**
     * Get relations for an entity.
     * @param {string} entityId
     * @param {object} [options] - { type?, direction? } direction: "outgoing"|"incoming"|"both"
     * @returns {Relation[]}
     */
    getRelations(entityId, options) {
      const opts = options || {};
      const dir = opts.direction || "both";
      const relType = opts.type ? opts.type.toLowerCase() : null;

      return relations.filter((r) => {
        if (relType && r.type !== relType) return false;
        if (dir === "outgoing") return r.from === entityId;
        if (dir === "incoming") return r.to === entityId;
        return r.from === entityId || r.to === entityId;
      });
    },

    /**
     * Get neighbors of an entity up to a given depth via BFS.
     * @param {string} entityId
     * @param {number} [depth=1]
     * @returns {{ entities: Entity[], relations: Relation[] }}
     */
    getNeighbors(entityId, depth) {
      const maxDepth = Math.max(1, Math.min(depth || 1, 10));
      const visited = new Set();
      const queue = [{ id: entityId, d: 0 }];
      visited.add(entityId);
      const resultEntities = [];
      const resultRelations = [];

      while (queue.length > 0) {
        const { id, d } = queue.shift();
        const ent = entities.get(id);
        if (ent) resultEntities.push(ent);

        if (d >= maxDepth) continue;

        for (const rel of relations) {
          let neighborId = null;
          if (rel.from === id && !visited.has(rel.to)) neighborId = rel.to;
          else if (rel.to === id && !visited.has(rel.from)) neighborId = rel.from;

          if (neighborId !== null) {
            visited.add(neighborId);
            queue.push({ id: neighborId, d: d + 1 });
            resultRelations.push(rel);
          }
          // Also collect relations between already-visited nodes at this level
          if ((rel.from === id || rel.to === id) && !resultRelations.includes(rel)) {
            const other = rel.from === id ? rel.to : rel.from;
            if (visited.has(other)) resultRelations.push(rel);
          }
        }
      }

      return { entities: resultEntities, relations: resultRelations };
    },

    /**
     * Remove an entity and its associated relations.
     * @param {string} id
     * @returns {{ ok: boolean, removed: boolean }}
     */
    removeEntity(id) {
      const existed = entities.delete(id);
      if (existed) {
        for (let i = relations.length - 1; i >= 0; i--) {
          if (relations[i].from === id || relations[i].to === id) {
            relations.splice(i, 1);
          }
        }
      }
      return { ok: true, removed: existed };
    },

    /**
     * Remove all entities and relations originating from a document.
     * @param {string} docId
     * @returns {{ ok: boolean, entitiesRemoved: number, relationsRemoved: number }}
     */
    removeDocEntities(docId) {
      const docEntityIds = new Set();
      for (const [id, ent] of entities) {
        if (ent.sourceDocId === docId) docEntityIds.add(id);
      }
      for (const id of docEntityIds) entities.delete(id);

      let relRemoved = 0;
      for (let i = relations.length - 1; i >= 0; i--) {
        if (relations[i].sourceDocId === docId || docEntityIds.has(relations[i].from) || docEntityIds.has(relations[i].to)) {
          relations.splice(i, 1);
          relRemoved++;
        }
      }
      return { ok: true, entitiesRemoved: docEntityIds.size, relationsRemoved: relRemoved };
    },

    /**
     * Find shortest path between two entities using BFS.
     * @param {string} fromId
     * @param {string} toId
     * @returns {{ found: boolean, path: string[], relations: Relation[] }}
     */
    findPath(fromId, toId) {
      if (fromId === toId) {
        return { found: true, path: [fromId], relations: [] };
      }
      if (!entities.has(fromId) || !entities.has(toId)) {
        return { found: false, path: [], relations: [] };
      }

      const visited = new Set([fromId]);
      const queue = [{ id: fromId, path: [fromId], rels: [] }];

      while (queue.length > 0) {
        const { id, path, rels } = queue.shift();

        for (const rel of relations) {
          let neighborId = null;
          if (rel.from === id && !visited.has(rel.to)) neighborId = rel.to;
          else if (rel.to === id && !visited.has(rel.from)) neighborId = rel.from;

          if (neighborId !== null) {
            const newPath = [...path, neighborId];
            const newRels = [...rels, rel];
            if (neighborId === toId) {
              return { found: true, path: newPath, relations: newRels };
            }
            visited.add(neighborId);
            queue.push({ id: neighborId, path: newPath, rels: newRels });
          }
        }
      }

      return { found: false, path: [], relations: [] };
    },

    /**
     * Extract a subgraph containing the specified entities and relations between them.
     * @param {string[]} entityIds
     * @returns {{ entities: Entity[], relations: Relation[] }}
     */
    getSubgraph(entityIds) {
      const idSet = new Set(entityIds);
      const subEntities = [];
      for (const id of idSet) {
        const ent = entities.get(id);
        if (ent) subEntities.push(ent);
      }
      const subRelations = relations.filter(
        (r) => idSet.has(r.from) && idSet.has(r.to)
      );
      return { entities: subEntities, relations: subRelations };
    },

    /**
     * Get graph statistics.
     * @returns {{ entityCount: number, relationCount: number, entityTypes: object, relationTypes: object, density: number }}
     */
    getStats() {
      const entityTypes = {};
      for (const ent of entities.values()) {
        entityTypes[ent.type] = (entityTypes[ent.type] || 0) + 1;
      }
      const relationTypes = {};
      for (const rel of relations) {
        relationTypes[rel.type] = (relationTypes[rel.type] || 0) + 1;
      }
      const n = entities.size;
      const maxEdges = n * (n - 1);
      const density = maxEdges > 0 ? relations.length / maxEdges : 0;

      return {
        entityCount: entities.size,
        relationCount: relations.length,
        entityTypes,
        relationTypes,
        density: Math.round(density * 10000) / 10000,
      };
    },

    /**
     * Get the most connected entities.
     * @param {number} [limit=10]
     * @returns {Array<{ entity: Entity, connectionCount: number }>}
     */
    getTopEntities(limit) {
      const lim = Math.max(1, Math.min(limit || 10, 100));
      const counts = new Map();
      for (const rel of relations) {
        counts.set(rel.from, (counts.get(rel.from) || 0) + 1);
        counts.set(rel.to, (counts.get(rel.to) || 0) + 1);
      }
      const sorted = [...counts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, lim);
      return sorted.map(([id, count]) => ({
        entity: entities.get(id),
        connectionCount: count,
      })).filter((e) => e.entity);
    },

    /**
     * Serialize the graph to a plain object for persistence.
     * @returns {{ entities: Entity[], relations: Relation[] }}
     */
    serialize() {
      return {
        entities: [...entities.values()],
        relations: [...relations],
      };
    },

    /**
     * Deserialize and load graph data.
     * @param {object} data - { entities: Entity[], relations: Relation[] }
     */
    deserialize(data) {
      entities.clear();
      relations.length = 0;
      if (data && Array.isArray(data.entities)) {
        for (const ent of data.entities) {
          if (ent && ent.id && ent.name) {
            entities.set(ent.id, {
              id: ent.id,
              name: ent.name,
              type: ent.type || "other",
              properties: ent.properties || {},
              sourceDocId: ent.sourceDocId || null,
              createdAt: ent.createdAt || new Date().toISOString(),
            });
          }
        }
      }
      if (data && Array.isArray(data.relations)) {
        for (const rel of data.relations) {
          if (rel && rel.from && rel.to && entities.has(rel.from) && entities.has(rel.to)) {
            relations.push({
              from: rel.from,
              to: rel.to,
              type: rel.type || "related_to",
              properties: rel.properties || {},
              sourceDocId: rel.sourceDocId || null,
            });
          }
        }
      }
    },
  };

  return graph;
}

export { ENTITY_TYPES, RELATION_TYPES };
