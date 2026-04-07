import test from "node:test";
import assert from "node:assert/strict";
import { createKnowledgeGraph, ENTITY_TYPES, RELATION_TYPES } from "../lib/knowledge-graph.js";
import { extractEntities, extractRelations } from "../lib/entity-extractor.js";

// --- Knowledge Graph: Entity operations ---

await test("addEntity returns ok and id", () => {
  const graph = createKnowledgeGraph();
  const result = graph.addEntity({ name: "Node.js", type: "technology" });
  assert.equal(result.ok, true);
  assert.ok(result.id);
});

await test("addEntity rejects missing name", () => {
  const graph = createKnowledgeGraph();
  const result = graph.addEntity({ type: "technology" });
  assert.equal(result.ok, false);
  assert.ok(result.error.includes("name"));
});

await test("addEntity rejects invalid type", () => {
  const graph = createKnowledgeGraph();
  const result = graph.addEntity({ name: "Foo", type: "invalid_type" });
  assert.equal(result.ok, false);
  assert.ok(result.error.includes("invalid entity type"));
});

await test("getEntity returns entity by id", () => {
  const graph = createKnowledgeGraph();
  const { id } = graph.addEntity({ name: "React", type: "technology" });
  const entity = graph.getEntity(id);
  assert.equal(entity.name, "React");
  assert.equal(entity.type, "technology");
});

await test("getEntity returns null for unknown id", () => {
  const graph = createKnowledgeGraph();
  assert.equal(graph.getEntity("nonexistent"), null);
});

await test("findEntities searches by name", () => {
  const graph = createKnowledgeGraph();
  graph.addEntity({ name: "Node.js", type: "technology" });
  graph.addEntity({ name: "React", type: "technology" });
  graph.addEntity({ name: "Alice", type: "person" });

  const results = graph.findEntities({ name: "node" });
  assert.equal(results.length, 1);
  assert.equal(results[0].name, "Node.js");
});

await test("findEntities searches by type", () => {
  const graph = createKnowledgeGraph();
  graph.addEntity({ name: "Node.js", type: "technology" });
  graph.addEntity({ name: "Alice", type: "person" });
  graph.addEntity({ name: "Bob", type: "person" });

  const results = graph.findEntities({ type: "person" });
  assert.equal(results.length, 2);
});

await test("removeEntity deletes entity and its relations", () => {
  const graph = createKnowledgeGraph();
  const { id: aId } = graph.addEntity({ name: "A", type: "concept" });
  const { id: bId } = graph.addEntity({ name: "B", type: "concept" });
  graph.addRelation({ from: aId, to: bId, type: "related_to" });

  const removed = graph.removeEntity(aId);
  assert.equal(removed.removed, true);
  assert.equal(graph.getEntity(aId), null);
  assert.equal(graph.getRelations(bId).length, 0);
});

await test("removeEntity returns removed=false for unknown id", () => {
  const graph = createKnowledgeGraph();
  const result = graph.removeEntity("nonexistent");
  assert.equal(result.removed, false);
});

await test("removeDocEntities removes all entities from a document", () => {
  const graph = createKnowledgeGraph();
  graph.addEntity({ name: "A", type: "concept", sourceDocId: "doc1" });
  graph.addEntity({ name: "B", type: "concept", sourceDocId: "doc1" });
  graph.addEntity({ name: "C", type: "concept", sourceDocId: "doc2" });

  const result = graph.removeDocEntities("doc1");
  assert.equal(result.entitiesRemoved, 2);
  assert.equal(graph.findEntities({}).length, 1);
  assert.equal(graph.findEntities({})[0].name, "C");
});

// --- Knowledge Graph: Relation operations ---

await test("addRelation creates relation between entities", () => {
  const graph = createKnowledgeGraph();
  const { id: aId } = graph.addEntity({ name: "Express", type: "technology" });
  const { id: bId } = graph.addEntity({ name: "Node.js", type: "technology" });
  const result = graph.addRelation({ from: aId, to: bId, type: "depends_on" });
  assert.equal(result.ok, true);
});

