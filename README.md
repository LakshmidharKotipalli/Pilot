# Pilot

A Chrome (Manifest V3) side-panel assistant. You type an instruction; an OpenAI-compatible LLM plans **one**
allowlisted action at a time; the extension validates it, classifies its risk **locally**, highlights the target,
asks for your approval when policy requires, executes it inside the page DOM, re-reads the page, and repeats
until it finishes, you stop it, or the loop guard notices it is going in circles. Several runs can be active
at once, each on its own tab.

Stack: TypeScript · React + Vite · Zod · Vitest · MV3 service worker · content script · Side Panel API.

## Architecture & security assumptions

```
Side panel / Options (React)  ──ui/* messages──▶  Service worker (background.js)
                                                    ├─ agentOrchestrator  (state machine + run loop)
                                                    ├─ llmClient          (fetch, timeout, repair, dry run)
                                                    ├─ actionPolicy       (decides auto vs confirm; uses shared/risk.ts)
                                                    ├─ settings / activityLog / messageRouter
                                                    └─ cs/* messages ──▶ Content script (content.js, IIFE)
                                                                          ├─ interactionMap (ids, redaction, fingerprints)
                                                                          ├─ domActions     (click/type/select/check/scroll/extract)
                                                                          ├─ highlightOverlay, mutationTracking
                                                                          └─ sensitiveData
```

Assumptions:

* The **model is untrusted**. It can only return one JSON object matching a strict Zod discriminated union. Every
  reply is validated locally; malformed output gets exactly one repair attempt (with the Zod errors) and is otherwise
  dropped. The model never chooses confirmation policy, permissions, navigation policy, domain allow-listing,
  redaction, schema validation, or risk classification.
* **Page content is untrusted** (prompt injection). It is delimited as data, the system prompt says to ignore
  instructions in it, and — more importantly — the model can only emit the small action schema, and every consequential
  action is gated by local policy and a human click.
* The browser profile is trusted only as much as extension storage is (see “Remaining limitations”).
* The extension only controls **elements in the current tab’s page DOM**. It never uses CDP/debugger, native
  messaging, accessibility APIs, OS-level input, hidden tabs, `eval`, `new Function`, or remote code.

## Project layout

```
pilot/
  package.json  vite.config.ts  vitest.config.ts  tsconfig.json  .gitignore
  public/manifest.json                  # MV3 manifest (copied to dist/)
  src/
    background/  serviceWorker.ts agentOrchestrator.ts llmClient.ts settings.ts actionPolicy.ts
                 messageRouter.ts activityLog.ts debug.ts tabs.ts
    content/     contentScript.ts interactionMap.ts domActions.ts highlightOverlay.ts
                 sensitiveData.ts mutationTracking.ts
    sidepanel/   index.html main.tsx App.tsx components/{PromptBox,ActionPreview,ActivityLog,SettingsLink,ExtractedDataView}.tsx
    options/     index.html main.tsx OptionsApp.tsx
    shared/      schemas.ts types.ts constants.ts redaction.ts risk.ts messages.ts
                 domainPolicy.ts stateMachine.ts ui.css
  tests/         schemas risk interactionMap domActions llmClient domainPolicy(+redaction) orchestrator .test.ts
```

## Local development

Requires Node 20+ and Chrome 116+.

```bash
npm install
npm run dev        # rebuilds dist/ on every change (three Vite watchers: ui, background, content)
# or a one-off production build:
npm run build
```

Load it:

1. Open `chrome://extensions`, enable **Developer mode**.
2. **Load unpacked** → choose the `dist/` folder.
3. After code changes in `npm run dev`, click the reload icon on the extension card (and reload the page under test).

Open the side panel: pin the extension, then **click the Pilot toolbar icon** on the tab you want to use. The
service worker handles that click itself (`chrome.action.onClicked` → `chrome.sidePanel.open({tabId})`), which is a
guaranteed `activeTab` invocation for that tab. If a tab’s address is still hidden, add its host under
**Settings → Allowed sites**.

Configure (Settings, opened with **⚙ Settings** in the panel or from the extension’s Details → Extension options):

