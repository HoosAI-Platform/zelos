/**
 * core/help.mjs — "Ask Claude to walk me through this."
 *
 * A person stuck on a setup screen can hand that screen to Claude (or
 * ChatGPT) in their own browser. What they hand over is a message this file
 * writes: which screen they are on, what that screen shows, the real steps
 * at their email provider, and how to help a person who has never heard of
 * a protocol. The app opens `https://claude.ai/new?q=<the message>`, so the
 * chat starts already knowing everything Zelos knows about the step — and
 * nothing about the person.
 *
 * That last clause is the rule this file exists to keep. The message may
 * name the step, the provider (Gmail, iCloud, Outlook…), the computer (Mac,
 * Windows, Linux) and Zelos's own public pages. It must never carry the
 * person's email address, a key, a password, a file path under their home,
 * or anything read from their mail. So the inputs are closed lists — an
 * unrecognised provider becomes "unknown", an unrecognised step is refused —
 * and test/help.test.mjs reads every message this file can write and hunts
 * for an address, a key prefix, a home path.
 *
 * Pure. No I/O, no clock, no config: the same arguments give the same
 * message, which is what lets the whole space of messages be tested.
 *
 * The words on the screens are quoted from ui/views/onboarding.js and
 * ui/views/settings.js — "Pick the AI that reads your mail", "Check it
 * works", "Get an app password", "Server settings (for experts)" — so that
 * what Claude tells the person to press is what is on their screen. The
 * provider pages are the ones the app itself links: the app-password pages
 * from core/sources/imap.mjs's provider table (through `describeProvider`,
 * which is that table's public face) and the calendar pages from
 * core/server.mjs's GUIDES, handed in by the route rather than imported,
 * because server.mjs imports this file and a module that imports its own
 * importer is a thing to explain forever.
 */

import { PRESETS } from './llm.mjs';
import { describeProvider } from './sources/imap.mjs';

/** The screens a person can ask about. Anything else is refused, not guessed. */
export const HELP_STEPS = Object.freeze(['install', 'ai', 'email', 'calendar', 'first-check', 'general']);

/** The computers Zelos runs on, in the words a person uses for them. */
export const HELP_PLATFORMS = Object.freeze(['mac', 'windows', 'linux']);

/**
 * The providers the message may name. A provider is named only if it is on
 * this list; a custom domain on Workspace is "Google Workspace", and a
 * domain Zelos does not know is "unknown" — never the domain itself, which
 * is the person's.
 */
export const HELP_PROVIDERS = Object.freeze([
  'gmail', 'workspace', 'icloud', 'outlook', 'microsoft365', 'yahoo', 'aol',
  'fastmail', 'zoho', 'proton', 'unknown',
]);

/** The AIs the AI step can be asked about. `local` is a program on the person's own computer. */
export const HELP_AIS = Object.freeze(['anthropic', 'openai', 'local']);

/** The three calendars the Calendar step names. */
export const HELP_CALENDARS = Object.freeze(['google', 'icloud', 'outlook']);

/**
 * How Claude is to behave. Every message ends with these, word for word, and
 * the test for it quotes them from here rather than restating them.
 */
export const HELP_RULES = Object.freeze([
  'Go one step at a time.',
  'Use plain words.',
  'Ask what they see on screen before the next step.',
  'Never ask them to paste a password, key or code into this chat — those go only into Zelos or the provider’s own page.',
  'If something on their screen does not match, ask them to describe it.',
]);

/** The longest message the app will hand to a browser address bar. Well under every browser's limit. */
export const HELP_MAX_CHARS = 3500;

/** Where the two chats open a message that is already typed. */
const CLAUDE_NEW = 'https://claude.ai/new?q=';
const CHATGPT_NEW = 'https://chatgpt.com/?q=';

/** Zelos's own public pages — the only addresses here that are not a provider's. */
const ZELOS_DOWNLOAD = 'https://zelos-app.netlify.app/#download';

/* --------------------------------------------------------- the closed lists */

/** 'darwin' → 'mac', 'win32' → 'windows', everything else → 'linux'. What the server says about itself. */
export function platformName(raw = 'darwin') {
  const p = String(raw ?? '').trim().toLowerCase();
  if (p === 'darwin' || p === 'mac' || p === 'macos') return 'mac';
  if (p === 'win32' || p === 'windows') return 'windows';
  if (p === 'linux') return 'linux';
  return 'mac';
}

