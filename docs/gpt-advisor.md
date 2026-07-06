# Union Arena GPT Advisor Integration

The local deck agent can learn from two sources:

- play results from the engine, through rankings and game ledgers;
- your Union Arena GPT, through imported advisor feedback.

## Manual Loop

1. Run `evaluate`, `optimize`, or `solve`.
2. Open the run folder.
3. Give `advisor-prompt.md` to your Union Arena GPT in ChatGPT.
4. Save the GPT's JSON response as a file, for example:

```text
work/private/deck-agent/blue-slime-run-1/union-arena-gpt-advice.json
```

5. Import the advice:

```powershell
node tools/deck-agent.mjs import-advice --advice-file work\private\deck-agent\blue-slime-run-1\union-arena-gpt-advice.json
```

6. Run `solve` or `optimize` again. The agent loads `work/private/deck-agent/advisor-memory.json` by default.

## What The GPT Should Return

`advisor-prompt.md` asks for this JSON shape:

```json
{
  "summary": "short overall take",
  "priorityCards": ["card code or id"],
  "increaseCards": ["card code or id"],
  "decreaseCards": ["card code or id"],
  "avoidCards": ["card code or id"],
  "positives": ["what looked good in testing"],
  "negatives": ["what looked bad in testing"],
  "recommendations": ["what the local agent should try next"],
  "notes": ["rules, matchup, or archetype observations"]
}
```

The importer converts recognized card codes to catalog IDs and updates card weights in advisor memory.

## Action-Based Loop

OpenAI's GPT configuration supports Actions, which let a GPT call external APIs you define. A future bridge can expose the deck agent as a small HTTP API and register that API as a GPT Action.

The local engine is not currently an internet-accessible API. ChatGPT cannot call a private local file path directly, so an action-based setup needs a reachable server or tunnel in front of the agent.

## Notes

This is not model training or fine-tuning. The Custom GPT provides strategic advice, and the local agent stores that advice as weighted memory. Actual deck selection still comes from legal deck generation plus simulated play results.