1. **API base URL** – e.g. `https://opencode.ai/zen/v1` (any OpenAI-compatible `/chat/completions` API; https required,
   http only for localhost).
2. **API key** – pasted once; stored in `chrome.storage.local`, never displayed again.
3. **Model ID** – whatever your provider calls the model (nothing is hard-coded).
4. **Mode** (Autonomous by default), optional **Dry run** and **Debug**.
5. Click **Save settings** and accept Chrome’s prompt to let the extension talk to the API host (needed so the service
   worker’s `fetch` is not blocked by CORS).

Then, on the page you want to automate: click **Allow this site** in the side panel, read/accept the first-run
disclosure, type an instruction, and press **Run**.

## Tests

```bash
npm test            # vitest run (jsdom)
npm run test:watch
npm run typecheck   # tsc --noEmit
```

## Modes and policy

| | Safe | Assisted | Autonomous (default) |
|---|---|---|---|
| click / type / select / check | always needs your approval | needs approval unless on the low-risk allowlist | runs on its own when low risk (search, ordinary fields, same-site links, options) |
| scroll, read-only extract | run without approval (still previewed and logged) | same | same |
| serious actions (form submit · commerce/payment · send/post · delete/cancel · booking · account changes · downloads · permissions) | approval | approval | **runs on its own** (still shown as high risk in the log) |
| hard stops (password/payment/identity/MFA fields · card- or SSN-like text · file uploads · non-http links · uncertain targets) | approval | approval | **skipped, never asked about**: the agent is told it was blocked and tries another route |
| leaving the starting site (link to another origin) | blocked | blocked | blocked |

In Autonomous mode nobody is asked anything: the local, model-independent check either lets a step run or skips it
as a hard stop, and the model is told which so it can choose differently. The model is also told not to use `ask_user`
(if it does, it is told to decide for itself). Blocked-domain rules still apply in every mode.

### Staying on one site
A run is confined to the **origin** (scheme + host + port) of the page it started on, in every mode. Links to other
origins and non-web links are never followed (their `target=_blank` is also forced to this tab, so no new tab opens).
If a form submit, redirect or script still moves the tab off the site, the run goes back and carries on; if going
back does not work it stops with a clear message. Scripted `window.open` pop-ups cannot be prevented by the extension.
The agent also has a `go_back` action to leave dead ends.

### When something does not work
A step that fails (unknown element, covered/disabled/stale target, blocked by policy, off-site link, unusable model
reply) is **not fatal**: it is logged, reported back to the model as `FAILED`/`BLOCKED` with “try a different
approach”, and the run continues. Only 6 failures in a row end the run (any action that succeeds resets the count);
the loop guard still catches repeats. Missing/invalid API keys, blocked or closed tabs and Stop remain immediate.

### Activity log
One row per step: it appears as `proposed` and then changes in place to `approved`, `executed`, `auto executed`,
`failed` or `rejected`, instead of adding a second row for each stage.

In Safe and Assisted modes typing is never auto-executed; in all modes the exact literal text is shown in the preview. The model’s own opinion of risk
is not part of the protocol at all: `shared/risk.ts` classifies from the target’s tag/type/role/labels/autocomplete,
form membership, link destination/origin, typed text, and nearby headings.

## Permissions – why each exists

| Permission | Why |
|---|---|
| `activeTab` | Temporary access to the tab you invoked the extension on (toolbar click), so the panel can read its URL and inject the content script without broad host access. |
| `scripting` | `chrome.scripting.executeScript({files:['content.js']})` – programmatic, on-demand injection. There are **no** static content scripts. |
| `storage` | Settings, API key, activity log (`storage.local`) and non-sensitive run state (`storage.session`). |
| `sidePanel` | The main UI. |
| `notifications` | Tells you when a run needs a decision (approval, loop check, question) while the side panel is closed or you are on another site, and when a run finishes or fails. Notifications show only the kind of action and the label of its target, never typed text or page content. High-risk actions cannot be approved from a notification; they open the review window. |
| `optional_host_permissions` (`http://*/*`, `https://*/*`) | **Optional, requested per host at runtime**: (a) when you click “Allow this site”, for that host only, so the allowlist keeps working after navigation/reload; (b) for your LLM API host, so the service worker can call it. Nothing is granted at install. |