/**
 * The provider the message may name, from whatever the app called it — the
 * label the mail guess gives ("Gmail", "iCloud Mail", "Outlook / Microsoft",
 * "Google Workspace", "Microsoft 365") or one of HELP_PROVIDERS itself.
 * Anything unrecognised is "unknown", so an address or a domain sent by
 * mistake cannot reach the message.
 */
export function providerName(raw) {
  const p = String(raw ?? '').trim().toLowerCase();
  if (!p) return null;
  if (HELP_PROVIDERS.includes(p)) return p;
  if (/workspace/.test(p)) return 'workspace';
  if (/gmail|google/.test(p)) return 'gmail';
  if (/icloud|apple|\bme\b|mac\.com/.test(p)) return 'icloud';
  if (/365/.test(p)) return 'microsoft365';
  if (/outlook|microsoft|hotmail|live|msn/.test(p)) return 'outlook';
  if (/yahoo|ymail|rocketmail/.test(p)) return 'yahoo';
  if (/aol/.test(p)) return 'aol';
  if (/fastmail/.test(p)) return 'fastmail';
  if (/zoho/.test(p)) return 'zoho';
  if (/proton/.test(p)) return 'proton';
  return 'unknown';
}

/** The AI the AI step is about — the guided card's name ("Claude", "OpenAI") or a runtime's — or null for "not chosen yet". */
export function aiName(raw) {
  const p = String(raw ?? '').trim().toLowerCase();
  if (!p) return null;
  if (HELP_AIS.includes(p)) return p;
  if (/claude|anthropic/.test(p)) return 'anthropic';
  if (/openai|chatgpt|gpt/.test(p)) return 'openai';
  if (/ollama|lm studio|llama|vllm|local|this computer/.test(p)) return 'local';
  return null;
}

/** The calendar the Calendar step is about — a guide's id or title — or null for "not chosen yet". */
export function calendarName(raw) {
  const p = String(raw ?? '').trim().toLowerCase();
  if (!p) return null;
  if (HELP_CALENDARS.includes(p)) return p;
  if (/google|gmail|workspace/.test(p)) return 'google';
  if (/icloud|iphone|apple|mac/.test(p)) return 'icloud';
  if (/outlook|microsoft|hotmail|365/.test(p)) return 'outlook';
  return null;
}

/* ------------------------------------------------------------- the pages */

/** The page where a provider makes an app password, read off the provider table by a domain of the provider's own. */
function appPasswordPage(domain) {
  return describeProvider(`someone@${domain}`).appPasswordUrl || '';
}

/** A hosted AI's key page, from the one preset list the app shows. */
function keyPage(id) {
  return PRESETS.find((p) => p.id === id)?.keyUrl || '';
}

/** "at https://…" when there is a page, nothing when there is not. */
const at = (url) => (url ? ` at ${url}` : '');

/* ---------------------------------------------------------- the messages */

const PLATFORM_LINE = {
  mac: 'They are on a Mac.',
  windows: 'They are on a Windows PC.',
  linux: 'They are on a Linux computer.',
};

const WHAT_ZELOS_IS =
  'You are helping someone set up Zelos, a free program on their computer that reads email and calendars with an AI they choose. Its archive stays on their computer; source and AI requests use configured services, and update checks contact GitHub without their data. It never sends, moves or deletes mail. You are helping them through its setup screens.';

/* The Welcome screen, ui/views/onboarding.js startScreen(). */
function generalPrompt() {
  return [
    'The screen they are on: the Welcome screen, the first thing Zelos shows. The title says “Zelos reads your email and calendar, and tells you what needs you.” Under it: “It never sends, moves or deletes your mail. Your archive is stored on this computer.” There are two buttons, “Set up Zelos” and “Look around with made-up data first” (a week of invented mail, removable in one click), and a small “Skip the rest” link.',
    'Setup is five named steps along the top — Welcome, AI, Email, Calendar, Done — and every one can be skipped. Step 2, AI: pick the AI that reads the mail (Claude or OpenAI, or a program already on this computer) and paste a key from that company’s website. Step 3, Email: type the email address, and Zelos says what that provider needs — usually a special app password made on the provider’s website, never the normal password. Step 4, Calendar: Google Calendar, iCloud or Outlook. Step 5, Done: press “Read my mail now” and Zelos reads the recent mail once.',
    'Find out first what they want — to set Zelos up now, or to look around with the made-up data — and then which step they are stuck on.',
  ];
}

