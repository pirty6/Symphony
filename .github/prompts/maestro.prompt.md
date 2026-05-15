---
description: "Run the maestro subagent: route the prompt to a Pattern, elicit context, drive the engine through pauses to a Performance."
mode: agent
---

Invoke the `maestro` subagent on the user's request below using the `runSubagent` tool with `agentName: "maestro"`.

Pass through the user's prompt verbatim as the subagent's task description. Do not answer the user directly — delegate.

When the subagent returns, surface its final report to the user without re-summarizing or second-guessing it.

User request:
${input}