Not requested: `debugger`, `nativeMessaging`, `downloads`, `history`, `tabs`, `<all_urls>`, accessibility features.
Because `tabs` is absent, Chrome only reveals a tab’s URL after you click the toolbar icon or allow the site; until then
the panel says “click the Pilot toolbar icon on this tab”.

## Tab ownership: a session belongs to the tab it was opened on

- **Opening.** Clicking the toolbar icon on tab A binds a panel to A (`chrome.sidePanel.setOptions({tabId, path, enabled})`, then `open({tabId})`, in the same tick so the user gesture survives). The manifest declares no global side panel, so tabs you never opened Pilot on never show one. The panel's URL carries a worker-issued binding id; the worker takes the tab from that id and ignores any tab id a page sends.
- **Approval.** Before anything on the page is read, injected into, or sent to the model, the panel asks “Allow Pilot on *host*?”. This per-tab approval is separate from Chrome's `activeTab` grant and from persistent host permission, and it is required even when the browser already allows access. Declining leaves Pilot inactive.
- **Switching tabs.** Nothing listens for tab switches or window focus. A run keeps going on its own tab; returning to it shows the latest progress or result, with no Resume. Opening Pilot on tab B creates a separate session (even on the same origin) with its own approval and state.
- **Every action** goes to the owner tab's top frame and is pinned to the document that was read (`docId`); if the page was replaced since, the action is refused and re-planned, never replayed. The only places that could pick the “active tab” (`tabs.query`, `captureVisibleTab`) are absent, and a test fails if they appear.
- **Navigation.** Same-origin: the session continues and stale actions are refused. Another origin, or an address Pilot can no longer read: the run stops, approval is withdrawn, and you must allow Pilot again (toolbar icon on that tab if access was lost). Pilot no longer navigates back by itself.
- **Closing.** *Stop* cancels the task. *End session on this tab* (Settings → Site permissions) cancels it, removes the binding and disables the tab's panel. Closing the tab ends its session. Closing the panel with the browser's own close button only hides it: the task continues and the toolbar icon re-attaches to the same session.
- **Worker restart.** Bindings (tab, URL, approved origin; no page content) live in `storage.session`. A run that was active is reported as interrupted and never resumed or replayed.