/* The AI step, ui/views/settings.js modelPanel() as onboarding mounts it. */
function aiPrompt(ai) {
  // The guided card's own words, for whichever card is up: settings.js's
  // GUIDED_PROVIDERS spells the key page and the create button per company.
  const company = ai === 'openai' ? 'OpenAI' : 'Anthropic';
  const friendly = ai === 'openai' ? 'OpenAI' : 'Claude';
  const create = ai === 'openai' ? 'Press Create new secret key and copy it.' : 'Press Create Key and copy it.';
  const screen = `The screen they are on: Step 2 of 5, AI (the same panel is Settings › AI). The title is “Pick the AI that reads your mail.” There are two cards, “Claude, by Anthropic — Recommended” and “OpenAI, who make ChatGPT”; if an AI program such as Ollama is already running on this computer, a card “An AI program on this computer” sits above them and needs no key. Pressing a card opens a guided card with three lines — “1. Open ${company}’s key page” (a link that opens in a new tab), “2. ${create}”, “3. Paste it here.” — a box labelled “Your key”, and one button, “Check it works”. That button stores the key, tries it, and saves; when it works the card says “Working. Zelos will use ${friendly}.” and they press “Next”. Under the card are two folded drawers, “More choices” and “Advanced”, which they do not need. A saved key is never shown again; the box then says “a key is saved — paste a new one to replace it”.`;
  const anthropic = `Getting a key from Anthropic: 1. Open Anthropic’s key page${at(keyPage('anthropic'))} — the link on the card opens it. They may have to sign in or make an account, and to add a payment method or a small amount of credit before a key will work. 2. Press “Create Key”, give it any name (“Zelos”), and copy the key; it is shown once. 3. Back in Zelos, paste it into “Your key” and press “Check it works”.`;
  const openai = `Getting a key from OpenAI: 1. Open OpenAI’s key page${at(keyPage('openai'))} — the link on the card opens it. They may have to sign in or make an account, and to add billing before a key will work. 2. Press “Create new secret key”, give it any name, and copy the key; it is shown once. 3. Back in Zelos, paste it into “Your key” and press “Check it works”.`;
  const local = 'They chose an AI program already running on this computer. There is no key and nothing leaves the computer; the card says what the program is and which model it will use. If the card says the program has nothing loaded yet, they load a model in that program first, then press “Check it works”.';
  const trouble = 'Common trouble: “Check it works” fails with a message about billing or credit — the key is fine, the account needs credit at the AI company’s site; the key was pasted with a space or a line break — paste it again; the card says “Paste the key first” — the box is empty. It is pay-as-you-go, and they can set a monthly spending cap on the AI company’s own site.';
  const steps = ai === 'anthropic' ? [anthropic]
    : ai === 'openai' ? [openai]
      : ai === 'local' ? [local]
        : ['They have not chosen a card yet; Claude is the recommended one.', anthropic, openai];
  return [screen, ...steps, ...(ai === 'local' ? [] : [trouble])];
}

