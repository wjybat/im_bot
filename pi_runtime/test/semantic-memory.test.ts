import assert from "node:assert/strict"
import test from "node:test"
import { loadConfig } from "../src/config.js"
import { fuseRrf, OfficeMemory } from "../src/memory/index.js"
import { FakeFactExtractor, createTestSemantic } from "./fakes.js"

function messageFixture(finalContent = "方案已经确认，不需要继续修改"): unknown {
  return {
    messages: [
      {
        message_id: "om_semantic_1",
        chat_id: "oc_semantic_project",
        chat_type: "group",
        chat_name: "52MD 项目群",
        create_time: "2026-08-28T09:00:00+08:00",
        sender: { open_id: "ou_lead", name: "负责人", type: "user" },
        mentions: [{ open_id: "ou_owner" }],
        content: "请你周五前确认 52MD 选品方案",
      },
      {
        message_id: "om_semantic_2",
        chat_id: "oc_semantic_project",
        chat_type: "group",
        chat_name: "52MD 项目群",
        create_time: "2026-08-28T09:05:00+08:00",
        sender: { open_id: "ou_owner", name: "测试用户", type: "user" },
        content: "我今天给出评审稿",
      },
      {
        message_id: "om_semantic_3",
        chat_id: "oc_semantic_project",
        chat_type: "group",
        chat_name: "52MD 项目群",
        create_time: "2026-08-28T09:20:00+08:00",
        sender: { open_id: "ou_lead", name: "负责人", type: "user" },
        content: finalContent,
      },
    ],
  }
}

test("semantic memory extracts, supersedes, graphs, and hybrid-retrieves evidence-backed facts", async () => {
  const config = loadConfig()
  const memory = new OfficeMemory({ path: ":memory:", ownerExternalId: "ou_owner" })
  const extractor = new FakeFactExtractor(
    {
      entities: [
        { name: "52MD", type: "Project", aliases: ["52MD 选品"] },
        { name: "测试用户", type: "Person", aliases: [] },
      ],
      facts: [
        {
          type: "ACTION_ITEM",
          key: "52MD:确认选品方案",
          text: "测试用户需要在周五前确认 52MD 选品方案",
          status: "open",
          subject: "52MD",
          object: "选品方案",
          assignee: "测试用户",
          dueAt: "2026-08-28T18:00:00+08:00",
          occurredAt: "2026-08-28T09:00:00+08:00",
          confidence: 0.96,
          evidenceOrdinals: [1, 2],
        },
        {
          type: "ACTION_ITEM",
          key: "52MD:确认选品方案",
          text: "52MD 选品方案已经确认，无需继续修改",
          status: "done",
          subject: "52MD",
          object: "选品方案",
          assignee: "测试用户",
          dueAt: null,
          occurredAt: "2026-08-28T09:20:00+08:00",
          confidence: 0.98,
          evidenceOrdinals: [3],
        },
      ],
    },
    {
      entities: [{ name: "52MD", type: "Project", aliases: [] }],
      facts: [
        {
          type: "ACTION_ITEM",
          key: "52MD:确认选品方案",
          text: "52MD 方案出现新问题，需要重新确认",
          status: "open",
          subject: "52MD",
          object: "选品方案",
          assignee: "测试用户",
          dueAt: null,
          occurredAt: "2026-08-28T09:25:00+08:00",
          confidence: 0.9,
          evidenceOrdinals: [3],
        },
      ],
    },
  )
  const semantic = createTestSemantic(memory, config, extractor)
  try {
    memory.ingestLarkPayload(messageFixture(), { source: "test", resource: "chat.message" })
    const first = await semantic.enrich(5)
    assert.equal(first.queuedChunks, 1)
    assert.equal(first.completedChunks, 1)
    assert.equal(first.factsCreated, 2)
    assert.equal(first.factsSuperseded, 1)
    assert.equal(first.factsRejected, 0)

    const done = semantic.search({ query: "52MD 选品方案", currentOnly: true, limit: 10 })
    const doneFact = done.hits.find((hit) => hit.kind === "fact")
    assert.ok(doneFact)
    assert.equal(doneFact.status, "done")
    assert.equal(doneFact.factType, "ACTION_ITEM")
    assert.ok(doneFact.evidence.some((item) => item.chat === "52MD 项目群"))
    assert.ok(doneFact.routes.some((route) => route.source === "local.fact_fts"))
    assert.ok(doneFact.routes.some((route) => route.source === "graph.entity"))
    assert.match(done.contextText, /Evidence:/u)

    const historicalDue = semantic.search({
      dueStart: "2026-08-28T00:00:00+08:00",
      dueEnd: "2026-08-28T23:59:59+08:00",
      statuses: ["open"],
      currentOnly: false,
      limit: 10,
    })
    assert.ok(historicalDue.hits.some((hit) => hit.kind === "fact" && hit.dueAt !== null))

    const firstStatus = memory.status()
    assert.equal(firstStatus.chunks, 1)
    assert.equal(firstStatus.facts, 2)
    assert.equal(firstStatus.currentFacts, 1)
    assert.ok(firstStatus.entities >= 3)
    assert.ok(firstStatus.edges >= 8)
    assert.equal(firstStatus.semanticLag, 0)
    assert.equal((await semantic.enrich(5)).queuedChunks, 0)

    memory.ingestLarkPayload(messageFixture("方案出现新问题，需要重新确认"), {
      source: "test",
      resource: "chat.message",
    })
    assert.equal(memory.status().currentFacts, 0)
    const second = await semantic.enrich(5)
    assert.equal(second.completedChunks, 1)
    assert.equal(second.factsCreated, 1)
    assert.ok(second.factsSuperseded >= 1)
    const reopened = semantic.search({
      query: "52MD",
      factTypes: ["ACTION_ITEM"],
      statuses: ["open"],
      currentOnly: true,
      limit: 10,
    })
    const current = reopened.hits.find((hit) => hit.kind === "fact")
    assert.ok(current)
    assert.equal(current.status, "open")
    assert.match(current.text, /重新确认/u)
    assert.equal(memory.status().currentFacts, 1)

    const expanded = semantic.getFactEvidence([current.ref])
    assert.equal(expanded.length, 1)
    assert.ok(expanded[0]?.evidence.some((item) => /新问题/u.test(item.content)))

    memory.markAssistantControlConversation("oc_semantic_project")
    assert.equal(memory.status().currentFacts, 0)
    assert.equal(semantic.search({ query: "52MD", currentOnly: true }).hits.some((hit) => hit.kind === "fact"), false)
  } finally {
    memory.close()
  }
})