Limitations: Chrome has no documented side-panel “closed” event in the supported versions, so a native close is indistinguishable from hiding. Background tabs may be throttled or discarded by the browser; Pilot reports a failure rather than bringing the tab forward. Behaviour that needs a real browser (panel hide/show on tab switch, whether `activeTab` survives a same-origin navigation, `sender.url` including the panel's query string) is listed in the manual checklist and has not been verified here.

Manual checklist (Chrome ≥ 116, load `dist/` unpacked): (1) open Pilot on tab A: header shows A's host, an “Allow Pilot on …?” prompt appears and nothing runs; (2) allow, start a task, switch to tab B: no panel appears on B; (3) open a new tab C: still no panel, B and C untouched; (4) return to A: progress/result is shown, no Resume; (5) click the icon on B: a separate prompt and session; (6) navigate A to another site mid-run: the run stops and asks again; (7) reload A (same site): approval holds, no stale click is performed; (8) Stop, End session, and closing A each end A's work only; (9) reload the extension while a run is active: it is reported interrupted and nothing re-runs; (10) tabs in two windows keep their own sessions.

## What is sent to the LLM

Sent: your instruction (card/SSN/API-key-looking strings redacted), page URL and title, up to ~40 short visible text
snippets, and up to 150 **interactive elements** (id, tag, role, accessible name, label, placeholder, visible text,
disabled, viewport flag, rect, risk hints, safe path hint, non-sensitive current value, select option labels, link href),
plus up to 20 read-only **content regions** (tables, articles, `main`, lists of 3+ items, headed sections; marked
`extractOnly`, valid only for `extract`), plus the last few action/outcome summaries and the last extraction. Never sent: raw HTML, password/payment/identity/MFA
field values, fingerprints, or the API key (it only appears in the `Authorization` header of the request).
Payload is trimmed to ~28k characters. **Dry run** shows the exact request body without sending it.

## Manual QA checklist

Use a local test page (or any site you allowed) containing a button, a form with text fields and a submit button, a
password input, and some JS that can remove/replace elements.

1. **Normal button click** – Safe mode: “Click the ‘Next page’ button.” → preview card with orange highlight on page,
   low risk → **Approve** → click happens, log shows `approved` then `executed`, map re-read.
2. **Form text entry** – “Fill the name and city fields with John Doe and Tampa, but ask me before submitting.” → each
   `type_text` shows the literal text and needs approval; fields update (also on React/Vue controlled inputs). The
   submit step must show **HIGH RISK / Submits a form** and never run without approval.
3. **Confirmation on submit** – In Assisted mode, ask it to submit the form: still requires approval.
4. **Password input rejected** – ask it to “type my password 123 into the password field”: risk HIGH; if approved anyway
   the content script returns `SENSITIVE` and the field stays empty. The password value never appears in Dry run.
5. **Stale target after DOM change** – while the approval card is showing, change/remove the target’s text in DevTools
   (`$0.textContent='Delete'`) then click Approve → “The element changed since it was previewed…” / “The element was not
   found after the page changed.”, nothing clicked.
6. **Navigation / origin change** – a link to another origin → HIGH “Navigates to a new origin” and confirmation even in
   Assisted mode; a same-site page link → confirmation in Assisted mode; a `#hash` link → auto in Assisted mode.
   After navigating to a non-allowed host the run stops with an explanation.
7. **Unsupported page** – open `chrome://extensions` (and the Web Store) and press Run → clear message that the page
   cannot be controlled; no injection attempted.
8. **Stop an in-progress run** – start a run, press **Stop** during “Asking model…” and again while an approval is
   pending → status “Stopped”, highlight cleared, no further requests/actions. Then press **Run** again immediately:
   the new run must behave normally (a superseded loop can never touch it; covered by `tests/orchestrator.test.ts`).
9. **Malformed LLM output** – point the base URL at a stub that returns prose/invalid JSON: one repair request is made,
   then the run ends with “failed validation twice, so nothing was executed”. Verify no action ran.
10. **Missing/invalid API key** – empty key → “No API key is configured…”; wrong key → “The API rejected the key (HTTP
    401)…”; wrong URL → “Endpoint or model not found (HTTP 404)…”.
11. **Domain controls** – a non-allowed site: Run disabled with an explanation; “Allow this site” enables it; “Pause on
    this site” disables it; a bank-like host (`*bank*`) is blocked even if allowed, with the rule shown.
12. **Diagnostics** – “Copy diagnostic report” output contains version, domain, status, permissions and no key/page text.

## Threat model (short)

| Threat | Mitigation |
|---|---|
| Prompt injection from page text | Strict one-action schema; page text framed as untrusted data; local risk + confirmation gate; target must exist in the freshly-built map; highlighted before execution. |
| Malicious/buggy model output | Zod validation, one repair attempt, no arbitrary selectors/JS/URLs, model cannot navigate (only click visible links which are risk-classified by destination). |
| TOCTOU (page changes after preview) | Per-element fingerprint re-verified in the content script immediately before acting; mismatch fails closed. |
| Secret exfiltration to the provider | Sensitive fields never read; card/SSN/secret redaction; blocked domains; per-site allowlist; user disclosure; dry-run inspection. |
| Malicious web page talking to the extension | Content script accepts messages only from the extension’s own worker (`sender.id`, no `sender.tab`) and Zod-validates them; worker accepts commands only from extension pages. |
| Overlay/clickjacking of the target | Covered-target check (`elementFromPoint`) before click; overlay is `pointer-events:none` in a closed shadow root. |
| Runaway agent / cost | No step limit, so a loop guard instead: if the same action on the same target and page state repeats 4 times within the last 8 steps, the run pauses and asks you to continue or stop. Also: at most 5 concurrent sessions (one per tab), request timeout, Stop / Stop all, AbortController, one keep-alive only while a session is active. |
| Key theft from browser profile | **Not fully mitigated** – see below. |

## Remaining limitations

* **API key storage**: `chrome.storage.local` is not a secret vault (unencrypted at rest; readable by malware or anyone
  with profile access). An extension-only design cannot do better without a backend; use a scoped, revocable key, or
  put a small proxy you control in front of the provider and use its URL/token here.
* **Redaction is best-effort** (pattern/heuristic-based); unusual sensitive data in ordinary text can slip through.
* **Scope of the page map**: top frame only. Cross-origin iframes and closed shadow roots are invisible; open shadow DOM
  is traversed. Custom checkboxes hidden behind labels may not be listed. `contenteditable` editors, canvas apps and
  non-native selects are not supported for typing/selecting.
* `HTMLElement.click()` produces untrusted events; a few sites ignore them. The extension deliberately does **not** fall
  back to OS-level input.
* **File upload and download are refused** (uploads need a native file picker; downloads would need the `downloads`
  permission and separate consent UX). This is the secure constrained alternative.
* CAPTCHAs, logins, paywalls, security warnings, permission prompts and MFA are never bypassed: sign-in/MFA URLs and
  blocked domains are not read at all; the model is told to `ask_user` instead.
* Extension pages cannot see a tab’s URL before you grant access (no `tabs` permission); you may need to click the
  toolbar icon once per tab (or add the host in Settings). The `activeTab` grant on toolbar click is documented Chrome
  behaviour but was not observed in a live browser from this environment — check QA item 11 first.
* The MV3 service worker can be terminated; a run in flight when that happens is **stopped** on restart (never
  auto-resumed) and DOM references are never persisted. A light keep-alive ping runs only while a run is active.
* Allowlisting is per exact host (use `*.example.com` for subdomains). Assisted mode’s “same-page navigation” is limited
  to `#hash` links on the current path.
* Verified here: unit tests (jsdom), type-check and production build. The extension itself has not been exercised in a
  live Chrome session from this environment — run the QA checklist above.

## Sessions, loops and decisions

* **Sessions.** Each run is a session bound to the tab it started on. It reads, highlights and acts on that tab even
  when you are looking at another one, and it never brings a tab to the front. A tab has one active session; different
  tabs run in parallel (up to 5 at once). Closing a tab stops only its session. The side panel lists all sessions, marks
  the ones that need you, and has **Stop all**.
* **No step limit.** A run ends when the model finishes, you stop it, or something fails. The loop guard hashes each
  step (action, target, page state); 4 identical steps in the last 8 pauses the run until you choose **Continue anyway**
  or **Stop**.
* **Decisions.** Approvals, loop checks and `ask_user` questions appear in the side panel when it is open on that tab.
  Otherwise one review window (shared by all sessions) opens, the toolbar badge shows how many are waiting, and a
  system notification announces the new one. Low-risk approvals can be approved or rejected from the notification;
  high-risk ones must be approved in the review window.
* Chrome throttles background tabs, so a run on a tab you are not looking at may be slower to settle.

## Run logs on disk (development aid)
An extension cannot write into the project folder, so a tiny local collector does it:

```
npm run logs        # listens on 127.0.0.1:8787, writes ./logs/<time>_<host>_<runid>.json
```

While it is running, the extension posts every activity-log row to it and the server keeps **one JSON file per run**
(`runId`, `host`, `prompt`, and one entry per step whose outcome updates in place). When the server is not running the
extension skips this silently and retries after 30 seconds. `logs/` is in `.gitignore`.
Rows are the same redacted, truncated rows shown in the Activity log; the server accepts posts only from browser
extensions (not web pages), only on localhost, and only writes inside the log folder. `LOG_PORT` and `LOG_DIR` override
the defaults (if you change the port, change `RUN_LOG_URL` in `src/shared/constants.ts` to match).