await test("addRelation rejects invalid relation type", () => {
  const graph = createKnowledgeGraph();
  const { id: aId } = graph.addEntity({ name: "A", type: "concept" });
  const { id: bId } = graph.addEntity({ name: "B", type: "concept" });
  const result = graph.addRelation({ from: aId, to: bId, type: "unknown_rel" });
  assert.equal(result.ok, false);
});

await test("addRelation rejects missing entity", () => {
  const graph = createKnowledgeGraph();
  const { id: aId } = graph.addEntity({ name: "A", type: "concept" });
  const result = graph.addRelation({ from: aId, to: "nonexistent", type: "related_to" });
  assert.equal(result.ok, false);
  assert.ok(result.error.includes("target entity not found"));
});

await test("getRelations returns relations for entity", () => {
  const graph = createKnowledgeGraph();
  const { id: aId } = graph.addEntity({ name: "A", type: "concept" });
  const { id: bId } = graph.addEntity({ name: "B", type: "concept" });
  const { id: cId } = graph.addEntity({ name: "C", type: "concept" });
  graph.addRelation({ from: aId, to: bId, type: "related_to" });
  graph.addRelation({ from: cId, to: aId, type: "depends_on" });

  const all = graph.getRelations(aId);
  assert.equal(all.length, 2);

  const outgoing = graph.getRelations(aId, { direction: "outgoing" });
  assert.equal(outgoing.length, 1);
  assert.equal(outgoing[0].to, bId);

  const incoming = graph.getRelations(aId, { direction: "incoming" });
  assert.equal(incoming.length, 1);
  assert.equal(incoming[0].from, cId);
});

await test("getRelations filters by type", () => {
  const graph = createKnowledgeGraph();
  const { id: aId } = graph.addEntity({ name: "A", type: "concept" });
  const { id: bId } = graph.addEntity({ name: "B", type: "concept" });
  const { id: cId } = graph.addEntity({ name: "C", type: "concept" });
  graph.addRelation({ from: aId, to: bId, type: "related_to" });
  graph.addRelation({ from: aId, to: cId, type: "depends_on" });

  const rels = graph.getRelations(aId, { type: "depends_on" });
  assert.equal(rels.length, 1);
  assert.equal(rels[0].type, "depends_on");
});

// --- Knowledge Graph: Neighbor traversal ---

await test("getNeighbors returns direct neighbors at depth 1", () => {
  const graph = createKnowledgeGraph();
  const { id: aId } = graph.addEntity({ name: "A", type: "concept" });
  const { id: bId } = graph.addEntity({ name: "B", type: "concept" });
  const { id: cId } = graph.addEntity({ name: "C", type: "concept" });
  const { id: dId } = graph.addEntity({ name: "D", type: "concept" });
  graph.addRelation({ from: aId, to: bId, type: "related_to" });
  graph.addRelation({ from: bId, to: cId, type: "related_to" });
  graph.addRelation({ from: cId, to: dId, type: "related_to" });

  const result = graph.getNeighbors(aId, 1);
  const names = result.entities.map((e) => e.name);
  assert.ok(names.includes("A"));
  assert.ok(names.includes("B"));
  assert.ok(!names.includes("C"));
});

await test("getNeighbors at depth 2 includes two-hop neighbors", () => {
  const graph = createKnowledgeGraph();
  const { id: aId } = graph.addEntity({ name: "A", type: "concept" });
  const { id: bId } = graph.addEntity({ name: "B", type: "concept" });
  const { id: cId } = graph.addEntity({ name: "C", type: "concept" });
  const { id: dId } = graph.addEntity({ name: "D", type: "concept" });
  graph.addRelation({ from: aId, to: bId, type: "related_to" });
  graph.addRelation({ from: bId, to: cId, type: "related_to" });
  graph.addRelation({ from: cId, to: dId, type: "related_to" });

  const result = graph.getNeighbors(aId, 2);
  const names = result.entities.map((e) => e.name);
  assert.ok(names.includes("A"));
  assert.ok(names.includes("B"));
  assert.ok(names.includes("C"));
  assert.ok(!names.includes("D"));
});