/* The Email step, ui/views/settings.js mailPanel() and simpleMailForm(). */
function emailPrompt(provider, { clientReady, guides }) {
  const screen = 'The screen they are on: Step 3 of 5, Email (the same panel is Settings › Email). The title is “Connect your email.” A button “Add an email account” opens a form with one box, “Your email address”. When an address is typed, Zelos works out who provides it and shows a card named after the provider, with a plain sentence about what that provider needs. For most providers the card has a button “Get an app password” that opens the provider’s own page in a new tab, a box “App password”, and a button “Connect”. When Connect works the card says “Connected” and how many mailboxes it found. A small link, “Server settings (for experts)”, opens the full form; they do not need it unless told to below.';
  const google = clientReady
    ? 'Gmail and Google Workspace: the card shows “Sign in with Google”. Pressing it opens Google in a new tab; they pick their account and press Allow (if Google says the app is not verified, “Advanced” and then “Go to Zelos” continues). Back in Zelos the card says they are signed in; press “Connect”. If they would rather not sign in that way, “Use an app password instead” shows the app-password path below.'
    : 'Gmail and Google Workspace: Google does not let a program use the normal password, so the card asks for a 16-letter app password that Google makes just for Zelos.';
  const googlePassword = `App password from Google: 1. Press “Get an app password” — it opens Google’s app-password page${at(appPasswordPage('gmail.com'))}. They may have to sign in. 2. If Google says app passwords are not available, 2-Step Verification is off: in the Google Account, under Security, turn on 2-Step Verification (a code by text message is fine), then open the app-password page again. 3. Type a name such as Zelos and press Create. 4. Google shows 16 letters in four groups; copy them — the spaces do not matter. 5. Back in Zelos, paste them into “App password” and press “Connect”.`;
  const workspace = 'This is a work or organisation address hosted by Google, so it is Gmail underneath. If Google’s page says app passwords are turned off, their administrator has switched them off and has to allow them; Zelos cannot get around that.';
  const icloud = `iCloud Mail: Apple does not let a program use the normal password, so the card asks for an app-specific password. 1. Press “Get an app password” — it opens Apple’s account page${at(appPasswordPage('icloud.com'))}. Sign in with the Apple ID. 2. Find “Sign-In and Security”, then “App-Specific Passwords”. 3. Press the plus sign or “Generate an app-specific password”, name it Zelos, and enter the Apple ID password when asked. 4. Copy the password Apple shows (four groups of four letters with dashes). 5. Back in Zelos, paste it into “App password” and press “Connect”. Two-factor authentication has to be on for the Apple ID; it is on for nearly everyone already.`;
  const yahoo = `Yahoo Mail: the card asks for an app password. 1. Press “Get an app password” — it opens Yahoo’s page${at(appPasswordPage('yahoo.com'))}; sign in. 2. Press “Generate app password” (or “Generate and manage app passwords”), name it Zelos. 3. Copy the password Yahoo shows. 4. Back in Zelos, paste it into “App password” and press “Connect”.`;
  const aol = `AOL Mail: the card asks for an app password. 1. Press “Get an app password” — it opens AOL’s page${at(appPasswordPage('aol.com'))}; sign in. 2. Press “Generate app password”, name it Zelos. 3. Copy the password. 4. Back in Zelos, paste it into “App password” and press “Connect”.`;
  const fastmail = `Fastmail: the card asks for an app password. 1. Press “Get an app password” — it opens Fastmail’s page${at(appPasswordPage('fastmail.com'))}; sign in. 2. Press “New app password”, name it Zelos, and for what it can reach choose the “Mail” kind. 3. Copy the password. 4. Back in Zelos, paste it into “App password” and press “Connect”.`;
  const zoho = `Zoho Mail: two things. First, in Zoho Mail’s settings, under Mail Accounts, turn on the switch named “IMAP Access”. Then, if two-factor sign-in is on, an app password: press “Get an app password” — it opens Zoho’s page${at(appPasswordPage('zoho.com'))} — make one named Zelos, copy it, paste it into “App password” in Zelos and press “Connect”. If two-factor sign-in is off, the normal password goes in that box.`;
  const microsoftSignIn = 'Signing in: press “Sign in with Microsoft”. Zelos shows a short code and the address microsoft.com/devicelogin. They open that address in their browser, type the code, sign in to Microsoft as usual, and press Continue. Back in Zelos the card says it is signed in; press “Connect”.';
  const microsoftSetup = `Before that, a one-time setup at Microsoft’s website is needed — about ten minutes, no new account. The card has a “Show me how” button that opens Zelos’s own page of steps${at(guides?.microsoftSetup)}; walk them through it, then come back for the sign-in.`;
  const outlook = 'Outlook.com, Hotmail, Live or MSN: there is no password to paste. Microsoft switched password sign-in off for these accounts in September 2024, app passwords included, so the card has a “Sign in with Microsoft” button instead of a password box.';
  const microsoft365 = 'A work or school address hosted by Microsoft 365: the card has a “Sign in with Microsoft” button. Some organisations still allow a password; if the sign-in is refused by their administrator, “Server settings (for experts)” is where a password goes.';
  const proton = 'Proton Mail: Proton encrypts mail on its servers, so Zelos reads it through Proton Bridge, a program from Proton that runs on this computer. 1. Install Proton Bridge from Proton’s website and sign in to it. 2. In Bridge, open the account and its mailbox configuration; it shows a server address, a port, a username, a password of its own (not the Proton account password) and a security setting. If the security setting is STARTTLS, leave “TLS on connect” off; if it is SSL, tick it. 3. In Zelos, press “Continue with Bridge settings” and copy those four things into the form, then “Test the connection” and “Save”.';
  const unknown = 'Zelos did not recognise the provider from the address, so the card says “A provider Zelos does not know” and shows its guess at the mail server. Ask who their email is with — the company they pay, or their internet provider. 1. Try “Connect” with their normal password first; many providers accept it. 2. If that fails, the provider’s help pages say what a mail program needs — search for the provider’s name and “IMAP settings”. They list the incoming mail server (an IMAP host, usually imap. followed by the domain), the port (usually 993, with encryption on), and whether an app password is needed instead of the normal one. 3. Press “Server settings (for experts)”. The full form has the server (IMAP host), the port, the username (usually the full email address) and the password. Fill those in, press “Test the connection”, and when it passes press “Save”.';

  const byProvider = {
    gmail: [google, googlePassword],
    workspace: [google, workspace, googlePassword],
    icloud: [icloud],
    yahoo: [yahoo],
    aol: [aol],
    fastmail: [fastmail],
    zoho: [zoho],
    proton: [proton],
    outlook: [outlook, ...(clientReady ? [] : [microsoftSetup]), microsoftSignIn],
    microsoft365: [microsoft365, ...(clientReady ? [] : [microsoftSetup]), microsoftSignIn],
    unknown: [unknown],
  };
  const known = provider && byProvider[provider];
  const lead = known
    ? `Zelos has worked out that their email is with ${PROVIDER_WORDS[provider]}.`
    : 'They have not typed an address yet, or Zelos has not said who the provider is. Ask them who their email is with — Gmail, iCloud, Outlook or Hotmail, Yahoo, or something else — and then use the matching steps.';
  // With no provider known, only the shapes: the full set would run past the
  // address-bar budget, and Claude can ask which one applies.
  const steps = known ? known : [
    'Gmail: Google wants a 16-letter app password made on Google’s app-password page, with 2-Step Verification on; the card’s “Get an app password” button opens the page.',
    'iCloud: Apple wants an app-specific password, made under Sign-In and Security on the Apple account page.',
    'Outlook.com or Hotmail: no password at all — a “Sign in with Microsoft” button and a short code typed at microsoft.com/devicelogin.',
    'Yahoo, AOL, Fastmail: an app password from the provider’s security page; the card’s button opens it.',
    'Anything else: try the normal password; if refused, “Server settings (for experts)” takes the mail server the provider’s help pages list.',
  ];
  return [screen, lead, ...steps];
}

