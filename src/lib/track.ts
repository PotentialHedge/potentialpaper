/**
 * Product events for Umami (`window.umami.track`), as acceptodds sends them, for funnels: where people leave
 * sign-up and sign-in, and what they do on a paper once they are in. Page views are counted by the tracker
 * itself (`components/Analytics.tsx`); these are the actions in between.
 *
 * Event data is **not personal, by construction**: only the fields in `EventData`, each a short code, a flag or a
 * small number. Never an email, handle, name, id, query or text someone typed (the one exception, `domain`, is
 * only the part after the @ of an address refused because its domain isn't on the institution list). The page URL is filtered in
 * `lib/analytics.ts` for the same reason, and events must not be a way around it. Add a field only if it is as
 * harmless as the ones already there.
 *
 * Does nothing server-side, before the tracker has loaded (it retries for a few seconds, since the script is added
 * after hydration), or when analytics is off.
 */

export type EventName =
  // /welcome: each step of the tour reached, the address sent or refused
  | 'tour_step'
  | 'signup_submitted'
  | 'signup_refused'
  // /signin, and a reset link's /set-password
  | 'signin_succeeded'
  | 'signin_failed'
  | 'signin_link_requested'
  | 'signin_link_refused'
  | 'password_reset_requested'
  | 'password_set'
  | 'password_set_failed'
  | 'signed_out'
  // the code from the mail (`CodeEntry`)
  | 'code_confirmed'
  | 'code_failed'
  | 'code_resent'
  // /verify-email once confirmed: what is owed, each part of it done, and all of it done or skipped
  | 'finish_shown'
  | 'finish_step'
  | 'finish_completed'
  // the "Confirm your email" banner across the site while a sign-up waits for its code
  | 'confirm_banner_clicked'
  | 'confirm_banner_dismissed'
  // the home page's [getting started] and [onboard your agent]: opened, each step first reached (2 onwards), its
  // last button
  | 'tutorial_opened'
  | 'tutorial_step'
  | 'tutorial_finished'
  // a prompt for an AI agent copied (`target` says where), and an agent's connection answered
  | 'agent_prompt_copied'
  | 'agent_connect_approved'
  | 'agent_connect_declined'
  // following a page
  | 'follow_toggled'
  // a prompt to sign in followed by a signed-out reader; `target` says which: 'follow' (the star), 'views' (the
  // blurred view count), 'comment' ("Sign in to comment"), 'add_version' (/new/paper's "Sign in to add as a
  // version"), 'nav' (the header's "sign in"), 'plugins' (/settings/plugins), 'plugin_consent' (a plugin panel asking
  // for approval). With `signup_submitted` and
  // `signin_succeeded` after it in the same session, a funnel shows which prompts bring people in.
  | 'signin_prompt_clicked'
  // one of those prompts on screen, once a page view (`trackSeen`); same `target`s. The header's "sign in" is on
  // every page, so its views are the page views and it is left out
  | 'signin_prompt_shown'
  // a prompt to claim a page followed; `target`: 'analytics' (the locked Analytics tab's button), 'banner' ("Is
  // this your paper?" over its sections), 'owners' (the link in the owners' line). The locked tab itself being
  // opened is `tab_opened` with target 'analytics_locked'.
  | 'claim_prompt_clicked'
  | 'claim_prompt_shown'
  // a search's results shown (`count` of them, `step` the page, `on` whether a venue filter is set), never its words;
  // and a row of a list followed (`target` 'search' | 'browse', `position` from 1 across pages, `kind` 'internal' for
  // its page or 'external' for its PDF)
  | 'search_shown'
  | 'result_opened'
  // the search box's example searches (`lib/search-examples.ts`): one shown in its placeholder, once a page view each,
  // and one filled in with Tab or →; a search run that is one of them is `search_shown` with its `example`
  | 'search_example_shown'
  | 'search_example_used'
  // a section of a page scrolled to, once a page view (`target` its id: 'submissions', 'discussion', …)
  | 'section_reached'
  // the BibTeX copied (`PageActions`)
  | 'bibtex_copied'
  // sharing: the popover opened, a link copied (`target`), a service's share page opened
  | 'share_opened'
  | 'share_copied'
  | 'share_sent'
  // reading a paper: its blurred reviews shown, a review's text opened, a comment list opened or shown in full, a
  // section folded or unfolded. PDF and source links are counted by `data-umami-event` on the links themselves
  // ('pdf_opened', 'source_opened').
  | 'reviews_unblurred'
  | 'review_opened'
  | 'review_comments_opened'
  | 'review_comments_more'
  | 'section_toggled'
  // a link in what a page's people wrote followed (`trackLinks`): `target` is where (a `LinkArea`:
  // 'abstract', 'title_links', 'versions', 'comment', …), `kind` whether it leads off the site, to this site, or within the page,
  // `domain` the other site's host
  | 'link_followed'
  // the discussion under a page
  | 'comment_previewed'
  | 'comment_posted'
  | 'comment_failed'
  | 'comment_removed'
  | 'comment_reply_opened'
  // something typed in a comment box (`target` 'top' | 'reply'), and the box left with it unposted (the page closed
  // or navigated away, or a reply cancelled)
  | 'comment_started'
  | 'comment_abandoned'
  // editing: the dialog opened, the web editor opened from it, the clone or extension command copied, a commit made
  // in the web editor, a revert, a picture dropped in
  | 'edit_opened'
  | 'edit_web_opened'
  | 'edit_clone_copied'
  | 'extension_command_copied'
  | 'edit_saved'
  | 'edit_reverted'
  | 'edit_revert_refused'
  | 'picture_added'
  // "Add …?" on a paper (a version, a demo, a picture, …): opened, and "Edit myself" taken instead of the prompt
  | 'missing_opened'
  | 'missing_edit_myself'
  // claiming a paper (or a venue as its organiser): each step done, or refused (`target` names the step)
  | 'claim_step'
  | 'claim_refused'
  // the profile: edited, an institution address added, confirmed or removed, mail settings, keys
  | 'profile_edit_opened'
  | 'profile_saved'
  | 'affiliation_step'
  | 'affiliation_refused'
  | 'mail_setting_changed'
  | 'api_key_created'
  | 'api_key_revoked'
  | 'ssh_key_added'
  // plugins on pages: a frame started (`target` is its surface: 'panel' | 'rows' | 'popover' | 'page' | …), a command
  // run from a panel's ⋯ or a row's, a link it opened, its approval asked on a page and put off; a tab chosen among a
  // page's panels (built-in or a plugin's)
  | 'plugin_started'
  | 'plugin_command_run'
  | 'plugin_link_opened'
  | 'plugin_consent_dismissed'
  | 'tab_opened'
  // a page's Repo tab: a folder opened (`step` its depth, 0 for the top), a file opened (`target` what it shows as:
  // 'section' | 'readme' | 'markdown' | 'json' | 'text' | 'pdf' | 'image' | 'other'), never its path;
  // the web editor opened from it at a file (`repo_edit_opened`). Its "Clone or edit" opens the Edit dialog, counted as `edit_opened`
  | 'repo_folder_opened'
  | 'repo_file_opened'
  | 'repo_edit_opened'
  // managing plugins (`lib/plugins/client.ts`, so from wherever it is done), and settings
  | 'plugin_installed'
  | 'plugin_install_refused'
  | 'plugin_removed'
  | 'plugin_toggled'
  | 'plugin_approved'
  | 'plugin_revoked'
  | 'plugin_updated'
  | 'plugin_dev_added'
  | 'settings_imported'
  // new pages made by hand
  | 'category_created'
  | 'department_created'
  // "Report a problem" followed
  | 'problem_report_opened'
  // the home page's announcements: a link in one followed, or one closed with its ×
  | 'announcement_clicked'
  | 'announcement_dismissed';

