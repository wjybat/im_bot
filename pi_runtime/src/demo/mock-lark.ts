import type {
  CardActionConsumerCallbacks,
  LarkGateway,
  MessageConsumer,
  MessageConsumerCallbacks,
  OwnerIdentity,
} from "../types.js"

export class MockLarkGateway implements LarkGateway {
  readonly calls: Array<{ method: string; input: unknown }> = []

  private record(method: string, input: unknown): void {
    this.calls.push({ method, input })
  }

  private messageFixture(): unknown {
    return {
      has_more: false,
      total: 3,
      messages: [
        {
          message_id: "internal-demo-1",
          chat_id: "internal-chat-1",
          chat_type: "group",
          chat_name: "项目群",
          create_time: "2026-08-25T09:15:00+08:00",
          sender: { name: "林同事" },
          content: "请你今天确认一下消息分页和去重方案。",
        },
        {
          message_id: "internal-demo-2",
          chat_id: "internal-chat-2",
          chat_type: "group",
          chat_name: "产品讨论群",
          create_time: "2026-08-25T10:05:00+08:00",
          sender: { name: "周同事" },
          content: "Demo 演示时间能确认一下吗？",
        },
        {
          message_id: "internal-demo-3",
          chat_id: "internal-chat-3",
          chat_type: "p2p",
          chat_name: "陈同事",
          create_time: "2026-08-25T10:20:00+08:00",
          sender: { name: "陈同事" },
          content: "收到，刚才的问题已经解决，不用再处理。",
        },
      ],
    }
  }

  async check(): Promise<OwnerIdentity & { version: string }> {
    return {
      ownerOpenId: "redacted-demo-owner",
      ownerName: "Demo Owner",
      botName: "Pi Demo Bot",
      botAppId: "cli_demo_bot",
      tokenStatus: "mock",
      version: "mock-lark-cli",
    }
  }

  async ensureUserIdentity(): Promise<OwnerIdentity> {
    const { version: _version, ...identity } = await this.check()
    return identity
  }

  async searchMessages(input: unknown): Promise<unknown> {
    this.record("searchMessages", input)
    return this.messageFixture()
  }

  async getMessagesByIds(messageIds: string[]): Promise<unknown> {
    this.record("getMessagesByIds", messageIds)
    const fixture = this.messageFixture() as { messages: Array<Record<string, unknown>> }
    return { messages: fixture.messages.filter((item) => messageIds.includes(String(item.message_id))) }
  }

  async listChatMessages(input: unknown): Promise<unknown> {
    this.record("listChatMessages", input)
    return { has_more: false, messages: [] }
  }

  async listThreadMessages(input: unknown): Promise<unknown> {
    this.record("listThreadMessages", input)
    return { has_more: false, messages: [] }
  }

  async getAgenda(input: unknown): Promise<unknown> {
    this.record("getAgenda", input)
    return { events: [] }
  }

  async getIncompleteTasks(input: unknown): Promise<unknown> {
    this.record("getIncompleteTasks", input)
    return { has_more: false, items: [] }
  }

  async runReadOnlyCli(args: string[]): Promise<{ stdout: string }> {
    this.record("runReadOnlyCli", args)
    return { stdout: JSON.stringify({ ok: true, identity: "user", data: this.messageFixture() }) }
  }

  async replyToMessage(
    _messageId: string,
    _markdown: string,
    _stage?: "processing" | "final" | "error" | "overloaded",
  ): Promise<void> {
    throw new Error("mock demo never performs external writes")
  }

  startMessageConsumer(_callbacks: MessageConsumerCallbacks): MessageConsumer {
    throw new Error("mock demo does not start an event consumer")
  }

  async sendCardMessage(_input: { userOpenId: string; card: unknown }): Promise<{ messageId: string }> {
    throw new Error("mock demo never performs external writes")
  }

  startCardActionConsumer(_callbacks: CardActionConsumerCallbacks): MessageConsumer {
    throw new Error("mock demo does not start an event consumer")
  }
}