const PROVIDER_WORDS = {
  gmail: 'Gmail',
  workspace: 'Google Workspace',
  icloud: 'iCloud Mail',
  outlook: 'Outlook.com, Hotmail, Live or MSN',
  microsoft365: 'Microsoft 365',
  yahoo: 'Yahoo Mail',
  aol: 'AOL Mail',
  fastmail: 'Fastmail',
  zoho: 'Zoho Mail',
  proton: 'Proton Mail',
  unknown: 'a provider it does not recognise',
};

/* The Calendar step, ui/views/settings.js calendarPanel() and CALENDAR_GUIDES. */
function calendarPrompt(calendar, guides) {
  const pages = guides?.calendars || {};
  const screen = 'The screen they are on: Step 4 of 5, Calendar (the same panel is Settings › Calendars). The title is “Add your calendar.” Four choices: “Google Calendar”, “iPhone or Mac (iCloud)”, “Outlook”, and “Something else”. Each opens a short card with numbered steps, a box for the thing to paste, and one button, “Check it works and save”.';
  const google = `Google Calendar (goes with a Gmail address): 1. Open Google Calendar on the web${at(pages.google?.settings)} — the link on the card opens its settings. 2. On the left, under “Settings for my calendars”, click their calendar (usually their own name). 3. Scroll down to “Integrate calendar” and find “Secret address in iCal format”; press the copy button beside it. 4. Back in Zelos, paste it into “The secret address” and press “Check it works and save”. That address lets anyone holding it read the calendar, so it goes into Zelos and nowhere else.`;
  const icloud = `iPhone or Mac (iCloud): Zelos needs two things, the Apple ID email and an app-specific password. 1. Open Apple’s account page${at(pages.icloud?.appPasswords)} — the link on the card — and sign in. 2. Find “Sign-In and Security”, then “App-Specific Passwords”; press the plus sign, name it Zelos, copy the password Apple shows. 3. Back in Zelos, type the Apple ID email into “Your Apple ID email”, paste the password into “The app-specific password”, and press “Check it works and save”. Zelos already has the iCloud calendar address filled in (for experts: it is the CalDAV address${at(pages.icloud?.caldav)}, under Advanced).`;
  const outlook = `Outlook (Outlook.com, Hotmail, or a work calendar): 1. Open Outlook’s calendar on the web${at(pages.outlook?.calendar)} — the link on the card. 2. Open Settings (the gear), then Calendar, then “Shared calendars”. 3. Under “Publish a calendar”, pick the calendar, choose “Can view all details”, and press Publish. 4. Two links appear; copy the one that ends in .ics (the ICS link, not the HTML one). 5. Back in Zelos, paste it into “The ICS link” and press “Check it works and save”.`;
  const byCalendar = { google, icloud, outlook };
  const steps = calendar && byCalendar[calendar]
    ? [`They chose “${calendar === 'google' ? 'Google Calendar' : calendar === 'icloud' ? 'iPhone or Mac (iCloud)' : 'Outlook'}”.`, byCalendar[calendar]]
    : ['Ask which calendar they use, then follow the matching steps.', google, icloud, outlook];
  return [screen, ...steps, '“Something else” is for a calendar link, a calendar account, or a file on this computer, and opens the full form; most people do not need it.'];
}

