export const EXTENSION_NAME = 'WebPilot Agent';

export const DEFAULT_API_BASE_URL = 'https://opencode.ai/zen/v1';

// Page-map / payload limits
export const MAX_ELEMENTS = 150;
export const MAX_CANDIDATES_SCANNED = 1500;
export const MAX_SHADOW_SCAN_NODES = 4000;
export const MAX_TEXT_SNIPPETS = 40;
export const MAX_SNIPPET_CHARS = 200;
export const MAX_VISIBLE_TEXT_CHARS = 3000;
export const MAX_NAME_CHARS = 100;
export const MAX_VALUE_CHARS = 80;
export const MAX_NEARBY_CHARS = 160;
export const MAX_SELECT_OPTIONS = 30;
export const MAX_CONTEXT_CHARS = 28_000;

// Extraction limits
export const MAX_EXTRACT_CHARS = 8000;
export const MAX_EXTRACT_ROWS = 100;
export const MAX_EXTRACT_COLS = 20;
export const MAX_EXTRACT_LINKS = 100;
export const MAX_TYPE_TEXT_CHARS = 2000;

// Runtime
export const LLM_TIMEOUT_MS = 60_000;
export const LOG_LIMIT = 200;
export const HISTORY_LIMIT = 6;
export const KEEPALIVE_MS = 20_000;
export const SETTLE_MS = 500;
export const AUTO_PREVIEW_MS = 800;
// Concurrency / loop detection
export const MAX_CONCURRENT_SESSIONS = 5;
export const LOOP_WINDOW = 8;
export const LOOP_REPEATS = 4;
/** Recoverable failures in a row (bad target, blocked, failed action...) before the run gives up. */
export const MAX_CONSECUTIVE_FAILURES = 6;
/** Where `npm run logs` listens; the extension posts each activity-log row here when it is running. */
export const RUN_LOG_URL = 'http://127.0.0.1:8787/log';
/** Name of the port a side panel keeps open while it is alive. */
export const PANEL_PORT = 'webpilot-panel';
export const NAVIGATION_WAIT_MS = 10_000;

export const STORAGE_KEYS = {
  settings: 'wp_settings',
  apiKey: 'wp_api_key',
  log: 'wp_activity_log',
  disclosure: 'wp_disclosure_ack',
  runs: 'wp_run_states',
  bindings: 'wp_tab_bindings',
  lastError: 'wp_last_error',
} as const;

export const SCROLL_FRACTION = { small: 0.3, medium: 0.6, large: 0.9 } as const;

/** Local, model-independent high-risk vocabulary (case-insensitive, word-bounded). */
export const HIGH_RISK_KEYWORDS: ReadonlyArray<{ category: string; pattern: RegExp }> = [
  {
    category: 'commerce',
    pattern:
      /\b(?:buy\w*|purchas\w*|order\w*|check\s?out|pay\w*|donat\w*|add\s+to\s+(?:cart|bag|basket)|continue\s+to\s+payment)\b/i,
  },
  { category: 'publish', pattern: /\b(?:submit\w*|send\w*|post(?:ed|ing)?|publish\w*|share\w*)\b/i },
  {
    category: 'destructive',
    pattern:
      /\b(?:delet\w*|remov\w*|cancel\w*|unsubscrib\w*|terminat\w*|close\s+(?:my\s+)?account|deactivat\w*|block\w*|report\w*)\b/i,
  },
  {
    category: 'auth',
    pattern:
      /\b(?:log\s?in|sign\s?in|sign\s?out|log\s?out|logout|password\w*|passcode\w*|verif\w*|code\w*|otp)\b/i,
  },
  { category: 'finance', pattern: /\b(?:transfer\w*|withdraw\w*|deposit\w*|trad(?:e|es|ing)|sell\w*|invest\w*)\b/i },
  { category: 'booking', pattern: /\b(?:book\w*|reserv\w*|confirm\w*)\b/i },
  { category: 'file', pattern: /\b(?:download\w*|upload\w*|attach\w*)\b/i },
  { category: 'permission', pattern: /\b(?:allow\w*|permit\w*|grant\w*|authori[sz]\w*)\b/i },
  {
    category: 'account',
    pattern:
      /\b(?:save\s+changes|update\s+profile|change\s+password|appl(?:y|ies|ying)|accept\w*|agree\w*|subscrib\w*)\b/i,
  },
];