export interface EventData {
  /** A refusal or failure: the error code or HTTP status, never its message. */
  reason?: string;
  /**
   * An address refused because its domain is not on the institution list: that domain (`gmail.com`), never the
   * address, so the list can grow where people are turned away.
   */
  domain?: string;
  /** A followed link: 'external' (then `domain` is its host, like `github.com`: published, about no one) | 'internal' | 'anchor'. */
  kind?: 'external' | 'internal' | 'anchor';
  /** Follow: whether the page is now followed. */
  following?: boolean;
  signedIn?: boolean;
  /** A switch's new state: a plugin turned on, a section unfolded, a comment posted anonymously. */
  on?: boolean;
  needsName?: boolean;
  needsPassword?: boolean;
  /**
   * A short code from our own vocabulary, never anything a person typed: what was copied ('link' | 'badge' |
   * 'invite' | 'review' | 'comment'), a share service ('x' | 'bluesky' | …), where an agent prompt was ('onboard' |
   * 'tutorial' | 'edit' | 'missing' | 'plugins'), a Finish or claim step, a section's slot id, what was missing
   * ('version' | 'demo' | …), a mail setting's field, a picture's file type.
   */
  target?: string;
  /** A tour or tutorial step: the tour's step name, or the tutorial's step counted from 1. */
  step?: number | string;
  /**
   * A plugin's id (`owner/repo` of its public repository): published code, like `announcement`, not a person. A
   * dev plugin's localhost address is never sent.
   */
  plugin?: string;
  /** An announcement's id: the admin's message, about no one. */
  announcement?: string;
  /** How many results a search found. */
  count?: number;
  /** A followed row's place in its list, counted from 1 across its pages. */
  position?: number;
  /** One of the search box's example searches, by its id (`lib/search-examples.ts`): our words, not a reader's. */
  example?: string;
}

type Umami = { track: (name: string, data?: Record<string, unknown>) => unknown };

const ATTEMPTS = 20;
const RETRY_MS = 500;