// --- Knowledge Graph: Path finding ---

await test("findPath finds shortest path", () => {
  const graph = createKnowledgeGraph();
  const { id: aId } = graph.addEntity({ name: "A", type: "concept" });
  const { id: bId } = graph.addEntity({ name: "B", type: "concept" });
  const { id: cId } = graph.addEntity({ name: "C", type: "concept" });
  graph.addRelation({ from: aId, to: bId, type: "related_to" });
  graph.addRelation({ from: bId, to: cId, type: "related_to" });

  const result = graph.findPath(aId, cId);
  assert.equal(result.found, true);
  assert.deepEqual(result.path, [aId, bId, cId]);
  assert.equal(result.relations.length, 2);
});

await test("findPath returns not found for disconnected entities", () => {
  const graph = createKnowledgeGraph();
  const { id: aId } = graph.addEntity({ name: "A", type: "concept" });
  graph.addEntity({ name: "B", type: "concept" });
  const { id: cId } = graph.addEntity({ name: "C", type: "concept" });
  // A and C are not connected

  const result = graph.findPath(aId, cId);
  assert.equal(result.found, false);
  assert.equal(result.path.length, 0);
});

await test("findPath from entity to itself", () => {
  const graph = createKnowledgeGraph();
  const { id: aId } = graph.addEntity({ name: "A", type: "concept" });
  const result = graph.findPath(aId, aId);
  assert.equal(result.found, true);
  assert.deepEqual(result.path, [aId]);
});

// --- Knowledge Graph: Subgraph ---

await test("getSubgraph extracts subgraph for given entities", () => {
  const graph = createKnowledgeGraph();
  const { id: aId } = graph.addEntity({ name: "A", type: "concept" });
  const { id: bId } = graph.addEntity({ name: "B", type: "concept" });
  const { id: cId } = graph.addEntity({ name: "C", type: "concept" });
  graph.addRelation({ from: aId, to: bId, type: "related_to" });
  graph.addRelation({ from: bId, to: cId, type: "related_to" });

  const sub = graph.getSubgraph([aId, bId]);
  assert.equal(sub.entities.length, 2);
  assert.equal(sub.relations.length, 1);
  assert.equal(sub.relations[0].from, aId);
  assert.equal(sub.relations[0].to, bId);
});

// --- Knowledge Graph: Stats ---

await test("getStats returns graph statistics", () => {
  const graph = createKnowledgeGraph();
  graph.addEntity({ name: "A", type: "concept" });
  graph.addEntity({ name: "B", type: "technology" });
  const { id: aId } = graph.findEntities({ name: "A" })[0] ? { id: graph.findEntities({ name: "A" })[0].id } : {};
  const { id: bId } = graph.findEntities({ name: "B" })[0] ? { id: graph.findEntities({ name: "B" })[0].id } : {};
  graph.addRelation({ from: aId, to: bId, type: "related_to" });

  const stats = graph.getStats();
  assert.equal(stats.entityCount, 2);
  assert.equal(stats.relationCount, 1);
  assert.equal(stats.entityTypes.concept, 1);
  assert.equal(stats.entityTypes.technology, 1);
  assert.equal(stats.relationTypes.related_to, 1);
  assert.ok(stats.density >= 0);
});

await test("getTopEntities returns most connected entities", () => {
  const graph = createKnowledgeGraph();
  const { id: aId } = graph.addEntity({ name: "Hub", type: "concept" });
  const { id: bId } = graph.addEntity({ name: "B", type: "concept" });
  const { id: cId } = graph.addEntity({ name: "C", type: "concept" });
  const { id: dId } = graph.addEntity({ name: "D", type: "concept" });
  graph.addRelation({ from: aId, to: bId, type: "related_to" });
  graph.addRelation({ from: aId, to: cId, type: "related_to" });
  graph.addRelation({ from: aId, to: dId, type: "related_to" });

  const top = graph.getTopEntities(2);
  assert.equal(top[0].entity.name, "Hub");
  assert.equal(top[0].connectionCount, 3);
});

