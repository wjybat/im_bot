export interface ToolManifest {
  version: 1
  transport: {
    protocol: "http-json"
    method: "POST"
    endpoint: "/v1/<function_name>"
    authorization: "Bearer <service-token>"
    contentType: "application/json"
  }
  instructions: string
  tools: Array<{
    type: "function"
    function: {
      name: string
      description: string
      parameters: Record<string, unknown>
    }
  }>
}

const OWNER_PROPERTIES = {
  ownerOpenId: {
    type: "string",
    description: "目标用户在本机器人飞书应用下的 open_id。与 ownerUnionId 二选一，必须提供其一。",
  },
  ownerUnionId: {
    type: "string",
    description:
      "目标用户的飞书 union_id（同一开发者账号下跨应用一致）。与 ownerOpenId 二选一，必须提供其一。",
  },
}

const SEARCH_FACTS_PROPERTIES = {
  ...OWNER_PROPERTIES,
  query: { type: "string", description: "检索关键词，如人名、项目名、事项描述。缺省则按时间/结构条件检索。" },
  start: { type: "string", description: "ISO-8601 时间下界（事实或证据的发生时间）。" },
  end: { type: "string", description: "ISO-8601 时间上界。" },
  dueStart: { type: "string", description: "ISO-8601 截止时间下界（筛待办/期限时用）。" },
  dueEnd: { type: "string", description: "ISO-8601 截止时间上界。" },
  chatType: { type: "string", enum: ["p2p", "group"], description: "限定私聊或群聊；缺省两者都查。" },
  factTypes: {
    type: "array",
    items: {
      type: "string",
      enum: [
        "ACTION_ITEM",
        "REQUEST",
        "DECISION",
        "COMMITMENT",
        "DELEGATION",
        "STATUS",
        "DEADLINE",
        "RISK",
      ],
    },
    description: "限定事实类型。缺省不限。",
  },
  statuses: {
    type: "array",
    items: { type: "string", enum: ["open", "done", "cancelled", "active", "resolved", "uncertain", "superseded"] },
    description: "限定事实状态，如仅查未完成事项传 [\"open\"]。",
  },
  currentOnly: { type: "boolean", description: "仅返回当前有效事实（默认 true）。" },
  limit: { type: "integer", minimum: 1, maximum: 50, description: "返回条数，默认 20。" },
}

const SEARCH_MESSAGES_PROPERTIES = {
  ...OWNER_PROPERTIES,
  query: { type: "string", description: "消息全文检索关键词。缺省按时间窗倒序返回。" },
  start: { type: "string", description: "ISO-8601 发送时间下界。" },
  end: { type: "string", description: "ISO-8601 发送时间上界。" },
  chatType: { type: "string", enum: ["p2p", "group"], description: "限定私聊或群聊。" },
  limit: { type: "integer", minimum: 1, maximum: 50, description: "返回条数，默认 20。" },
}

const REFRESH_PROPERTIES = {
  ...OWNER_PROPERTIES,
  start: { type: "string", description: "ISO-8601 时间窗下界（必填）。" },
  end: { type: "string", description: "ISO-8601 时间窗上界（必填）。" },
  query: { type: "string", description: "可选的源消息过滤词。" },
  chatType: { type: "string", enum: ["p2p", "group"], description: "限定私聊或群聊。" },
}