/* The Done step, ui/views/onboarding.js renderOnboarding() sweep branch. */
function firstCheckPrompt() {
  return [
    'The screen they are on: Step 5 of 5, Done. The title is “Read my mail for the first time.” One button, “Read my mail now”, with a progress bar and a line of text under it; then “Go to the board” and “Skip the rest”. If an earlier step was skipped the screen says so — for example “Zelos can’t read anything yet — it still needs an AI (step 2) and an email account (step 3).” — and the button is greyed out until that step is done; the step buttons along the top go back to it.',
    'What “Read my mail now” does: Zelos fetches the recent mail (the last two weeks, by default) and the calendar, then asks the AI they chose to read through it once and sort out what needs them — replies they owe, things they are waiting on, appointments coming up. The first time takes a few minutes and is the most expensive check, because every later check reads only what is new. It marks nothing as read, moves nothing, deletes nothing and sends nothing; what it reads stays on this computer.',
    'When it finishes the line says “Done.” and a sentence about what it read, and “Go to the board” shows the result. If it says “The check stopped.” the reason is written under it; it is nearly always the email account or the AI not answering — go back to step 2 or 3 and press the check button there. After this, Zelos checks on its own every half hour during the day, which Settings › Schedule can change.',
  ];
}

/* The first open, docs/INSTALL.md. Shown on the website, not in the app — a person who can see the app is past it. */
function installPrompt(platform) {
  const download = `Zelos is downloaded from its own site${at(ZELOS_DOWNLOAD)}. These builds do not carry a verified publisher signature. A warning does not establish whether the program is safe. Use the official download and matching release checksums, and continue only if you trust this release.`;
  if (platform === 'windows') {
    return [
      'The screen they are on: the first run of the Zelos installer on Windows.',
      download,
      'First, the browser may refuse to keep the file — Edge says it “was blocked because it could harm your device”, Chrome says it “isn’t commonly downloaded”. Open the browser’s downloads list, press the three dots beside the file, choose “Keep”, then “Keep anyway”.',
      'Then, running it, a blue full-window box says “Windows protected your PC”. The button they need is not on screen yet: under the message is a small “More info” link. Press it; a “Run anyway” button appears beside “Don’t run”. Press “Run anyway”. The installer needs no administrator password, offers a Start menu entry and a desktop shortcut, and starts Zelos when it finishes. Windows does not ask again.',
    ];
  }
  if (platform === 'linux') {
    return [
      'The screen they are on: the first run of Zelos on Linux.',
      download,
      'Linux shows no warning. If the downloaded file will not start, it may need to be marked as a program: right-click it, open Properties, and under Permissions allow it to run as a program; then open it again.',
    ];
  }
  return [
    'The screen they are on: the first open of Zelos on a Mac.',
    download,
    '1. Open the downloaded disk image and drag Zelos into Applications. 2. Double-click Zelos in Applications. The Mac refuses with “Apple could not verify ‘Zelos’ is free of malware” (on older Macs, “the developer cannot be verified”) and two buttons — press “Done”, not “Move to Trash”. 3. Open System Settings, then Privacy & Security, and scroll to the bottom. A line has appeared: “‘Zelos’ was blocked to protect your Mac.” Press “Open Anyway” and confirm with Touch ID or the Mac’s password. 4. One more box asks “Are you sure you want to open it?” — press “Open”. The Mac remembers and does not ask again.',
    'If it says “Zelos is damaged and can’t be opened”, the download was altered after it was signed; download it again from the same page.',
  ];
}