test("context-only or unknown evidence cannot create a fact", async () => {
  const config = loadConfig()
  const memory = new OfficeMemory({ path: ":memory:", ownerExternalId: "ou_owner" })
  const extractor = new FakeFactExtractor(
    { entities: [], facts: [] },
    {
      entities: [],
      facts: [
        {
          type: "REQUEST",
          key: "错误:上下文事实",
          text: "这条事实只由上下文产生",
          status: "open",
          subject: null,
          object: null,
          assignee: "测试用户",
          dueAt: null,
          occurredAt: null,
          confidence: 0.9,
          evidenceOrdinals: [1],
        },
      ],
    },
  )
  const semantic = createTestSemantic(memory, config, extractor)
  try {
    memory.ingestLarkPayload(
      {
        messages: [{
          message_id: "om_context",
          chat_id: "oc_context",
          chat_type: "group",
          chat_name: "上下文群",
          create_time: "2026-08-28T10:00:00+08:00",
          sender: { open_id: "ou_other", name: "同事", type: "user" },
          content: "第一条背景消息",
        }],
      },
      { source: "test", resource: "chat.message" },
    )
    await semantic.enrich(1)
    memory.ingestLarkPayload(
      {
        messages: [{
          message_id: "om_primary",
          chat_id: "oc_context",
          chat_type: "group",
          chat_name: "上下文群",
          create_time: "2026-08-28T10:05:00+08:00",
          sender: { open_id: "ou_other", name: "同事", type: "user" },
          content: "第二条没有行动要求",
        }],
      },
      { source: "test", resource: "chat.message" },
    )
    const result = await semantic.enrich(1)
    assert.equal(result.factsCreated, 0)
    assert.equal(result.factsRejected, 1)
    assert.equal(memory.status().facts, 0)
    assert.equal(extractor.calls[1]?.evidence[0]?.primary, false)
    assert.equal(extractor.calls[1]?.evidence[1]?.primary, true)
  } finally {
    memory.close()
  }
})

test("RRF favors evidence supported by several independent routes", () => {
  const fused = fuseRrf(
    [
      { source: "fts", ids: ["fact:a", "fact:b"] },
      { source: "graph", ids: ["fact:b", "fact:c"] },
      { source: "structured", ids: ["fact:b"] },
    ],
    10,
  )
  assert.equal(fused[0]?.id, "fact:b")
  assert.equal(fused[0]?.routes.length, 3)
})

test("failed extraction is auditable and retries the same pending revision", async () => {
  const config = loadConfig()
  const memory = new OfficeMemory({ path: ":memory:", ownerExternalId: "ou_owner" })
  const extractor = new FakeFactExtractor(
    new Error("temporary extractor failure"),
    {
      entities: [],
      facts: [{
        type: "STATUS",
        key: "重试:状态",
        text: "重试后抽取成功",
        status: "active",
        subject: null,
        object: null,
        assignee: null,
        dueAt: null,
        occurredAt: null,
        confidence: 0.8,
        evidenceOrdinals: [1],
      }],
    },
  )
  const semantic = createTestSemantic(memory, config, extractor)
  try {
    memory.ingestLarkPayload(
      { messages: [{
        message_id: "om_retry",
        chat_id: "oc_retry",
        chat_type: "group",
        chat_name: "重试群",
        create_time: "2026-08-28T11:00:00+08:00",
        sender: { open_id: "ou_other", name: "同事", type: "user" },
        content: "这是需要抽取的状态更新",
      }] },
      { source: "test", resource: "chat.message" },
    )
    const failed = await semantic.enrich(1)
    assert.equal(failed.failedChunks, 1)
    assert.equal(memory.status().failedExtractions, 1)
    assert.equal(semantic.pendingMessageCount(), 1)

    const retried = await semantic.enrich(1)
    assert.equal(retried.completedChunks, 1)
    assert.equal(retried.factsCreated, 1)
    assert.equal(semantic.pendingMessageCount(), 0)
    assert.equal(memory.status().failedExtractions, 1)
  } finally {
    memory.close()
  }
})