// --- Knowledge Graph: Serialization ---

await test("serialize and deserialize round-trips correctly", () => {
  const graph = createKnowledgeGraph();
  const { id: aId } = graph.addEntity({ name: "Express", type: "technology" });
  const { id: bId } = graph.addEntity({ name: "Node.js", type: "technology" });
  graph.addRelation({ from: aId, to: bId, type: "depends_on" });

  const data = graph.serialize();
  assert.equal(data.entities.length, 2);
  assert.equal(data.relations.length, 1);

  const graph2 = createKnowledgeGraph();
  graph2.deserialize(data);
  assert.equal(graph2.findEntities({}).length, 2);
  assert.equal(graph2.getRelations(aId).length, 1);
});

// --- Entity Extraction ---

await test("extractEntities finds @mentions as persons", () => {
  const entities = extractEntities("Thanks @johndoe and @janedoe for the review");
  const names = entities.map((e) => e.name);
  assert.ok(names.includes("johndoe"));
  assert.ok(names.includes("janedoe"));
  const john = entities.find((e) => e.name === "johndoe");
  assert.equal(john.type, "person");
});

await test("extractEntities finds known tech terms", () => {
  const entities = extractEntities("We use React and Node.js for the frontend and backend.");
  const names = entities.map((e) => e.name.toLowerCase());
  assert.ok(names.includes("react"));
  assert.ok(names.includes("node.js"));
  const react = entities.find((e) => e.name.toLowerCase() === "react");
  assert.equal(react.type, "technology");
});

await test("extractEntities finds URLs as technology", () => {
  const entities = extractEntities("Check out https://github.com/example/repo for details.");
  const names = entities.map((e) => e.name);
  assert.ok(names.includes("github.com"));
  const gh = entities.find((e) => e.name === "github.com");
  assert.equal(gh.type, "technology");
});

await test("extractEntities returns empty for empty text", () => {
  assert.deepEqual(extractEntities(""), []);
  assert.deepEqual(extractEntities(null), []);
});

// --- Relation Extraction ---

await test("extractRelations finds 'uses' pattern", () => {
  const text = "Express uses Node.js for its runtime.";
  const entities = [
    { name: "Express", type: "technology" },
    { name: "Node.js", type: "technology" },
  ];
  const relations = extractRelations(text, entities);
  const usesRel = relations.find((r) => r.type === "uses");
  assert.ok(usesRel, "Should find a 'uses' relation");
  assert.equal(usesRel.from, "Express");
  assert.equal(usesRel.to, "Node.js");
});

await test("extractRelations finds co-occurrence", () => {
  const text = "Both React and Vue are popular frontend frameworks.";
  const entities = [
    { name: "React", type: "technology" },
    { name: "Vue", type: "technology" },
  ];
  const relations = extractRelations(text, entities);
  assert.ok(relations.length > 0, "Should find at least one relation");
  const rel = relations.find((r) => r.type === "related_to");
  assert.ok(rel, "Should find a related_to relation from co-occurrence");
});

await test("extractRelations returns empty for fewer than 2 entities", () => {
  assert.deepEqual(extractRelations("some text", [{ name: "A", type: "concept" }]), []);
  assert.deepEqual(extractRelations("some text", []), []);
});

// --- ENTITY_TYPES and RELATION_TYPES exported correctly ---

await test("ENTITY_TYPES contains expected types", () => {
  assert.ok(ENTITY_TYPES.has("person"));
  assert.ok(ENTITY_TYPES.has("technology"));
  assert.ok(ENTITY_TYPES.has("organization"));
});

await test("RELATION_TYPES contains expected types", () => {
  assert.ok(RELATION_TYPES.has("uses"));
  assert.ok(RELATION_TYPES.has("depends_on"));
  assert.ok(RELATION_TYPES.has("related_to"));
});