export function track(name: EventName, data?: EventData, attempt = 0): void {
  if (typeof window === 'undefined') return;
  try {
    const umami = (window as unknown as { umami?: Umami }).umami;
    if (umami) {
      // Umami's `track` returns a Promise, whatever its type says: never pass it on, or an effect written as
      // `useEffect(() => track(…))` hands React a Promise as its cleanup, which throws on unmount.
      void Promise.resolve(umami.track(name, data as Record<string, unknown> | undefined)).catch(() => {});
      return;
    }
    // Analytics off or not loaded yet; give the script a few seconds.
    if (attempt < ATTEMPTS) setTimeout(() => track(name, data, attempt + 1), RETRY_MS);
  } catch {
    // Analytics never raises into the page.
  }
}

/** A plugin as events name it: its id, or 'dev' for one served from the reader's own machine, unpublished. */
export function pluginLabel(p: { from: string; plugin?: { id: string } | null }): string | undefined {
  return p.from === 'dev' ? 'dev' : p.plugin?.id;
}

/** Where a link sits, for `link_followed`: set as `data-link-area` on the element around what people wrote. */
export type LinkArea =
  | 'abstract'
  | 'owners'
  | 'community'
  | 'comment'
  | 'review'
  // the paper's own furniture: its authors' names, [arXiv] [code] … under the title, the infobox, the versions
  | 'authors'
  | 'title_links'
  | 'facts'
  | 'versions';

/**
 * Counts links followed out of what people wrote (`data-link-area`): one listener for the whole document, since that
 * text is Markdown rendered to HTML, with no component per link. A click, a middle-click or ⌘/Ctrl-click; links that
 * count themselves (`data-umami-event`) are left to that. Returns its cleanup.
 */
export function trackLinks(): () => void {
  const onClick = (e: MouseEvent) => {
    if (e.button > 1 || !(e.target instanceof Element)) return;
    const link = e.target.closest<HTMLAnchorElement>('a[href]');
    if (!link) return;
    let url: URL;
    try {
      url = new URL(link.href, window.location.href);
    } catch {
      return;
    }
    const here = window.location;
    const external = url.origin !== here.origin;
    const anchor = !external && url.pathname === here.pathname && url.search === here.search && !!url.hash;
    const row = link.closest<HTMLElement>('[data-rank]');
    const list = row?.dataset.resultList;
    if (row && list) {
      return track('result_opened', {
        target: list,
        position: Number(row.dataset.rank),
        kind: external ? 'external' : 'internal',
      });
    }
    const area = link.closest<HTMLElement>('[data-link-area]')?.dataset.linkArea;
    if (!area || link.closest('[data-umami-event]')) return;
    track('link_followed', {
      target: area,
      kind: external ? 'external' : anchor ? 'anchor' : 'internal',
      ...(external && { domain: url.hostname.replace(/^www\./, '') }),
    });
  };
  document.addEventListener('click', onClick, true);
  document.addEventListener('auxclick', onClick, true);
  return () => {
    document.removeEventListener('click', onClick, true);
    document.removeEventListener('auxclick', onClick, true);
  };
}

/** What `data-seen-event` may name. */
const SEEN_EVENTS: ReadonlySet<string> = new Set<EventName>([
  'signin_prompt_shown',
  'claim_prompt_shown',
  'section_reached',
]);

/**
 * Counts what was on screen: an element with `data-seen-event` (and `data-seen-target`), once a page view, when at
 * least half of it is in view. Works from Server Components, as `data-umami-event` does for clicks, and for elements
 * added later (a prompt rendered once the viewer is known, a section unfolded). Returns its cleanup.
 */
export function trackSeen(): () => void {
  if (typeof IntersectionObserver === 'undefined') return () => {};
  let path = window.location.pathname;
  const sent = new Set<string>();
  const watched = new WeakSet<Element>();
  const seen = new IntersectionObserver(
    (entries) => {
      if (window.location.pathname !== path) {
        path = window.location.pathname;
        sent.clear();
      }
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const el = entry.target as HTMLElement;
        const name = el.dataset.seenEvent ?? '';
        const target = el.dataset.seenTarget;
        const key = `${name} ${target}`;
        seen.unobserve(el);
        if (!SEEN_EVENTS.has(name) || sent.has(key)) continue;
        sent.add(key);
        track(name as EventName, target ? { target } : undefined);
      }
    },
    { threshold: 0.5 },
  );
  const scan = () => {
    for (const el of document.querySelectorAll('[data-seen-event]')) {
      if (watched.has(el)) continue;
      watched.add(el);
      seen.observe(el);
    }
  };
  scan();
  // Batched: a page's render adds many nodes at once.
  let queued = false;
  const added = new MutationObserver(() => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      scan();
    });
  });
  added.observe(document.body, { childList: true, subtree: true });
  return () => {
    added.disconnect();
    seen.disconnect();
  };
}
