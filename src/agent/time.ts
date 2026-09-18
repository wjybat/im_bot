export interface RuntimeTimeContext {
  timezone: "Asia/Shanghai"
  now: string
  todayStart: string
}

export function shanghaiTimeContext(now = new Date()): RuntimeTimeContext {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Shanghai",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(now)
      .filter(({ type }) => type !== "literal")
      .map(({ type, value }) => [type, value]),
  )
  const date = `${parts.year}-${parts.month}-${parts.day}`
  return {
    timezone: "Asia/Shanghai",
    now: `${date}T${parts.hour}:${parts.minute}:${parts.second}+08:00`,
    todayStart: `${date}T00:00:00+08:00`,
  }
}
