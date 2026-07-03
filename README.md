# PM Bridge 🤖 — Teams DM ➜ AI auto-builder

Your project manager sends a task in a Microsoft Teams chat — an approval popup
appears on your machine — GitHub Copilot CLI builds it — the PM gets live status,
answers the AI's questions **in Teams**, and receives a **narrated demo video**
of the finished app. No servers, no admin rights, no custom infra: just
Power Automate + OneDrive + a PowerShell watcher.

```
PM types task in Teams DM
        │
        ▼
Power Automate flow 1 (Teams trigger ▸ Get message details ▸ Create file)
        │  <messageId>.json
        ▼
OneDrive /PMBridge/inbox  ── syncs ──▶  your laptop
        │
        ▼
watcher.ps1 (hidden engine, auto-starts at logon)
        │  🔔 popup: APPROVE + BUILD / REJECT
        ▼ approve
copilot -p "<task>" --allow-all-tools     (runs in workspace/, git-committed)
        │  📺 live progress window (PLAN ▸ every move ▸ status)
        │  ❓ QUESTION: → sent to PM in Teams; his reply resumes the session
        ▼
outbox/*.txt ──▶ flow 2 ──▶ Teams chat   (started / question / done + summary)
media/*.webm ──▶ flow 3 ──▶ share link ──▶ Teams chat   (narrated demo video)
```

## Features
- **Approval popup** (dark themed, topmost, with sound) — nothing builds without a human click; unknown senders auto-rejected via allowlist
- **Live build viewer** — green-on-black window streaming the AI's plan, architecture and every action in real time
- **Two-way Q&A over Teams** — the AI asks the PM blocking questions; the PM's next chat message resumes the same Copilot session (`--session-id`)
- **Narrated demo videos** — Playwright drives the built web app with a glowing cursor, intro/outro cards and plain-English captions that the AI writes per app (`demo-script.json`)
- **Full audit trail** — every message archived, every build a git commit, full session transcripts in `logs/`
- **Company-laptop friendly** — standard connectors only, user-scope, no admin rights, no inbound network, data stays in your M365 tenant

## Setup (~15 min)
1. **Prereqs:** Windows, [GitHub Copilot CLI](https://docs.github.com/copilot/how-tos/copilot-cli), Node.js, OneDrive for Business signed in, Chrome or Edge.
2. Clone this repo, copy `config.example.json` → `config.json`, fill in your paths + your PM's Teams display name.
3. `cd tools && npm install` (Playwright, uses your system browser — no download).
4. Create the OneDrive folders: `PMBridge/inbox`, `PMBridge/outbox`, `PMBridge/media` (right-click → *Always keep on this device*).
5. **Power Automate** (make.powerautomate.com, all Standard connectors):
   - **Flow 1 — capture:** Trigger *When a new chat message is added* ▸ *Get message details* (messageId + conversationId from trigger) ▸ Condition: `coalesce(outputs('Get_message_details')?['body/from/user/displayName'],'')` **contains** `<PM name>` ▸ True: OneDrive *Create file* to `/PMBridge/inbox`, name `concat(first(triggerOutputs()?['body/value'])?['messageId'],'.json')`, content `string(body('Get_message_details'))`
   - **Flow 2 — replies:** Trigger *When a file is created* on `/PMBridge/outbox` ▸ Teams *Post message in a chat or channel* (Post as User, your PM chat, message = File content)
   - **Flow 3 — videos:** Trigger *When a file is created* on `/PMBridge/media` ▸ OneDrive *Create share link by path* (View / People in your organization) ▸ post the Web URL to the chat
6. Run `start-watcher.cmd` once, or for silent auto-start at logon drop a `.vbs` like this in `shell:startup`:
   ```vbs
   CreateObject("Wscript.Shell").Run "powershell -NoLogo -ExecutionPolicy Bypass -WindowStyle Hidden -File ""<path>\watcher.ps1""", 0, False
   ```

Test without Teams: drop a `.txt` file with a task into the inbox folder.

## Repo layout
| file | purpose |
|------|---------|
| `watcher.ps1` | the engine: poll inbox ▸ popup ▸ build ▸ Q&A ▸ outbox/media |
| `approve.ps1` | standalone STA approval / info dialog (fail-safe: no answer ≠ reject) |
| `progress-viewer.ps1` | live tail window for the current build |
| `tools/record-demo2.js` | narrated demo-video recorder (Playwright + system Chrome/Edge) |
| `config.example.json` | template config — copy to `config.json` (git-ignored) |

## Safety model
- Sender allowlist + explicit human approval for every task
- The AI works only inside `workspace/`; every round is git-committed
- Prompt rules forbid pushing to remotes or touching outside the workspace
- Anything unparseable / unexpected goes to `rejected/`, never executed
- Share links are organization-scoped, not anonymous

## License
MIT — use at your own risk; review your company's automation & AI policies first.