/* ---------------------------------------------------------------- public */

/**
 * The message for one screen.
 *
 *   step        one of HELP_STEPS — refused otherwise
 *   provider    what the app calls the provider (mail guess label, calendar
 *               guide, AI card) — normalised to a closed list, never echoed
 *   platform    'mac' | 'windows' | 'linux', or process.platform's own name
 *   signIn      the mail guess's sign-in ('google' | 'microsoft' | null)
 *   clientReady whether this install can run that sign-in (the guess's word)
 *   guides      GET /api/guides's object, for the calendar pages — optional;
 *               without it the pages are named and not linked
 *
 * Returns { title, prompt }. `title` is the line the app puts on the link.
 */
export function helpPrompt({ step, provider = null, platform = 'mac', signIn = null, clientReady = false, guides = null } = {}) {
  if (!HELP_STEPS.includes(step)) {
    throw new TypeError(`help: unknown step ${JSON.stringify(step)} — one of ${HELP_STEPS.join(', ')}`);
  }
  const where = platformName(platform);
  const ready = clientReady === true;

  let title;
  let body;
  if (step === 'general') {
    title = 'Setting up Zelos';
    body = generalPrompt();
  } else if (step === 'ai') {
    title = 'Picking the AI that reads my mail';
    body = aiPrompt(aiName(provider));
  } else if (step === 'email') {
    title = 'Connecting my email';
    // The sign-in the guess named stands in for a provider the app did not
    // send: a Google sign-in is Gmail or Workspace, a Microsoft one is Outlook.
    const mail = providerName(provider) ?? (signIn === 'google' ? 'gmail' : signIn === 'microsoft' ? 'outlook' : null);
    body = emailPrompt(mail, { clientReady: ready, guides });
  } else if (step === 'calendar') {
    title = 'Adding my calendar';
    body = calendarPrompt(calendarName(provider), guides);
  } else if (step === 'first-check') {
    title = 'Reading my mail for the first time';
    body = firstCheckPrompt();
  } else {
    title = 'Opening Zelos for the first time';
    body = installPrompt(where);
  }

  const prompt = [
    WHAT_ZELOS_IS,
    PLATFORM_LINE[where],
    ...body,
    `How to help: ${HELP_RULES.join(' ')}`,
    'Start by asking, in one short question, what they see on the screen right now.',
  ].join('\n\n');

  if (prompt.length > HELP_MAX_CHARS) {
    // A message that outgrows the address bar is a message that silently
    // arrives cut off. Fail here, where the test runs, not in a browser.
    throw new RangeError(`help: the ${step} message is ${prompt.length} characters, over the ${HELP_MAX_CHARS} the address bar is allowed`);
  }
  return { title, prompt };
}

/**
 * The two links and the message itself, for the control in the app: the
 * link opens a chat with the message already typed; the message is what
 * "Copy this message" puts on the clipboard for when a page does not prefill.
 */
export function helpLinks(args = {}) {
  const { title, prompt } = helpPrompt(args);
  const q = encodeURIComponent(prompt);
  return {
    title,
    prompt,
    claude: `${CLAUDE_NEW}${q}`,
    chatgpt: `${CHATGPT_NEW}${q}`,
  };
}