export const TOOL_MANIFEST: ToolManifest = {
  version: 1,
  transport: {
    protocol: "http-json",
    method: "POST",
    endpoint: "/v1/<function_name>",
    authorization: "Bearer <service-token>",
    contentType: "application/json",
  },
  instructions:
    "IM 上下文记忆服务：查询目标用户（owner）在飞书聊天中沉淀的消息、事实与知识图谱。执行方式：向服务地址 POST /v1/<函数名>，Header 带 Authorization: Bearer <service-token>，body 为该函数参数的 JSON。响应封套 {\"version\":1,\"ok\":true,\"data\":{...}}，失败为 {\"ok\":false,\"error\":{\"code\",\"message\"}}。使用要点：(1) 回答前先 get_status 判断数据新鲜度，覆盖不足时先 refresh_messages 再检索；(2) 检索结果的 ref 句柄可用 get_evidence 展开原文核验，但不要在给用户的最终回复中展示 ref；(3) 事实记忆是派生索引，判断事项是否已完成需结合 status 与最新证据；(4) 同一 owner+时间窗的刷新有冷却（默认 5 分钟），重复调用会返回 refresh_cooldown；(5) 出口已脱敏内部标识。响应文本均为中文。",
  tools: [
    {
      type: "function",
      function: {
        name: "search_facts",
        description:
          "混合检索该用户办公记忆中的事实（待办/请求/决策/风险/状态等）与相关消息，是回答工作类问题的主力工具。支持关键词、时间范围、截止时间、事实类型与状态筛选。返回按相关性排序的 hits，每条含文本、事实类型、状态、证据引用。",
        parameters: {
          type: "object",
          properties: SEARCH_FACTS_PROPERTIES,
          additionalProperties: false,
        },
      },
    },
    {
      type: "function",
      function: {
        name: "search_messages",
        description:
          "按关键词或时间窗检索该用户的原始飞书消息（私聊与群聊）。用于回源核验具体聊过什么。返回消息的会话名、发送人、时间与内容。",
        parameters: {
          type: "object",
          properties: SEARCH_MESSAGES_PROPERTIES,
          additionalProperties: false,
        },
      },
    },
    {
      type: "function",
      function: {
        name: "get_evidence",
        description:
          "展开 search_facts / search_messages 返回的 ref 句柄（mem_… 或 fact_…），拿到完整原文与证据链。用于对关键结论做回源核验。",
        parameters: {
          type: "object",
          properties: {
            ...OWNER_PROPERTIES,
            refs: {
              type: "array",
              items: { type: "string", pattern: "^(?:mem|fact)_[a-f0-9]{64}$" },
              minItems: 1,
              maxItems: 20,
              description: "检索结果中的 ref 句柄列表。",
            },
          },
          required: ["refs"],
          additionalProperties: false,
        },
      },
    },
    {
      type: "function",
      function: {
        name: "search_entities",
        description:
          "按名称或别名解析记忆图谱中的实体（人物、项目、系统、文档等）。当用户口中的对象只有一个模糊称呼时，先用本函数找到候选实体（返回候选列表，重名时需上层消歧），再用 get_entity 取详情。",
        parameters: {
          type: "object",
          properties: {
            ...OWNER_PROPERTIES,
            query: { type: "string", maxLength: 200, description: "名称或别名（必填）。" },
            limit: { type: "integer", minimum: 1, maximum: 20, description: "返回候选数，默认 10。" },
          },
          required: ["query"],
          additionalProperties: false,
        },
      },
    },
    {
      type: "function",
      function: {
        name: "get_entity",
        description:
          "按 id 取实体档案：类型、提及热度、别名、关联实体，以及与该实体相关的当前有效事实列表（按时间倒序，最多 100 条）。适合回答\"这个人/项目是谁、最近有什么交集\"。",
        parameters: {
          type: "object",
          properties: {
            ...OWNER_PROPERTIES,
            id: { type: "string", description: "实体 id（来自 search_entities 的返回）。" },
          },
          required: ["id"],
          additionalProperties: false,
        },
      },
    },
    {
      type: "function",
      function: {
        name: "get_status",
        description:
          "查看该用户记忆库的数据状态：消息覆盖窗口、消息量、事实/实体数量、抽取积压，以及最近一次后台刷新任务的状态。回答问题前建议先调用本函数评估数据新鲜度。",
        parameters: {
          type: "object",
          properties: OWNER_PROPERTIES,
          additionalProperties: false,
        },
      },
    },
    {
      type: "function",
      function: {
        name: "refresh_messages",
        description:
          "按时间窗实时从飞书拉取该用户的最新原始消息并直接返回（秒级，只入库不做图谱抽取）。当 get_status 显示记忆落后于用户询问的时间范围时先调用本函数，再用检索工具查询。同一时间窗有冷却（默认 5 分钟）。",
        parameters: {
          type: "object",
          properties: REFRESH_PROPERTIES,
          required: ["start", "end"],
          additionalProperties: false,
        },
      },
    },
    {
      type: "function",
      function: {
        name: "refresh_context",
        description:
          "异步任务：拉取时间窗消息并触发事实/图谱抽取（分钟级）。立即返回任务信息，完成后通过 get_status 的 lastRefreshJob 查看结果。适用于用户询问近期动态且需要结构化事实（非仅原文）的场景。同一时间窗有冷却。",
        parameters: {
          type: "object",
          properties: REFRESH_PROPERTIES,
          required: ["start", "end"],
          additionalProperties: false,
        },
      },
    },
  ],
}
