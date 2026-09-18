import assert from "node:assert/strict"
import test from "node:test"
import { OpenApiGateway } from "../src/tenant/openapi-gateway.js"

test("reply idempotency keys differ across stages for the same message", async () => {
  // Regression: the OpenAPI gateway previously derived its uuid from a
  // 40-char base64url prefix of "<messageId>:<stage>"; for long message ids
  // the stage fell off the end, making "processing" and "final" collide.
  // Feishu then deduplicated the final reply as a repeat of the processing
  // notice, so the user never saw the actual answer.
  const gateway = new OpenApiGateway({
    app: { appId: "cli_test", appSecret: "s" },
    getUserToken: () => null,
    refreshUserToken: () => {
      throw new Error("not used")
    },
  })
  const keyOf = (stage: "processing" | "final" | "error" | "overloaded"): string =>
    (gateway as unknown as { replyKey: (messageId: string, stage: string) => string }).replyKey(
      "om_x100b6594ad888ca0b3c7452f543915e",
      stage,
    )
  const keys = [keyOf("processing"), keyOf("final"), keyOf("error"), keyOf("overloaded")]
  assert.equal(new Set(keys).size, 4, `stage keys must be unique, got ${JSON.stringify(keys)}`)
})
