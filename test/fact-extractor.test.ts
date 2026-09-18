import assert from "node:assert/strict"
import test from "node:test"
import { parseFactExtraction } from "../src/memory/fact-extractor.js"

test("fact extraction parser keeps only bounded supported structured values", () => {
  const parsed = parseFactExtraction({
    entities: [
      { name: "52MD", type: "Project", aliases: ["选品", "选品"] },
      { name: "", type: "Person", aliases: [] },
      { name: "非法", type: "Concept", aliases: [] },
    ],
    facts: [
      {
        type: "ACTION_ITEM",
        key: "52MD:确认方案",
        text: "确认方案",
        status: "open",
        subject: "52MD",
        object: null,
        assignee: "我",
        dueAt: null,
        occurredAt: null,
        confidence: 2,
        evidenceOrdinals: [1, 1, 2],
      },
      {
        type: "UNKNOWN_FACT",
        key: "x",
        text: "x",
        status: "open",
        evidenceOrdinals: [1],
      },
      {
        type: "STATUS",
        key: "无证据",
        text: "无证据",
        status: "active",
        confidence: 0.5,
        evidenceOrdinals: [],
      },
    ],
  })
  assert.deepEqual(parsed.entities, [{ name: "52MD", type: "Project", aliases: ["选品"] }])
  assert.equal(parsed.facts.length, 1)
  assert.equal(parsed.facts[0]?.confidence, 1)
  assert.deepEqual(parsed.facts[0]?.evidenceOrdinals, [1, 2])
})