/** Nearby-text contexts that make a control on the page more dangerous. */
export const CONTEXT_KEYWORDS: ReadonlyArray<{ category: string; pattern: RegExp }> = [
  {
    category: 'commerce',
    pattern: /\b(?:checkout|payment|billing|credit\s+card|card\s+number|order\s+summary|shopping\s+cart)\b/i,
  },
  { category: 'account', pattern: /\b(?:account\s+settings|privacy|security\s+settings|two-factor|2fa)\b/i },
  { category: 'auth', pattern: /\b(?:sign\s?in|log\s?in|password|verification\s+code)\b/i },
];

/** Field name/label/autocomplete hints that mark an input as sensitive. */
export const SENSITIVE_FIELD_REGEX =
  /(?:passw(?:or)?d|passcode|\bpin\b|\bcvv\b|\bcvc\b|\bcsc\b|card[-_ ]?(?:number|no|num)|cc[-_ ]?(?:num|number|exp|csc|name|type)|\bccnum\b|\biban\b|\brouting\b|account[-_ ]?(?:number|no)|\bssn\b|social[-_ ]?security|tax[-_ ]?id|national[-_ ]?id|passport|\botp\b|one[-_ ]?time|verification|2fa|\bmfa\b|auth(?:entication)?[-_ ]?code|security[-_ ]?(?:code|answer)|\bsecret\b|api[-_ ]?key|\btoken\b|date[-_ ]?of[-_ ]?birth|\bdob\b|current-password|new-password)/i;

/** Hostname patterns (glob, `*` wildcard) that are blocked by default. */
export const DEFAULT_BLOCKED_DOMAIN_PATTERNS: readonly string[] = [
  // banking / payments / brokerage / crypto
  '*bank*',
  '*.paypal.com',
  '*.venmo.com',
  '*.chase.com',
  '*.wellsfargo.com',
  '*.citi.com',
  '*.capitalone.com',
  '*.americanexpress.com',
  '*.schwab.com',
  '*.fidelity.com',
  '*.vanguard.com',
  '*.coinbase.com',
  '*.stripe.com',
  // healthcare
  '*mychart*',
  '*patientportal*',
  '*.epic.com',
  '*health*portal*',
  // identity / government identity
  'id.me',
  '*.id.me',
  '*.login.gov',
  '*.irs.gov',
  '*.ssa.gov',
  '*onfido*',
  '*idverif*',
  // password managers / identity providers
  '*1password*',
  '*lastpass*',
  '*bitwarden*',
  '*dashlane*',
  '*keepersecurity*',
  '*.okta.com',
  '*.auth0.com',
  'accounts.google.com',
  'login.microsoftonline.com',
  'login.live.com',
  'appleid.apple.com',
];

/** URL path fragments that indicate sign-in / identity / MFA flows. */
export const DEFAULT_BLOCKED_PATH_REGEX =
  /\/(?:log-?in|sign-?in|signin|sso|oauth\w*|mfa|2fa|verify-identity|identity-verification|kyc|banking)(?:[/?#]|$)/i;

export const UNSUPPORTED_PROTOCOLS: readonly string[] = [
  'chrome:',
  'chrome-extension:',
  'chrome-untrusted:',
  'chrome-search:',
  'devtools:',
  'edge:',
  'about:',
  'view-source:',
  'file:',
  'data:',
  'blob:',
  'javascript:',
  'ftp:',
];

export const UNSUPPORTED_HOSTS: readonly string[] = ['chromewebstore.google.com', 'chrome.google.com'];
